// HAP-NodeJS accessory allowing Nest devices to be used with HomeKit
// This includes having support for HomeKit Secure Video (HKSV) on doorbells and cameras
//
// The following Nest devices are supported
// 
// Nest Thermostats (Gen 1, Gen 2, Gen 3, E)
// Nest Protects (Gen 1, Gen 2)
// Nest Temp Sensors
// Nest Cameras (Cam Indoor, IQ Indoor, Outdoor, IQ Outdoor)
// Nest Hello (Wired Gen 1)
//
// The accessory supports authentication to Nest/Google using either a Nest account OR Google (migrated Nest account) account.
// "preliminary" support for using FieldTest account types also.
//
// Code version 28/11/2023
// Mark Hulskamp

"use strict";

// Define HAP-NodeJS requirements
var HAP = require("hap-nodejs");

// Define external library requirements
var axios = require("axios");

// Define nodejs module requirements
var util = require("util");
var EventEmitter = require("events");
var dgram = require("dgram");
var net = require("net");
var ip = require("ip");
var fs = require("fs");
var child_process = require("child_process");

// Define our external module requirements
var HomeKitHistory = require("./HomeKitHistory");
var NexusStreamer = require("./nexusstreamer");
var HomeKitDevice = require("./HomeKitDevice");
HomeKitDevice.HOMEKITHISTORY = HomeKitHistory;                  // History module for the device
const ACCESSORYNAME = "Nest";                                   // Used for manufacturer name of HomeKit device
const ACCESSORYPINCODE = "031-45-154";                          // HomeKit pairing code

// Define constants
const LOWBATTERYLEVEL = 10;                                     // Low battery level percentage
const FFMPEGLIBARIES = ["libspeex", "libx264", "libfdk-aac"];   // List of ffmpeg libraries we require for doorbell/camera(s)
const FFMPEGVERSION = 6.0;                                      // Minimum version of ffmpeg we require


// Nest Thermostat
class NestThermostat extends HomeKitDevice {
    constructor(currentDeviceData, globalEventEmitter) {
        super(ACCESSORYNAME, ACCESSORYPINCODE, config.mDNS, currentDeviceData.device_uuid, currentDeviceData, globalEventEmitter);

        this.thermostatService = null;                  // HomeKit service for this thermostat
        this.batteryService = null;                     // Status of Nest Thermostat battery
        this.occupancyService = null;                   // Status of Away/Home
        this.humidityService = null;                    // Seperate humidity sensor
        this.fanService = null;                         // Fan service
        this.previous_target_temperature_type = null;   // Track previous target tempersture type
    }


    // Class functions
    addHomeKitServices(serviceName) {
        // Add this thermostat to the "master" accessory and set properties
        this.thermostatService = this.HomeKitAccessory.addService(HAP.Service.Thermostat, "Thermostat", 1);
        this.thermostatService.addCharacteristic(HAP.Characteristic.StatusActive);  // Used to indicate active temperature
        this.thermostatService.addCharacteristic(HAP.Characteristic.StatusFault);   // Used to indicate Nest online or not
        this.thermostatService.addCharacteristic(HAP.Characteristic.LockPhysicalControls);    // Setting can only be accessed via Eve App (or other 3rd party).
        this.deviceData.has_air_filter && this.thermostatService.addCharacteristic(HAP.Characteristic.FilterChangeIndication);   // Add characteristic if has air filter
        this.deviceData.has_humidifier && this.thermostatService.addCharacteristic(HAP.Characteristic.TargetRelativeHumidity);   // Add characteristic if has dehumidifier

        // Add battery service to display battery level
        this.batteryService = this.HomeKitAccessory.addService(HAP.Service.BatteryService, "", 1);

        // Seperate humidity sensor if configured todo so
        if (typeof this.deviceData.HumiditySensor == "boolean" && this.deviceData.HumiditySensor == true) {
            this.humidityService = this.HomeKitAccessory.addService(HAP.Service.HumiditySensor, "Humidity", 1);      // Humidity will be listed under seperate sensor
            this.humidityService.addCharacteristic(HAP.Characteristic.StatusFault);
        } else {
            this.thermostatService.addCharacteristic(HAP.Characteristic.CurrentRelativeHumidity); // Humidity will be listed under thermostat only
        }

        // Add home/away status as an occupancy sensor
        this.occupancyService = this.HomeKitAccessory.addService(HAP.Service.OccupancySensor, "Occupancy", 1);
        this.occupancyService.addCharacteristic(HAP.Characteristic.StatusFault);

        // Limit prop ranges
        if (this.deviceData.can_cool == false && this.deviceData.can_heat == true)
        {
            // Can heat only, so set values allowed for mode off/heat
            this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).setProps({validValues: [HAP.Characteristic.TargetHeatingCoolingState.OFF, HAP.Characteristic.TargetHeatingCoolingState.HEAT]});
        } else if (this.deviceData.can_cool == true && this.deviceData.can_heat == false) {
            // Can cool only
            this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).setProps({validValues: [HAP.Characteristic.TargetHeatingCoolingState.OFF, HAP.Characteristic.TargetHeatingCoolingState.COOL]});
        } else if (this.deviceData.can_cool == true && this.deviceData.can_heat == true) {
            // heat and cool 
            this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).setProps({validValues: [HAP.Characteristic.TargetHeatingCoolingState.OFF, HAP.Characteristic.TargetHeatingCoolingState.HEAT, HAP.Characteristic.TargetHeatingCoolingState.COOL, HAP.Characteristic.TargetHeatingCoolingState.AUTO]});
        } else {
            // only off mode
            this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).setProps({validValues: [HAP.Characteristic.TargetHeatingCoolingState.OFF]});
        }

        // Add fan service if Nest supports a fan
        if (this.deviceData.has_fan == true) {
            this.fanService = this.HomeKitAccessory.addService(HAP.Service.Fan, "Fan", 1);
            this.fanService.getCharacteristic(HAP.Characteristic.On).on("set", (value, callback) => {this.setFan(value, callback); });
            this.fanService.getCharacteristic(HAP.Characteristic.On).on("get", (callback) => {callback(null, this.deviceData.fan_state); });
        }

        // Set default ranges - based on celsuis ranges to which the nest thermostat operates
        this.thermostatService.getCharacteristic(HAP.Characteristic.CurrentTemperature).setProps({minStep: 0.5});
        this.thermostatService.getCharacteristic(HAP.Characteristic.TargetTemperature).setProps({minStep: 0.5, minValue: 9, maxValue: 32});
        this.thermostatService.getCharacteristic(HAP.Characteristic.CoolingThresholdTemperature).setProps({minStep: 0.5, minValue: 9, maxValue: 32});
        this.thermostatService.getCharacteristic(HAP.Characteristic.HeatingThresholdTemperature).setProps({minStep: 0.5, minValue: 9, maxValue: 32});

        // Setup callbacks for characteristics
        this.thermostatService.getCharacteristic(HAP.Characteristic.TemperatureDisplayUnits).on("set", (value, callback) => {this.setDisplayUnit(value, callback); });
        this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).on("set", (value, callback) => {this.setMode(value, callback); });
        this.thermostatService.getCharacteristic(HAP.Characteristic.TargetTemperature).on("set", (value, callback) => {this.setTemperature(HAP.Characteristic.TargetTemperature, value, callback)});
        this.thermostatService.getCharacteristic(HAP.Characteristic.CoolingThresholdTemperature).on("set", (value, callback) => {this.setTemperature(HAP.Characteristic.CoolingThresholdTemperature, value, callback)});
        this.thermostatService.getCharacteristic(HAP.Characteristic.HeatingThresholdTemperature).on("set", (value, callback) => {this.setTemperature(HAP.Characteristic.HeatingThresholdTemperature, value, callback)});
        this.thermostatService.getCharacteristic(HAP.Characteristic.LockPhysicalControls).on("set", (value, callback) => {this.setChildlock("", value, callback)});

        this.thermostatService.getCharacteristic(HAP.Characteristic.TemperatureDisplayUnits).on("get", (callback) => {callback(null, this.deviceData.temperature_scale == "C" ? HAP.Characteristic.TemperatureDisplayUnits.CELSIUS : HAP.Characteristic.TemperatureDisplayUnits.FAHRENHEIT); });
        this.thermostatService.getCharacteristic(HAP.Characteristic.TargetTemperature).on("get", (callback) => {callback(null, this.getTemperature(HAP.Characteristic.TargetTemperature, null)); });
        this.thermostatService.getCharacteristic(HAP.Characteristic.CoolingThresholdTemperature).on("get", (callback) => {callback(null, this.getTemperature(HAP.Characteristic.CoolingThresholdTemperature, null)); });
        this.thermostatService.getCharacteristic(HAP.Characteristic.HeatingThresholdTemperature).on("get", (callback) => {callback(null, this.getTemperature(HAP.Characteristic.HeatingThresholdTemperature, null)); });
        this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).on("get", (callback) => {callback(null, this.getMode(null)); });
        this.thermostatService.getCharacteristic(HAP.Characteristic.LockPhysicalControls).on("get", (callback) => {callback(null, this.deviceData.temperature_lock == true ? HAP.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : HAP.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED); });

        this.HomeKitAccessory.setPrimaryService(this.thermostatService);

        // Setup linkage to EveHome app if configured todo so
        if (this.deviceData.EveApp == true && this.HomeKitHistory != null) {
            this.HomeKitHistory.linkToEveHome(this.HomeKitAccessory, this.thermostatService, {GetCommand: this.#EveHomeGetCommand.bind(this),
                                                                                              SetCommand: this.#EveHomeSetCommand.bind(this),
                                                                                              debug: config.debug.includes(Debugging.HISTORY)
                                                                                              });
        }

        outputLogging(ACCESSORYNAME, false, "Setup Nest Thermostat '%s'", serviceName, (this.humidityService != null ? "with seperate humidity sensor" : ""));
        this.deviceData.ExternalCool && outputLogging(ACCESSORYNAME, false, "  += using external cooling module");
        this.deviceData.ExternalHeat && outputLogging(ACCESSORYNAME, false, "  += using external heating module");
        this.deviceData.ExternalFan && outputLogging(ACCESSORYNAME, false, "  += using external fan module");
        this.deviceData.ExternalDehumidifier && outputLogging(ACCESSORYNAME, false, "  += using external dehumidification module");
    }

    setFan(fanState, callback) {      
        config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Set fan on thermostat '%s' to '%s'", this.deviceData.mac_address, (fanState == true ? "On" : "Off"));
        this.set({["device"] : {"fan_timer_timeout" : (fanState == false ? 0 : this.deviceData.fan_duration + Math.floor(Date.now() / 1000))} });
        this.fanService.updateCharacteristic(HAP.Characteristic.On, fanState);
       
        if (typeof callback === "function") callback();  // do callback if defined
    }

    setDisplayUnit(temperatureUnit, callback) {
        config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Set temperature units on thermostat '%s' to '%s'", this.deviceData.mac_address, (temperatureUnit == HAP.Characteristic.TemperatureDisplayUnits.CELSIUS ? "°C" : "°F"));
        this.set({["device"] : {"temperature_scale" : (temperatureUnit == HAP.Characteristic.TemperatureDisplayUnits.CELSIUS ? "C" : "F") }});
        this.thermostatService.updateCharacteristic(HAP.Characteristic.TemperatureDisplayUnits, temperatureUnit);
        
        if (typeof callback === "function") callback();  // do callback if defined
    }

    setMode(thermostatMode, callback) {
        if (thermostatMode == this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).value) {
            if (typeof callback === "function") callback();  // do callback if defined
            return;
        }

        // Only change heating/cooling mode if change requested is different than current HomeKit state
        var tempMode = "";
        var tempValue = null;

        if (thermostatMode == HAP.Characteristic.TargetHeatingCoolingState.HEAT && this.deviceData.can_heat == true) {
            tempMode = "heat";
            tempValue = HAP.Characteristic.TargetHeatingCoolingState.HEAT;
        }
        if (thermostatMode == HAP.Characteristic.TargetHeatingCoolingState.COOL && this.deviceData.can_cool == true) {
            tempMode = "cool";
            tempValue = HAP.Characteristic.TargetHeatingCoolingState.COOL;
        }
        if (thermostatMode == HAP.Characteristic.TargetHeatingCoolingState.AUTO) {
            // Workaround for "Hey Siri, turn on my thermostat". Appears to automatically request mode as "auto", but we need to see what Nest device supports
            if (this.deviceData.can_cool == true && this.deviceData.can_heat == true) {
                tempMode = "range";
                tempValue = HAP.Characteristic.TargetHeatingCoolingState.AUTO;
            } else if (this.deviceData.can_cool == true && this.deviceData.can_heat == false) {
                tempMode = "cool";
                tempValue = HAP.Characteristic.TargetHeatingCoolingState.COOL;
            } else if (this.deviceData.can_cool == false && this.deviceData.can_heat == true) {
                tempMode = "heat";
                tempValue = HAP.Characteristic.TargetHeatingCoolingState.HEAT;
            } else {
                tempMode = "off"
                tempValue = HAP.Characteristic.TargetHeatingCoolingState.OFF;
            }
        }
        if (thermostatMode == HAP.Characteristic.TargetHeatingCoolingState.OFF) {
            tempMode = "off";
            tempValue = HAP.Characteristic.TargetHeatingCoolingState.OFF;
        }

        if (tempValue != null && tempMode != "") {
            config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Set thermostat on '%s' to '%s'", this.deviceData.mac_address, tempMode);
            this.set({["shared"] : {"target_temperature_type" : tempMode, "target_change_pending" : true} });
            this.thermostatService.updateCharacteristic(HAP.Characteristic.TargetHeatingCoolingState, tempValue);
            
            if (this.previous_target_temperature_type == "range" && (tempMode == "heat" || tempMode == "cool")) {
                // If switching from range to heat/cool, update HomeKit using previous target temp
                this.thermostatService.updateCharacteristic(HAP.Characteristic.TargetTemperature, this.deviceData.target_temperature);
            }
        }

        if (typeof callback === "function") callback();  // do callback if defined
    }

    getMode(callback) {
        var currentMode = undefined;

        if (this.deviceData.hvac_mode.toUpperCase() == "HEAT" || (this.deviceData.hvac_mode.toUpperCase() == "ECO" && this.deviceData.target_temperature_type.toUpperCase() == "HEAT")) {
            // heating mode, either eco or normal;
            currentMode = HAP.Characteristic.TargetHeatingCoolingState.HEAT;
        }
        if (this.deviceData.hvac_mode.toUpperCase() == "COOL" || (this.deviceData.hvac_mode.toUpperCase() == "ECO" && this.deviceData.target_temperature_type.toUpperCase() == "COOL")) {
            // cooling mode, either eco or normal
            currentMode = HAP.Characteristic.TargetHeatingCoolingState.COOL;
        }
        if (this.deviceData.hvac_mode.toUpperCase() == "RANGE" || (this.deviceData.hvac_mode.toUpperCase() == "ECO" && this.deviceData.target_temperature_type.toUpperCase() == "RANGE")) {
            // range mode, either eco or normal
            currentMode = HAP.Characteristic.TargetHeatingCoolingState.AUTO;
        }
        if (this.deviceData.hvac_mode.toUpperCase() == "OFF") {
            // off mode.
            currentMode = HAP.Characteristic.TargetHeatingCoolingState.OFF;
        }
        
        if (typeof callback === "function") callback(null, currentMode);  // do callback if defined
        return currentMode;
    }

    setTemperature(characteristic, temperature, callback) {
        if (typeof characteristic == "function" && characteristic.hasOwnProperty("UUID") == true) {
            if (characteristic.UUID == HAP.Characteristic.TargetTemperature.UUID && this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).value != HAP.Characteristic.TargetHeatingCoolingState.AUTO) {
                config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Set thermostat %s temperature on '%s' to '%s °C'", (this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).value == HAP.Characteristic.TargetHeatingCoolingState.HEAT ? "heating" : "cooling"), this.deviceData.mac_address, temperature);
                this.set({["shared"] : {"target_temperature": temperature, "target_change_pending" : true} });
            }
            if (characteristic.UUID == HAP.Characteristic.HeatingThresholdTemperature.UUID && this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).value == HAP.Characteristic.TargetHeatingCoolingState.AUTO) {
                config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Set maximum heating temperature on thermostat '%s' to '%s °C'", this.deviceData.mac_address, temperature);
                this.set({["shared"] : {"target_temperature_low": temperature, "target_change_pending" : true} });
            }
            if (characteristic.UUID == HAP.Characteristic.CoolingThresholdTemperature.UUID && this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).value == HAP.Characteristic.TargetHeatingCoolingState.AUTO) {
                config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Set minimum cooling temperature on thermostat '%s' to '%s °C'", this.deviceData.mac_address, temperature);
                this.set({["shared"] : {"target_temperature_high": temperature, "target_change_pending" : true} });
            }

            this.thermostatService.updateCharacteristic(characteristic, temperature);  // Update HomeKit with value
        }
        
        if (typeof callback === "function") callback();  // do callback if defined
    }

    getTemperature(characteristic, callback) {
        var currentTemperature = undefined;

        if (typeof characteristic == "function" && characteristic.hasOwnProperty("UUID") == true) {
            if (characteristic.UUID == HAP.Characteristic.TargetTemperature.UUID) {
                currentTemperature = this.deviceData.target_temperature;
            }
            if (characteristic.UUID == HAP.Characteristic.HeatingThresholdTemperature.UUID) {
                currentTemperature = this.deviceData.target_temperature_low;
            }
            if (characteristic.UUID == HAP.Characteristic.CoolingThresholdTemperature.UUID) {
                currentTemperature = this.deviceData.target_temperature_high;
            }
        }
        if (typeof callback === "function") callback(null, currentTemperature);  // do callback if defined
        return currentTemperature;
    }

    setChildlock(pin, value, callback) {
        // TODO - pincode setting when turning on. Writes to device.xxxxxxxx.temperature_lock_pin_hash. How is the hash calculated???
        // Do we set temperature range limits when child lock on??

        this.thermostatService.updateCharacteristic(HAP.Characteristic.LockPhysicalControls, value);  // Update HomeKit with value
        if (value == HAP.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED) {
            // Set pin hash????
        }
        if (value == HAP.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED) {
            // Clear pin hash????
        }
        config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Setting Childlock on '%s' to '%s'", this.deviceData.mac_address, (value == HAP.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? "Enabled" : "Disabled"));
        this.set({["device"] : {"temperature_lock" : (value == HAP.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? true : false) } });
        
        if (typeof callback === "function") callback();  // do callback if defined
    }

    updateHomeKitServices(updatedDeviceData) {
        if (typeof updatedDeviceData != "object" || this.thermostatService == null || this.batteryService == null || this.occupancyService == null) {
            return;
        }

        var historyEntry = {};

        this.thermostatService.updateCharacteristic(HAP.Characteristic.TemperatureDisplayUnits, updatedDeviceData.temperature_scale.toUpperCase() == "C" ? HAP.Characteristic.TemperatureDisplayUnits.CELSIUS : HAP.Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
        this.thermostatService.updateCharacteristic(HAP.Characteristic.CurrentTemperature, updatedDeviceData.active_temperature);
        this.thermostatService.updateCharacteristic(HAP.Characteristic.StatusFault, (updatedDeviceData.online == true && updatedDeviceData.removed_from_base == false) ? HAP.Characteristic.StatusFault.NO_FAULT : HAP.Characteristic.StatusFault.GENERAL_FAULT);  // If Nest isn't online or removed from base, report in HomeKit
        this.thermostatService.updateCharacteristic(HAP.Characteristic.LockPhysicalControls, updatedDeviceData.temperature_lock == true ? HAP.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : HAP.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
        this.thermostatService.updateCharacteristic(HAP.Characteristic.FilterChangeIndication, (updatedDeviceData.has_air_filter && updatedDeviceData.filter_replacement_needed == true ? HAP.Characteristic.FilterChangeIndication.CHANGE_FILTER : HAP.Characteristic.FilterChangeIndication.FILTER_OK));
        this.thermostatService.updateCharacteristic(HAP.Characteristic.StatusActive, (updatedDeviceData.active_rcs_sensor != "" ? false : true));  // Using a temperature sensor as active temperature?
    
        // Battery status if defined. Since Nest needs 3.6 volts to turn on, we'll use that as the lower limit. Havent seen battery level above 3.9ish, so assume 3.9 is upper limit
        var tempBatteryLevel = scaleValue(updatedDeviceData.battery_level, 3.6, 3.9, 0, 100);
        this.batteryService.updateCharacteristic(HAP.Characteristic.BatteryLevel, tempBatteryLevel);
        this.batteryService.updateCharacteristic(HAP.Characteristic.StatusLowBattery, tempBatteryLevel > LOWBATTERYLEVEL ? HAP.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : HAP.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
        this.batteryService.updateCharacteristic(HAP.Characteristic.ChargingState, (updatedDeviceData.battery_level > this.deviceData.battery_level && this.deviceData.battery_level != 0 ? true : false) ? HAP.Characteristic.ChargingState.CHARGING : HAP.Characteristic.ChargingState.NOT_CHARGING);

        // Update for away/home status. Away = no occupancy detected, Home = Occupancy Detected
        this.occupancyService.updateCharacteristic(HAP.Characteristic.OccupancyDetected, updatedDeviceData.away == true ? HAP.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED : HAP.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
        this.occupancyService.updateCharacteristic(HAP.Characteristic.StatusFault, (updatedDeviceData.online == true && updatedDeviceData.removed_from_base == false) ? HAP.Characteristic.StatusFault.NO_FAULT : HAP.Characteristic.StatusFault.GENERAL_FAULT);  // If Nest isn't online or removed from base, report in HomeKit

        // Update seperate humidity sensor if configured todo so
        if (this.humidityService != null) {
            this.humidityService.updateCharacteristic(HAP.Characteristic.CurrentRelativeHumidity, updatedDeviceData.current_humidity);  // Humidity will be listed under seperate sensor
            this.humidityService.updateCharacteristic(HAP.Characteristic.StatusFault, (updatedDeviceData.online == true && updatedDeviceData.removed_from_base == false) ? HAP.Characteristic.StatusFault.NO_FAULT : HAP.Characteristic.StatusFault.GENERAL_FAULT);  // If Nest isn't online or removed from base, report in HomeKit
        } else {
            this.thermostatService.updateCharacteristic(HAP.Characteristic.CurrentRelativeHumidity, updatedDeviceData.current_humidity);    // Humidity will be listed under thermostat only
        }

        // Check for fan setup change on thermostat
        if (updatedDeviceData.has_fan != this.deviceData.has_fan) {
            if (updatedDeviceData.has_fan == false && this.deviceData.has_fan == true && this.fanService == null) {
                // Fan has been added
                this.fanService = this.HomeKitAccessory.addService(HAP.Service.Fan, "Fan", 1);
                this.fanService.getCharacteristic(HAP.Characteristic.On).on("set", (value, callback) => {this.setFan(value, callback); });
                this.fanService.getCharacteristic(HAP.Characteristic.On).on("get", (callback) => {callback(null, this.deviceData.fan_state); });
            }
            if (updatedDeviceData.has_fan == true && this.deviceData.has_fan == false && this.fanService != null) {
                // Fan has been removed
                this.HomeKitAccessory.removeService(this.fanService);
                this.fanService = null;
            }
            config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Fan setup on thermostat '%s' has changed. Fan was", this.deviceData.mac_address, (this.fanService == null ? "removed" : "added"));
        }

        if ((updatedDeviceData.can_cool != this.deviceData.can_cool) || (updatedDeviceData.can_heat != this.deviceData.can_heat)) {
            // Heating and/cooling setup has changed on thermostat

            // Limit prop ranges
            if (updatedDeviceData.can_cool == false && updatedDeviceData.can_heat == true)
            {
                // Can heat only, so set values allowed for mode off/heat
                this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).setProps({validValues: [HAP.Characteristic.TargetHeatingCoolingState.OFF, HAP.Characteristic.TargetHeatingCoolingState.HEAT]});
            }
            if (updatedDeviceData.can_cool == true && updatedDeviceData.can_heat == false) {
                // Can cool only
                this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).setProps({validValues: [HAP.Characteristic.TargetHeatingCoolingState.OFF, HAP.Characteristic.TargetHeatingCoolingState.COOL]});
            }
            if (updatedDeviceData.can_cool == true && updatedDeviceData.can_heat == true) {
                // heat and cool 
                this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).setProps({validValues: [HAP.Characteristic.TargetHeatingCoolingState.OFF, HAP.Characteristic.TargetHeatingCoolingState.HEAT, HAP.Characteristic.TargetHeatingCoolingState.COOL, HAP.Characteristic.TargetHeatingCoolingState.AUTO]});
            }
            if (updatedDeviceData.can_cool == false && updatedDeviceData.can_heat == false) {
                // only off mode
                this.thermostatService.getCharacteristic(HAP.Characteristic.TargetHeatingCoolingState).setProps({validValues: [HAP.Characteristic.TargetHeatingCoolingState.OFF]});
            }
            config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Heating/cooling setup on thermostat on '%s' has changed", this.deviceData.mac_address);
        } 

        // Update current mode temperatures
        if (updatedDeviceData.target_temperature_type != this.deviceData.target_temperature_type) {
            // track target temperature type changes
            this.previous_target_temperature_type = this.deviceData.target_temperature_type;
        }
        if (updatedDeviceData.hvac_mode.toUpperCase() == "HEAT" || (updatedDeviceData.hvac_mode.toUpperCase() == "ECO" && updatedDeviceData.target_temperature_type.toUpperCase() == "HEAT")) {
            // heating mode, either eco or normal
            this.thermostatService.updateCharacteristic(HAP.Characteristic.HeatingThresholdTemperature, updatedDeviceData.target_temperature_low);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.CoolingThresholdTemperature, updatedDeviceData.target_temperature_high);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.TargetTemperature, updatedDeviceData.target_temperature);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.TargetHeatingCoolingState, HAP.Characteristic.TargetHeatingCoolingState.HEAT);
            historyEntry.target = {low: 0, high: updatedDeviceData.target_temperature};    // single target temperature for heating limit
        }
        if (updatedDeviceData.hvac_mode.toUpperCase() == "COOL" || (updatedDeviceData.hvac_mode.toUpperCase() == "ECO" && updatedDeviceData.target_temperature_type.toUpperCase() == "COOL")) {
            // cooling mode, either eco or normal
            this.thermostatService.updateCharacteristic(HAP.Characteristic.HeatingThresholdTemperature, updatedDeviceData.target_temperature_low);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.CoolingThresholdTemperature, updatedDeviceData.target_temperature_high);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.TargetTemperature, updatedDeviceData.target_temperature);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.TargetHeatingCoolingState, HAP.Characteristic.TargetHeatingCoolingState.COOL);
            historyEntry.target = {low: updatedDeviceData.target_temperature, high: 0};    // single target temperature for cooling limit
        }
        if (updatedDeviceData.hvac_mode.toUpperCase() == "RANGE" || (updatedDeviceData.hvac_mode.toUpperCase() == "ECO" && updatedDeviceData.target_temperature_type.toUpperCase() == "RANGE")) {
            // range mode, either eco or normal
            this.thermostatService.updateCharacteristic(HAP.Characteristic.HeatingThresholdTemperature, updatedDeviceData.target_temperature_low);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.CoolingThresholdTemperature, updatedDeviceData.target_temperature_high);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.TargetHeatingCoolingState, HAP.Characteristic.TargetHeatingCoolingState.AUTO);
            historyEntry.target = {low: updatedDeviceData.target_temperature_low, high: updatedDeviceData.target_temperature_high};    // target temperature range
        }
        if (updatedDeviceData.hvac_mode.toUpperCase() == "OFF") {
            // off mode.
            this.thermostatService.updateCharacteristic(HAP.Characteristic.HeatingThresholdTemperature, updatedDeviceData.target_temperature_low);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.CoolingThresholdTemperature, updatedDeviceData.target_temperature_high);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.TargetTemperature, updatedDeviceData.target_temperature);
            this.thermostatService.updateCharacteristic(HAP.Characteristic.TargetHeatingCoolingState, HAP.Characteristic.TargetHeatingCoolingState.OFF);
            historyEntry.target = {low: 0, high: 0};    // thermostat off, so no target temperatures
        }
    
        // Update current state
        if (updatedDeviceData.hvac_state.toUpperCase() == "HEATING") {
            if (this.deviceData.hvac_state.toUpperCase() == "COOLING" && typeof updatedDeviceData.ExternalCool == "object") {
                // Switched to heating mode and external cooling external code was being used, so stop cooling via cooling external code
                if (typeof updatedDeviceData.ExternalCool.off == "function") updatedDeviceData.ExternalCool.off(config.debug.includes(Debugging.EXTERNAL));
            }
            if ((this.deviceData.hvac_state.toUpperCase() != "HEATING" || updatedDeviceData.target_temperature != this.deviceData.target_temperature) && typeof updatedDeviceData.ExternalHeat == "object") {
                // Switched to heating mode and external heating external code is being used
                // Start heating via heating external code OR adjust heating target temperature due to change
                if (typeof updatedDeviceData.ExternalHeat.heat == "function") updatedDeviceData.ExternalHeat.heat(updatedDeviceData.target_temperature, config.debug.includes(Debugging.EXTERNAL));
            }
            this.thermostatService.updateCharacteristic(HAP.Characteristic.CurrentHeatingCoolingState, HAP.Characteristic.CurrentHeatingCoolingState.HEAT);
            historyEntry.status = 2;    // heating
        }
        if (updatedDeviceData.hvac_state.toUpperCase() == "COOLING") {
            if (this.deviceData.hvac_state.toUpperCase() == "HEATING" && typeof updatedDeviceData.ExternalHeat == "object") {
                // Switched to cooling mode and external heating external code was being used, so stop heating via heating external code
                if (typeof updatedDeviceData.ExternalHeat.off == "function") updatedDeviceData.ExternalHeat.off(config.debug.includes(Debugging.EXTERNAL));
            }
            if ((this.deviceData.hvac_state.toUpperCase() != "COOLING" || updatedDeviceData.target_temperature != this.deviceData.target_temperature) && typeof updatedDeviceData.ExternalCool == "object") {
                // Switched to cooling mode and external cooling external code is being used
                // Start cooling via cooling external code OR adjust cooling target temperature due to change
                if (typeof updatedDeviceData.ExternalCool.cool == "function") updatedDeviceData.ExternalCool.cool(updatedDeviceData.target_temperature, config.debug.includes(Debugging.EXTERNAL));
            }
            this.thermostatService.updateCharacteristic(HAP.Characteristic.CurrentHeatingCoolingState, HAP.Characteristic.CurrentHeatingCoolingState.COOL);
            historyEntry.status = 3;    // cooling
        }
        if (updatedDeviceData.hvac_state.toUpperCase() == "OFF") {
            if (this.deviceData.hvac_state.toUpperCase() == "COOLING" && typeof updatedDeviceData.ExternalCool == "object") {
                // Switched to off mode and external cooling external code was being used, so stop cooling via cooling external code
                if (typeof updatedDeviceData.ExternalCool.off == "function") updatedDeviceData.ExternalCool.off(config.debug.includes(Debugging.EXTERNAL));
            }
            if (this.deviceData.hvac_state.toUpperCase() == "HEATING" && typeof updatedDeviceData.ExternalHeat == "object") {
                // Switched to off mode and external heating external code was being used, so stop heating via heating external code
                if (typeof updatedDeviceData.ExternalHeat.heat == "function") updatedDeviceData.ExternalHeat.off(config.debug.includes(Debugging.EXTERNAL));
            }
            this.thermostatService.updateCharacteristic(HAP.Characteristic.CurrentHeatingCoolingState, HAP.Characteristic.CurrentHeatingCoolingState.OFF);
            historyEntry.status = 0;    // off
        }
        if (this.fanService != null) {
            if (this.deviceData.fan_state == false && updatedDeviceData.fan_state == true && typeof updatedDeviceData.ExternalFan == "object") {
                // Fan mode was switched on and external fan external code is being used, so start fan via fan external code
                if (typeof updatedDeviceData.ExternalFan.fan == "function") updatedDeviceData.ExternalFan.fan(0, config.debug.includes(Debugging.EXTERNAL));    // Fan speed will be auto
            }
            if (this.deviceData.fan_state == true && updatedDeviceData.fan_state == false && typeof updatedDeviceData.ExternalFan == "object") {
                // Fan mode was switched off and external fan external code was being used, so stop fan via fan external code
                if (typeof updatedDeviceData.ExternalFan.off == "function") updatedDeviceData.ExternalFan.off(config.debug.includes(Debugging.EXTERNAL));
            }
            this.fanService.updateCharacteristic(HAP.Characteristic.On, updatedDeviceData.fan_state);   // fan status on or off
            //historyEntry.status = 1;    // fan <-- TODO in history
        }

        // Log thermostat metrics to history only if changed to previous recording
        if (this.HomeKitHistory != null) {
            var tempEntry = this.HomeKitHistory.lastHistory(this.thermostatService);
            if (tempEntry == null || (typeof tempEntry == "object" && tempEntry.status != historyEntry.status || tempEntry.temperature != updatedDeviceData.active_temperature || JSON.stringify(tempEntry.target) !== JSON.stringify(historyEntry.target) || tempEntry.humidity != updatedDeviceData.current_humidity)) {
                this.HomeKitHistory.addHistory(this.thermostatService, {time: Math.floor(Date.now() / 1000), status: historyEntry.status, temperature: updatedDeviceData.active_temperature, target: historyEntry.target, humidity: updatedDeviceData.current_humidity});
            }
        }

        // Notify Eve App of device status changes if linked
        if (this.HomeKitHistory != null && this.deviceData.EveApp == true) {
            // Update our internal data with properties Eve will need to process
            this.deviceData.online == updatedDeviceData.online;
            this.deviceData.removed_from_base == updatedDeviceData.removed_from_base;
            this.deviceData.vacation_mode = updatedDeviceData.vacation_mode;
            this.deviceData.hvac_mode = updatedDeviceData.hvac_mode;
            this.deviceData.target_temperature_type = updatedDeviceData.target_temperature_type;
            this.deviceData.schedules = updatedDeviceData.schedules;
            this.deviceData.schedule_mode = updatedDeviceData.schedule_mode;
            this.HomeKitHistory.updateEveHome(this.thermostatService, this.#EveHomeGetCommand.bind(this));
        }
    }

    #EveHomeGetCommand(EveHomeGetData) {
        // Pass back extra data for Eve Thermo "get" process command
        // Data will already be an object, our only job is to add/modify to it
        //EveHomeGetData.enableschedule = optionalParams.hasOwnProperty("EveThermo_enableschedule") ? optionalParams.EveThermo_enableschedule : false; // Schedules on/off
        EveHomeGetData.attached = (this.deviceData.online == true && this.deviceData.removed_from_base == false);
        EveHomeGetData.vacation = this.deviceData.vacation_mode; //   Vaction mode on/off
        EveHomeGetData.vacationtemp = (this.deviceData.vacation_mode == true ? EveHomeGetData.vacationtemp : null);
        EveHomeGetData.programs = [];   // No programs yet, we'll process this below
        if (this.deviceData.schedule_mode.toUpperCase() == "HEAT" || this.deviceData.schedule_mode.toUpperCase() == "RANGE") {
            const DAYSOFWEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

            Object.entries(this.deviceData.schedules).forEach(([day, schedules]) => {
                var tempSchedule = [];
                var tempTemperatures = [];
                Object.entries(schedules).reverse().forEach(([id, schedule]) => {
                    if (schedule.entry_type == "setpoint" && (schedule.type == "HEAT" || schedule.type == "RANGE")) {
                        tempSchedule.push({"start" : schedule.time, "duration" : 0, "offset" : schedule.touched_tzo, "temperature" : schedule.hasOwnProperty("temp-min") == true ? schedule["temp-min"] : schedule.temp});
                        tempTemperatures.push(schedule.hasOwnProperty("temp-min") == true ? schedule["temp-min"] : schedule.temp);
                    }
                });

                // Sort the schedule array by start time
                tempSchedule = tempSchedule.sort((a, b) => {
                    if (a.start < b.start) {
                      return -1;
                    }
                });

                var ecoTemp = tempTemperatures.length == 0 ? 0 : Math.min(...tempTemperatures);
                var comfortTemp = tempTemperatures.length == 0 ? 0 : Math.max(...tempTemperatures);
                var program = [];
                program.days = DAYSOFWEEK[day];
                program.schedule = [];
                var lastTime = 86400;   // seconds in a day
                Object.entries(tempSchedule).reverse().forEach(([id, schedule]) => {
                    if (schedule.temperature == comfortTemp) {
                        // We only want to add the schedule time if its using the "max" temperature
                        program.schedule.push({"start" : schedule.start, "duration" : (lastTime - schedule.start), "ecotemp" : ecoTemp, "comforttemp" : comfortTemp});
                    }
                    lastTime = schedule.start;
                });
                EveHomeGetData.programs.push(program);
            });
        }

        return EveHomeGetData;
    }

    #EveHomeSetCommand(EveHomeSetData) {
        if (typeof EveHomeSetData != "object") {
            return;
        }

        if (EveHomeSetData.hasOwnProperty("vacation") == true) {
            this.deviceData.vacation_mode = EveHomeSetData.vacation.status;
            this.set({["structure"] : {"vacation_mode" : this.deviceData.vacation_mode } });
        }
        if (EveHomeSetData.hasOwnProperty("programs") == true) {
            EveHomeSetData.programs.forEach((day) => {
                // Convert into Nest thermostat schedule format and set. Need to work this out
                //this.set({["schedule"] : {"days" : {6 : { "temp" : 17 , "time" : 13400, touched_at: Date.now()}} }});
            }); 
        }

    }
}


// Nest Temperature Sensors
class NestTemperatureSensor extends HomeKitDevice {
    constructor(currentDeviceData, globalEventEmitter) {
        super(ACCESSORYNAME, ACCESSORYPINCODE, config.mDNS, currentDeviceData.device_uuid, currentDeviceData, globalEventEmitter);

        this.temperatureService = null;                 // HomeKit service for this temperature sensor
        this.batteryService = null;                     // HomeKit service for battery status
    }


    // Class functions
    addHomeKitServices(serviceName) {
        // Add this temperature sensor to the "master" accessory and set properties   
        this.temperatureService = this.HomeKitAccessory.addService(HAP.Service.TemperatureSensor, "Temperature", 1);
        this.temperatureService.addCharacteristic(HAP.Characteristic.StatusActive);
        this.temperatureService.addCharacteristic(HAP.Characteristic.StatusFault);

        // Add battery service to display battery level    
        this.batteryService = this.HomeKitAccessory.addService(HAP.Service.BatteryService, "", 1);
        this.batteryService.updateCharacteristic(HAP.Characteristic.ChargingState, HAP.Characteristic.ChargingState.NOT_CHARGEABLE); //  Battery isnt charageable

        // Setup linkage to EveHome app if configured todo so
        if (this.deviceData.EveApp == true && this.HomeKitHistory != null) {
            this.HomeKitHistory.linkToEveHome(this.HomeKitAccessory, this.temperatureService, {debug: config.debug.includes(Debugging.HISTORY)});
        }

        outputLogging(ACCESSORYNAME, false, "Setup Nest Temperature Sensor '%s'", serviceName);
    }

    updateHomeKitServices(updatedDeviceData) {
        if (typeof updatedDeviceData != "object" || this.temperatureService == null || this.batteryService == null) {
            return;
        }

        this.temperatureService.updateCharacteristic(HAP.Characteristic.StatusFault, (updatedDeviceData.online == true ? HAP.Characteristic.StatusFault.NO_FAULT : HAP.Characteristic.StatusFault.GENERAL_FAULT));  // If Nest isn't online, report in HomeKit
    
        // Is this sensor providing the active temperature for a thermostat
        this.temperatureService.updateCharacteristic(HAP.Characteristic.StatusActive, updatedDeviceData.active_sensor);

        // Update temperature
        this.temperatureService.updateCharacteristic(HAP.Characteristic.CurrentTemperature, updatedDeviceData.current_temperature);

        // Update battery level and status
        var tempBatteryLevel = scaleValue(updatedDeviceData.battery_level, 0, 100, 0, 100);
        this.batteryService.updateCharacteristic(HAP.Characteristic.BatteryLevel, tempBatteryLevel);
        this.batteryService.updateCharacteristic(HAP.Characteristic.StatusLowBattery, tempBatteryLevel > LOWBATTERYLEVEL ? HAP.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : HAP.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);

        // Log temperature to history only if changed to previous recording
        if (this.HomeKitHistory != null && updatedDeviceData.current_temperature != this.deviceData.current_temperature) {
            this.HomeKitHistory.addHistory(this.temperatureService, {time: Math.floor(Date.now() / 1000), temperature: updatedDeviceData.current_temperature});
        }
    }
}


// Nest Protect
class NestProtect extends HomeKitDevice {
    constructor(currentDeviceData, globalEventEmitter) {
        super(ACCESSORYNAME, ACCESSORYPINCODE, config.mDNS, currentDeviceData.device_uuid, currentDeviceData, globalEventEmitter);
 
        this.smokeService = null;                       // HomeKit service for this smoke sensor
        this.carbonMonoxideService = null;              // HomeKit service for this carbon monoxide sensor
        this.batteryService = null;                     // Status of Nest Protect Sensor Battery
        this.motionService = null;                      // Status of Nest Protect motion sensor
    }


    // Class functions
    addHomeKitServices(serviceName) {
        // Add this smoke sensor & CO sensor to the "master" accessory and set properties   
        this.smokeService = this.HomeKitAccessory.addService(HAP.Service.SmokeSensor, "Smoke", 1);
        this.smokeService.addCharacteristic(HAP.Characteristic.StatusActive);
        this.smokeService.addCharacteristic(HAP.Characteristic.StatusFault);

        this.carbonMonoxideService = this.HomeKitAccessory.addService(HAP.Service.CarbonMonoxideSensor, "Carbon Monoxide", 1);
        this.carbonMonoxideService.addCharacteristic(HAP.Characteristic.StatusActive);
        this.carbonMonoxideService.addCharacteristic(HAP.Characteristic.StatusFault);

        // Add battery service to display battery level
        this.batteryService = this.HomeKitAccessory.addService(HAP.Service.BatteryService, "", 1);
        this.batteryService.updateCharacteristic(HAP.Characteristic.ChargingState, HAP.Characteristic.ChargingState.NOT_CHARGEABLE); // Batteries are non-rechargeable

        // Add motion sensor if supported (only on wired versions)
        if (this.deviceData.wired_or_battery == 0) {
            this.motionService = this.HomeKitAccessory.addService(HAP.Service.MotionSensor, "Motion", 1);
            this.motionService.addCharacteristic(HAP.Characteristic.StatusActive);
            this.motionService.addCharacteristic(HAP.Characteristic.StatusFault);
        }

        this.HomeKitAccessory.setPrimaryService(this.smokeService);

        // Setup linkage to EveHome app if configured todo so
        if (this.deviceData.EveApp == true && this.HomeKitHistory != null) {
            this.HomeKitHistory.linkToEveHome(this.HomeKitAccessory, this.smokeService, {GetCommand: this.#EveHomeGetCommand.bind(this),
                                                                                        SetCommand: this.#EveHomeSetCommand.bind(this),
                                                                                        EveSmoke_lastalarmtest: this.deviceData.latest_alarm_test,
                                                                                        EveSmoke_alarmtest: this.deviceData.self_test_in_progress,
                                                                                        EveSmoke_heatstatus: this.deviceData.heat_status,
                                                                                        EveSmoke_hushedstate: this.deviceData.hushed_state,
                                                                                        EveSmoke_statusled: this.deviceData.ntp_green_led,
                                                                                        EveSmoke_smoketestpassed: this.deviceData.smoke_test_passed,
                                                                                        EveSmoke_heattestpassed: this.deviceData.heat_test_passed,
                                                                                        debug: config.debug.includes(Debugging.HISTORY)
                                                                                        });
        }

        outputLogging(ACCESSORYNAME, false, "Setup Nest Protect '%s'", serviceName, (this.motionService != null ? "with motion sensor" : ""));
    }

    updateHomeKitServices(updatedDeviceData) {
        if (typeof updatedDeviceData != "object" || this.smokeService == null || this.carbonMonoxideService == null || this.batteryService == null) {
            return;
        }

        this.smokeService.updateCharacteristic(HAP.Characteristic.StatusActive, (updatedDeviceData.online == true && updatedDeviceData.removed_from_base == false ? true : false));  // If Nest isn't online or removed from base, report in HomeKit
        this.smokeService.updateCharacteristic(HAP.Characteristic.StatusFault, ((updatedDeviceData.online == true && updatedDeviceData.removed_from_base == false) && (Math.floor(Date.now() / 1000) <= updatedDeviceData.replacement_date) ? HAP.Characteristic.StatusFault.NO_FAULT : HAP.Characteristic.StatusFault.GENERAL_FAULT));  // General fault if replacement date past or Nest isn't online or removed from base
        this.carbonMonoxideService.updateCharacteristic(HAP.Characteristic.StatusActive, (updatedDeviceData.online == true && updatedDeviceData.removed_from_base == false ? true : false));  // If Nest isn't online or removed from base, report in HomeKit
        this.carbonMonoxideService.updateCharacteristic(HAP.Characteristic.StatusFault, ((updatedDeviceData.online == true && updatedDeviceData.removed_from_base == false) && (Math.floor(Date.now() / 1000) <= updatedDeviceData.replacement_date) ? HAP.Characteristic.StatusFault.NO_FAULT : HAP.Characteristic.StatusFault.GENERAL_FAULT));  // General fault if replacement date past or Nest isn't online or removed from base
    
        if (this.motionService != null) {
            // Motion detect if auto_away = false. Not supported on battery powered Nest Protects
            this.motionService.updateCharacteristic(HAP.Characteristic.StatusActive, (updatedDeviceData.online == true && updatedDeviceData.removed_from_base == false ? true : false));  // If Nest isn't online or removed from base, report in HomeKit
            this.motionService.updateCharacteristic(HAP.Characteristic.StatusFault, ((updatedDeviceData.online == true && updatedDeviceData.removed_from_base == false) && (Math.floor(Date.now() / 1000) <= updatedDeviceData.replacement_date) ? HAP.Characteristic.StatusFault.NO_FAULT : HAP.Characteristic.StatusFault.GENERAL_FAULT));  // General fault if replacement date past or Nest isn't online or removed from base
            this.motionService.updateCharacteristic(HAP.Characteristic.MotionDetected, updatedDeviceData.away == false ? true : false);

            // Log motion to history only if changed to previous recording
            if (this.HomeKitHistory != null && updatedDeviceData.away != this.deviceData.away) {
                this.HomeKitHistory.addHistory(this.motionService, {time: Math.floor(Date.now() / 1000), status: updatedDeviceData.away == false ? 1 : 0}); 
            }
        }

        // Update battery level and status
        var tempBatteryLevel = scaleValue(updatedDeviceData.battery_level, 0, 5400, 0, 100);
        this.batteryService.updateCharacteristic(HAP.Characteristic.BatteryLevel, tempBatteryLevel);
        this.batteryService.updateCharacteristic(HAP.Characteristic.StatusLowBattery, (tempBatteryLevel > LOWBATTERYLEVEL && updatedDeviceData.battery_health_state == 0 && ((updatedDeviceData.line_power_present == true && updatedDeviceData.wired_or_battery == 0) || (updatedDeviceData.line_power_present == false && updatedDeviceData.wired_or_battery == 1))) ? HAP.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : HAP.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);

        // Update smoke and carbonmonoxide detected status 'ok': 0, 'warning': 1, 'emergency': 2
        this.smokeService.updateCharacteristic(HAP.Characteristic.SmokeDetected, updatedDeviceData.smoke_status == 2 ? HAP.Characteristic.SmokeDetected.SMOKE_DETECTED : HAP.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
        this.carbonMonoxideService.updateCharacteristic(HAP.Characteristic.CarbonMonoxideDetected, updatedDeviceData.co_status == 2 ? HAP.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL : HAP.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL);

        // Notify Eve App of device status changes if linked
        if (this.deviceData.EveApp == true && this.HomeKitHistory != null) {
            // Update our internal data with properties Eve will need to process
            this.deviceData.latest_alarm_test = updatedDeviceData.latest_alarm_test;
            this.deviceData.self_test_in_progress = updatedDeviceData.self_test_in_progress;
            this.deviceData.heat_status = updatedDeviceData.heat_status;
            this.deviceData.ntp_green_led = updatedDeviceData.ntp_green_led;
            this.deviceData.smoke_test_passed = updatedDeviceData.smoke_test_passed;
            this.deviceData.heat_test_passed = updatedDeviceData.heat_test_passed;
            this.HomeKitHistory.updateEveHome(this.smokeService, this.#EveHomeGetCommand.bind(this));
        }
    }

    #EveHomeGetCommand(EveHomeGetData) {
        // Pass back extra data for Eve Smoke "get" process command
        // Data will already be an object, our only job is to add/modify to it
        EveHomeGetData.lastalarmtest = this.deviceData.latest_alarm_test;
        EveHomeGetData.alarmtest = this.deviceData.self_test_in_progress;
        EveHomeGetData.heatstatus = this.deviceData.heat_status;
        EveHomeGetData.statusled = this.deviceData.ntp_green_led;
        EveHomeGetData.smoketestpassed = this.deviceData.smoke_test_passed;
        EveHomeGetData.heattestpassed = this.deviceData.heat_test_passed;
        EveHomeGetData.hushedstate = this.deviceData.hushed_state;
        return EveHomeGetData;
    }

   #EveHomeSetCommand(EveHomeSetData) {
        if (typeof EveHomeSetData != "object") {
            return;
        }

        if (EveHomeSetData.hasOwnProperty("alarmtest")) {
            //outputLogging(ACCESSORYNAME, false, "Eve Smoke Alarm test", (EveHomeSetData.alarmtest == true ? "start" : "stop"));
        }
        if (EveHomeSetData.hasOwnProperty("statusled")) {
            this.deviceData.ntp_green_led = EveHomeSetData.statusled;    // Do quick status update as setting Nest values does take sometime
            this.set({["topaz"] : {"ntp_green_led_enable" : EveHomeSetData.statusled} });
        }
    }
}


// Nest Hello/Cam(s)

// Available video codecs we can use
const VideoCodecs = {
    COPY : "copy",
    H264_OMX : "h264_omx",
    LIBX264 : "libx264",
    H264_V4L2M2M : "h264_v4l2m2m",  // Not coded yet
    H264_QSV : " h264_qsv"          // Not coded yet
};

// Audio codecs we use
const AudioCodecs = {
    COPY : "copy",
    LIBFDK_AAC : "libfdk_aac",
    LIBSPEEX : "libspeex"
};

const CAMERAOFFLINEJPGFILE = "Nest_camera_offline.jpg";         // Camera offline jpg image file
const CAMERAOFFJPGFILE = "Nest_camera_off.jpg";                 // Camera off jpg image file
const CAMERACONNECTINGJPGFILE = "Nest_camera_connecting.jpg";   // Camera connecting jpg image file
const CAMERAOFFLINEH264FILE = "Nest_camera_offline.h264";       // Camera offline H264 frame file
const CAMERAOFFH264FILE = "Nest_camera_off.h264";               // Camera off H264 frame file
const CAMERACONNECTING264FILE = "Nest_camera_connecting.h264";  // Camera connecting H264 frame file
const MP4BOX = "mp4box";                                        // MP4 box fragement event for HKSV recording
const EXPECTEDVIDEORATE = 30;                                   // FPS we should expect doorbells/cameras to output at

class NestCameraDoorbell extends HomeKitDevice {
    constructor(currentDeviceData, globalEventEmitter) {
        super(ACCESSORYNAME, ACCESSORYPINCODE, config.mDNS, currentDeviceData.device_uuid, currentDeviceData, globalEventEmitter);

        this.controller = null;                         // HomeKit Camera/Doorbell controller service
        this.motionServices = [];                       // Status of Nest Hello/Cam(s) motion sensor(s)
        this.snapshotEvent = {
            type: "",
            time: 0, 
            id: 0, 
            "done": false
        };
        this.pendingSessions = [];                      
        this.ongoingSessions = [];
        this.cachedSnapshot = null;                     // Cached camera snapshot from stream
        this.doorbellTimer = null;                      // Cooldown timer for doorbell events
        this.personTimer = null;                        // Cooldown timer for person/face events
        this.motionTimer = null;                        // Cooldown timer for motion events
        this.audioTalkback = false;                     // Do we support audio talkback 
        this.NexusStreamer = null;                      // Object for the Nexus Streamer. Created when adding doorbell/camera
        this.chimeService = null;                       // HomeKit "switch" service for enabling/disabling indoor chime

        // HKSV stuff
        this.HKSVRecordingConfiguration = {};           // HomeKit Secure Video recording configuration
        this.HKSVRecorder = {
            record: false,                              // Tracks updateRecordingActive. default is not recording, but HomeKit will select the current state
            ffmpeg: null,                               // ffmpeg process for recording
            video: null,                                // video input stream
            audio: null,                                // audio input stream
            id: null,                                   // HKSV Recording ID
            time: 0                                     // Time to record from in buffer, 0 means from start of buffer
        };

        this.set({["quartz"] : {"watermark.enabled" : false}});     // "Try" to turn off Nest watermark in video stream
    }


    // Class functions
    addHomeKitServices(serviceName) {
        if (this.deviceData.capabilities.includes("detectors.on_camera") == true) {
            // We have a capability of motion sensing on camera/doorbell
            // Zone id of 0 is the main sensor zone on camera/doorbell
            var tempService = this.HomeKitAccessory.addService(HAP.Service.MotionSensor, "Motion", 0);
            tempService.updateCharacteristic(HAP.Characteristic.MotionDetected, false);     // No motion in creation
            this.motionServices.push({"service": tempService, "id": 0});

            if (this.deviceData.HKSV == false && typeof this.deviceData.activity_zones == "object") {
                // Setup any additional Motion service(s) for camera/doorbell activity zones as required if HKSV disabled
                this.deviceData.activity_zones.filter(zone => {return zone.id != 0}).forEach((zone) => {
                    var tempService = this.HomeKitAccessory.addService(HAP.Service.MotionSensor, zone.name, zone.id);
                    tempService.updateCharacteristic(HAP.Characteristic.MotionDetected, false); // No motion in creation
                    this.motionServices.push({"service": tempService, "id": zone.id});
                });
            }
        }

        var options = {
            cameraStreamCount: 2, // HomeKit requires at least 2 streams, but 1 is also just fine
            delegate: this, // Our class is the delgate for handling streaming/images
            streamingOptions: {
                supportedCryptoSuites: [HAP.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
                video: {
                    resolutions: [
                        // width, height, framerate
                        [3840, 2160, 30],   // 4K
                        [1920, 1080, 30],   // 1080p
                        [1600, 1200, 30],   // Native res of Nest Hello
                        [1280, 960, 30],
                        [1280, 720, 30],    // 720p
                        [1024, 768, 30],
                        [640, 480, 30],
                        [640, 360, 30],
                        [480, 360, 30],
                        [480, 270, 30],
                        [320, 240, 30],
                        [320, 240, 15],     // Apple Watch requires this configuration (Apple Watch also seems to required OPUS @16K)
                        [320, 180, 30],
                        [320, 180, 15],
                    ],
                    codec: {
                        profiles : [HAP.H264Profile.MAIN], // Use HAP.H264Profile.MAIN only as that appears what the Nest video stream is at??
                        levels: [HAP.H264Level.LEVEL3_1, HAP.H264Level.LEVEL3_2, HAP.H264Level.LEVEL4_0],
                    },
                },
                audio : {
                    twoWayAudio: (this.deviceData.capabilities.includes("audio.speaker") == true && this.deviceData.capabilities.includes("audio.microphone") == true) ? true : false,    // If both speaker & microphone capabilities, then we support twoway audio
                    codecs: [
                        {
                            type: HAP.AudioStreamingCodecType.AAC_ELD,
                            samplerate: HAP.AudioStreamingSamplerate.KHZ_16
                        },
                    ], 
                },
            }
        };

        if (this.deviceData.HKSV == true) {
            // Setup HomeKit secure video options
            options.recording = {
                delegate: this, // Our class will also handle stream recording
                options: {
                    mediaContainerConfiguration: [
                        {
                            fragmentLength: 4000,
                            type: HAP.MediaContainerType.FRAGMENTED_MP4
                        }
                    ],
                    prebufferLength: 4000,  // Seems to always be 4000???
                    video: {
                        resolutions: [
                            // width, height, framerate
                            [3840, 2160, 30],   // 4K
                            [1920, 1080, 30],   // 1080p
                            [1600, 1200, 30],   // Native res of Nest Hello
                            [1280, 960, 30],
                            [1280, 720, 30],    // 720p
                            [1024, 768, 30],
                            [640, 480, 30],
                            [640, 360, 30],
                            [480, 360, 30],
                            [480, 270, 30],
                            [320, 240, 30],
                            [320, 240, 15],     // Apple Watch requires this configuration (Apple Watch also seems to required OPUS @16K)
                            [320, 180, 30],
                            [320, 180, 15],
                        ],
                        parameters: {
                            profiles : [HAP.H264Profile.MAIN],  // Use HAP.H264Profile.MAIN only as that appears what the Nest video stream is at??
                            levels: [HAP.H264Level.LEVEL3_1, HAP.H264Level.LEVEL3_2, HAP.H264Level.LEVEL4_0],
                        },
                        type: HAP.VideoCodecType.H264
                    },
                    audio : {
                        codecs: [
                            {
                                type: HAP.AudioRecordingCodecType.AAC_ELD,
                                samplerate: HAP.AudioRecordingSamplerate.KHZ_16
                            },
                        ], 
                    }
                }
            };

            if (typeof this.motionServices[0] == "object") {
                options.sensors = {
                    motion: this.motionServices[0].service //motion service
                };
            }
        }

        // Setup HomeKit camera/doorbell controller
        this.controller = this.deviceData.device_type == NestDeviceType.DOORBELL ? new HAP.DoorbellController(options) : new HAP.CameraController(options);
        this.HomeKitAccessory.configureController(this.controller);
        
        // Setup additional HomeKit characteristics we'll need
        if (typeof this.controller.doorbellService == "object") {
            this.controller.doorbellService.addCharacteristic(HAP.Characteristic.StatusActive);
        }
        if (typeof this.controller.cameraService == "object") {
            this.controller.cameraService.addCharacteristic(HAP.Characteristic.StatusActive);
        }

        if (typeof this.controller.doorbellService == "object" && this.deviceData.capabilities.includes("indoor_chime") == true && this.deviceData.hasOwnProperty("indoor_chime_switch") == true && this.deviceData.indoor_chime_switch == true) {
            // Add service to allow automation and enabling/disabling indoor chiming. This needs to be explically enabled via a configuration option for the device
            //"Option.indoor_chime_switch" : true
            this.chimeService = this.HomeKitAccessory.addService(HAP.Service.Switch, "Indoor Chime", 1);

            // Setup set callback for this swicth service
            this.chimeService.getCharacteristic(HAP.Characteristic.On).on("set", (value, callback) => {
                if (value != this.deviceData.properties["doorbell.indoor_chime.enabled"]) {
                    // only change indoor chime status value if different than on-device
                    outputLogging(ACCESSORYNAME, true, "Indoor chime on '%s' was turned", this.deviceData.mac_address, (value == true ? "on" : "off"));
                    this.set({["quartz"] : {"doorbell.indoor_chime.enabled" : value}});
                }
                callback();
            });

            this.chimeService.getCharacteristic(HAP.Characteristic.On).on("get", (callback) => {
                callback(null, this.deviceData.properties["doorbell.indoor_chime.enabled"] == true ? true : false);
            });
        }
        
        // Create streamer object. used for buffering, streaming and recording
        this.NexusStreamer = new NexusStreamer(this.HomeKitAccessory.UUID, nest.cameraAPI.token, nest.tokenType, this.deviceData, config.debug.includes(Debugging.NEXUS));

        // extra setup for HKSV after services created
        if (this.deviceData.HKSV == true && typeof this.controller.recordingManagement.recordingManagementService == "object" && this.deviceData.capabilities.includes("statusled") == true) {
            this.controller.recordingManagement.operatingModeService.addOptionalCharacteristic(HAP.Characteristic.CameraOperatingModeIndicator);

            // Setup set callbacks for characteristics
            this.controller.recordingManagement.operatingModeService.getCharacteristic(HAP.Characteristic.CameraOperatingModeIndicator).on("set", (value, callback) => {
                // 0 = auto, 1 = low, 2 = high
                // We'll use high mode for led on and low for led off
                var setValue = (value == HAP.Characteristic.CameraOperatingModeIndicator.ENABLE ? 2 :  1);
                if (setValue != this.deviceData.properties["statusled.brightness"]) {
                    // only change status led value if different than on-device
                    outputLogging(ACCESSORYNAME, true, "Recording status LED on '%s' was turned", this.deviceData.mac_address, (value == HAP.Characteristic.CameraOperatingModeIndicator.ENABLE ? "on" : "off"));
                    this.set({["quartz"] : {"statusled.brightness" : setValue}});
                }
                callback();
            });

            this.controller.recordingManagement.operatingModeService.getCharacteristic(HAP.Characteristic.CameraOperatingModeIndicator).on("get", (callback) => { 
                callback(null, this.deviceData.properties["statusled.brightness"] != 1 ? HAP.Characteristic.CameraOperatingModeIndicator.ENABLE : HAP.Characteristic.CameraOperatingModeIndicator.DISABLE);
            });
        }
        if (this.deviceData.HKSV == true && typeof this.controller.recordingManagement.recordingManagementService == "object" && this.deviceData.capabilities.includes("irled") == true) {
            this.controller.recordingManagement.operatingModeService.addOptionalCharacteristic(HAP.Characteristic.NightVision);

            this.controller.recordingManagement.operatingModeService.getCharacteristic(HAP.Characteristic.NightVision).on("set", (value, callback) => {
                var setValue = (value == true ? "auto_on" : "always_off");    
                if (setValue != this.deviceData.properties["irled.state"]) {
                    // only change IRLed status value if different than on-device
                    outputLogging(ACCESSORYNAME, true, "Night vision on '%s' was turned", this.deviceData.mac_address, (value == true ? "on" : "off"));
                    this.set({["quartz"] : {"irled.state" : setValue}});
                }
                callback();
            });

            this.controller.recordingManagement.operatingModeService.getCharacteristic(HAP.Characteristic.NightVision).on("get", (callback) => {
                callback(null, this.deviceData.properties["irled.state"] != "always_off" ? true : false);
            });
        }

        if (this.deviceData.HKSV == true && typeof this.controller.recordingManagement.recordingManagementService == "object" && this.deviceData.capabilities.includes("audio.microphone") == true) {
            this.controller.recordingManagement.recordingManagementService.getCharacteristic(HAP.Characteristic.RecordingAudioActive).on("set", (value, callback) => {
                var setValue = (value == HAP.Characteristic.RecordingAudioActive.ENABLE ? true : false);
                if (setValue != this.deviceData.properties["audio.enabled"]) {
                    // only change audio recording value if different than on-device
                    outputLogging(ACCESSORYNAME, true, "Audio recording on '%s' was turned", this.deviceData.mac_address, (value == HAP.Characteristic.RecordingAudioActive.ENABLE ? "on" : "off"));
                    this.set({["quartz"] : {"audio.enabled" : setValue}});
                }
                callback();
            });

            this.controller.recordingManagement.recordingManagementService.getCharacteristic(HAP.Characteristic.RecordingAudioActive).on("get", (callback) => {
                callback(null, this.deviceData.properties["audio.enabled"] == true ? HAP.Characteristic.RecordingAudioActive.ENABLE : HAP.Characteristic.RecordingAudioActive.DISABLE);
            });
        }

        if (this.deviceData.HKSV == true && typeof this.controller.recordingManagement.recordingManagementService == "object") {
            this.controller.recordingManagement.operatingModeService.getCharacteristic(HAP.Characteristic.HomeKitCameraActive).on("set", (value, callback) => {
                if (value != this.controller.recordingManagement.operatingModeService.getCharacteristic(HAP.Characteristic.HomeKitCameraActive).value) {
                    // Make sure only updating status if HomeKit value *actually changes*
                    var setValue = (value == HAP.Characteristic.HomeKitCameraActive.ON ? true : false);
                    if (setValue != this.deviceData.streaming_enabled) {
                        // Camera state does not reflect HKSV requested state, so fix
                        outputLogging(ACCESSORYNAME, true, "Camera on '%s' was turned", this.deviceData.mac_address, (value == HAP.Characteristic.HomeKitCameraActive.ON ? "on" : "off"));
                        this.set({["quartz"] : {"streaming.enabled" : setValue}});
                    }
                    if (setValue == false && typeof this.motionServices[0].service == "object") {
                        // Clear any inflight motion
                        this.motionServices[0].service.updateCharacteristic(HAP.Characteristic.MotionDetected, false);
                    }
                }
                callback();
            });

            this.controller.recordingManagement.operatingModeService.getCharacteristic(HAP.Characteristic.HomeKitCameraActive).on("get", (callback) => {
                callback(null, this.deviceData.streaming_enabled == true ? HAP.Characteristic.HomeKitCameraActive.ON : HAP.Characteristic.HomeKitCameraActive.OFF);
            });
        }

        // Setup linkage to EveHome app if configured todo so. We'll log motion history on the main motion service
        if (this.deviceData.EveApp == true && this.HomeKitHistory != null && typeof this.motionServices[0].service == "object") {
            this.HomeKitHistory.linkToEveHome(this.HomeKitAccessory, this.motionServices[0].service, {debug: config.debug.includes(Debugging.HISTORY)});  // Link to Eve Home if we have atleast the main montion service
        }

        outputLogging(ACCESSORYNAME, false, "Setup %s '%s'", this.HomeKitAccessory.displayName, serviceName, this.deviceData.HKSV == true ? "with HomeKit Secure Video" : this.motionServices.length >= 1 ? "with motion sensor(s)" : "");
    }

    removeHomeKitServices() {
        // Clean up our camera object since this device is being removed
        clearTimeout(this.doorbellTimer);
        clearTimeout(this.motionTimer);
        this.NexusStreamer && this.NexusStreamer.stopBuffering(); // Stop any buffering
        this.HomeKitAccessory.removeController(this.controller);
    }

    // Taken and adapted from https://github.com/hjdhjd/homebridge-unifi-protect/blob/eee6a4e379272b659baa6c19986d51f5bf2cbbbc/src/protect-ffmpeg-record.ts
    async *handleRecordingStreamRequest(HKSVRecordingStreamID) {
        if (this.motionServices[0].service.getCharacteristic(HAP.Characteristic.MotionDetected).value == false) {
            // Should only be recording if motion detected. Sometimes when starting up, HAP-nodeJS or HomeKit triggers this even when motion isn't occuring
            return;
        }

        // Audio if enabled on doorbell/camera && audio recording configured for HKSV 
        var includeAudio = (this.deviceData.audio_enabled == true && this.controller.recordingManagement.recordingManagementService.getCharacteristic(HAP.Characteristic.RecordingAudioActive).value == HAP.Characteristic.RecordingAudioActive.ENABLE);
        //var recordCodec = this.deviceData.H264EncoderRecord;    // Codec to use for H264 encoding when recording
        var recordCodec = VideoCodecs.LIBX264;

        // Build our ffmpeg commandline for the video stream
        var commandLine = "-hide_banner -nostats"
            //+ " -use_wallclock_as_timestamps 1"
            + " -f h264 -an -thread_queue_size 1024 -copytb 1 -i pipe:0"  // Video data only on stdin
            + (includeAudio == true ? " -f aac -vn -thread_queue_size 1024 -i pipe:3" : "");  // Audio data only on extra pipe created in spawn command

        commandLine = commandLine 
            + " -map 0:v"   // stdin, the first input is video data
            + " -max_muxing_queue_size 9999"
            + " -codec:v " + recordCodec;
            
        // Configure for libx264 (software encoder)
        commandLine = commandLine 
            + " -pix_fmt yuv420p"
            + " -level:v " + ((this.HKSVRecordingConfiguration.videoCodec.parameters.level == HAP.H264Level.LEVEL4_0) ? "4.0" : (this.HKSVRecordingConfiguration.videoCodec.parameters.level == HAP.H264Level.LEVEL3_2) ? "3.2" : "3.1")
            + " -preset veryfast"
            + " -b:v " + this.HKSVRecordingConfiguration.videoCodec.parameters.bitRate + "k"
            + " -filter:v fps=" + this.HKSVRecordingConfiguration.videoCodec.resolution[2]; // convert to framerate HomeKit has requested

        commandLine = commandLine 
            + " -force_key_frames expr:gte\(t,n_forced*" + this.HKSVRecordingConfiguration.videoCodec.parameters.iFrameInterval / 1000 + "\)"
            + " -fflags +nobuffer"
            + " -movflags frag_keyframe+empty_moov+default_base_moof"

        // We have seperate video and audio streams that need to be muxed together if audio recording enabled
        if (includeAudio == true) {
            var audioSampleRates = ["8", "16", "24", "32", "44.1", "48"];

            commandLine = commandLine 
                + " -map 1:a"   // pipe:3, the second input is audio data
                + " -codec:a " + AudioCodecs.LIBFDK_AAC
                + " -profile:a aac_eld" // this.HKSVRecordingConfiguration.audioCodec.type == HAP.AudioRecordingCodecType.AAC_ELD
                + " -ar " + audioSampleRates[this.HKSVRecordingConfiguration.audioCodec.samplerate] + "k"
                + " -b:a " + this.HKSVRecordingConfiguration.audioCodec.bitrate + "k"
                + " -ac " + this.HKSVRecordingConfiguration.audioCodec.audioChannels;
        }

        commandLine = commandLine 
            + " -f mp4"    // output is an mp4
            + " -avoid_negative_ts make_zero"
            + " pipe:1";    // output to stdout
        
        this.HKSVRecorder.ffmpeg = child_process.spawn(__dirname + "/ffmpeg", commandLine.split(" "), { env: process.env, stdio: ["pipe", "pipe", "pipe", "pipe"] });    // Extra pipe, #3 for audio data

        this.HKSVRecorder.video = this.HKSVRecorder.ffmpeg.stdin;   // Video data on stdio pipe for ffmpeg
        this.HKSVRecorder.audio = (includeAudio == true ? this.HKSVRecorder.ffmpeg.stdio[3] : null);    // Audio data on extra pipe for ffmpeg or null if audio recording disabled

        // Process FFmpeg output and parse out the fMP4 stream it's generating for HomeKit Secure Video.
        var pendingData = Buffer.alloc(0);
        var mp4segment = {header: Buffer.alloc(0), size: 0, type: "", data: Buffer.alloc(0)};
        var mp4boxes = [];
        this.HKSVRecorder.ffmpeg.stdout.on("data", (data) => {
            // If we have anything left from the last buffer we processed, prepend it to this buffer.
            if (pendingData.length > 0) {
                data = Buffer.concat([pendingData, data]);
                pendingData = Buffer.alloc(0);
            }
            for(;;) {
                if (data.length < 8) {
                    // We need a minimum size of data for the mp4box header, save what we have for the next buffer for processing.
                    pendingData = data;
                    break;
                }

                if (mp4segment.header.length == 0) {
                    // First 8 bytes will be the mp4box header, we need to parse this, 4 bytes are the data size, and next 4 is the box type
                    mp4segment.header = data.slice(0, 8);    // Save the mp4box header
                    mp4segment.size = data.slice(0, 4).readUInt32BE(0);  // Size of mp4box, includers header and data. Can be split over multiple data streams
                    mp4segment.type = data.slice(4, 8).toString();  // Type of mp4box
                }
                if (mp4segment.size > data.length) {
                    // If we don't have enough data in this buffer for the full mp4box, save what we have for the next buffer we see and append it there.
                    pendingData = data;
                    break;
                }

                mp4segment.data = data.slice(mp4segment.header.length, mp4segment.size);   // Get box data from combined buffer

                // Add it to our queue to be pushed out through the generator function.
                mp4boxes.push({ header: mp4segment.header, type: mp4segment.type, data: mp4segment.data });
                this.eventEmitter.emit(this.deviceData.device_uuid + MP4BOX);

                // If there's anything left in the buffer, move us to the new box and let's keep iterating.
                data = data.slice(mp4segment.size);
                mp4segment = {header: Buffer.alloc(0), size: 0, type: "", data: Buffer.alloc(0)};

                if (data.length === 0) {
                    // There's no more data in this buffer to parse, so exit loop
                    break;
                }
            }
        });

        this.HKSVRecorder.ffmpeg.on("exit", (code, signal) => {
            this.HKSVRecorder.audio && this.HKSVRecorder.audio.end(); // Tidy up our created extra pipe
            if (signal != "SIGKILL") {
                config.debug.includes(Debugging.FFMPEG) && outputLogging(ACCESSORYNAME, true, "FFmpeg recorder process exited", code, signal);
            }
        });

        this.HKSVRecorder.ffmpeg.on("error", (error) => {
            config.debug.includes(Debugging.FFMPEG) && outputLogging(ACCESSORYNAME, true, "FFmpeg recorder process error", error);
        });

        // ffmpeg outputs to stderr
        this.HKSVRecorder.ffmpeg.stderr.on("data", (data) => {
            if (data.toString().includes("frame=") == false) {
                // Monitor ffmpeg output while testing. Use "ffmpeg as a debug option"
                config.debug.includes(Debugging.FFMPEG) && outputLogging(ACCESSORYNAME, true, data.toString());
            }
        });

        this.NexusStreamer.startRecordStream("HKSV" + HKSVRecordingStreamID, this.HKSVRecorder.ffmpeg, this.HKSVRecorder.video, this.HKSVRecorder.audio, true, 0);
        config.debug.includes(Debugging.HKSV) && outputLogging(ACCESSORYNAME, true, "Recording started on '%s' %s %s", this.deviceData.mac_address, (includeAudio == true ? "with audio" : "without audio"), (recordCodec != VideoCodecs.COPY ? "using H264 encoder " + recordCodec : ""));

        // Loop generating MOOF/MDAT box pairs for HomeKit Secure Video.
        // HAP-NodeJS cancels this async generator function when recording completes also
        var segment = [];
        for(;;) {
            if (this.HKSVRecorder.ffmpeg == null) {
                // ffmpeg recorder process isn't running, so finish up the loop
                break;
            }
            
            if (mp4boxes.length == 0) {
                // since the ffmpeg recorder process hasn't notified us of any mp4 fragment boxes, wait until there are some
                await EventEmitter.once(this.eventEmitter, this.deviceData.device_uuid + MP4BOX);
            }
        
            var mp4box = mp4boxes.shift();
            if (typeof mp4box != "object") {
                // Not an mp4 fragment box, so try again
                continue;
            }

            // Queue up this fragment mp4 segment
            segment.push(mp4box.header, mp4box.data);

            if (mp4box.type === "moov" || mp4box.type === "mdat") {
                yield {data: Buffer.concat(segment), isLast: false};
                segment = [];
            }
        }
    }

    closeRecordingStream(HKSVRecordingStreamID, closeReason) {
        this.NexusStreamer.stopRecordStream("HKSV" + HKSVRecordingStreamID); // Stop the associated recording stream
        this.HKSVRecorder.ffmpeg && this.HKSVRecorder.ffmpeg.kill("SIGKILL"); // Kill the ffmpeg recorder process
        this.HKSVRecorder.ffmpeg = null; // No more ffmpeg process
        this.HKSVRecorder.video = null; // No more video stream handle
        this.HKSVRecorder.audio = null; // No more audio stream handle
        this.eventEmitter.emit(this.deviceData.device_uuid + MP4BOX);   // This will ensure we cleanly exit out from our segment generator
        this.eventEmitter.removeAllListeners(this.deviceData.device_uuid + MP4BOX);  // Tidy up our event listeners
        if (config.debug.includes(Debugging.HKSV) == true) {
            // Log recording finished messages depending on reason
            if (closeReason == HAP.HDSProtocolSpecificErrorReason.NORMAL) {
                outputLogging(ACCESSORYNAME, true, "Recording completed on '%s'", this.deviceData.mac_address);
            } else {
                outputLogging(ACCESSORYNAME, true, "Recording completed with error on '%s'. Reason was '%s'", this.deviceData.mac_address, HAP.HDSProtocolSpecificErrorReason[closeReason]);
            }
        }
    }

    updateRecordingActive(enableHKSVRecordings) {
        // We'll use the change here to determine if we start/stop any buffering.
        // Also track the HomeKit status here as gets called multiple times with no change
        // Might be fixed in HAP-NodeJS 11.x or later, but we'll keep our internal check
        if (enableHKSVRecordings == this.HKSVRecorder.record || typeof this.NexusStreamer != "object") {
            return;
        }

        if (enableHKSVRecordings == true && this.deviceData.HKSVPreBuffer > 0) {
            // Start a buffering stream for this camera/doorbell. Ensures motion captures all video on motion trigger
            // Required due to data delays by on prem Nest to cloud to HomeKit accessory to iCloud etc
            // Make sure have appropriate bandwidth!!!
            config.debug.includes(Debugging.HKSV) && outputLogging(ACCESSORYNAME, true, "Pre-buffering started for '%s'", this.deviceData.mac_address);
            this.NexusStreamer.startBuffering(this.deviceData.HKSVPreBuffer);
        }
        if (enableHKSVRecordings == false) {
            this.NexusStreamer.stopBuffering();
            config.debug.includes(Debugging.HKSV) && outputLogging(ACCESSORYNAME, true, "Pre-buffering stopped for '%s'", this.deviceData.mac_address);
        }

        this.HKSVRecorder.record = enableHKSVRecordings;
    }

    updateRecordingConfiguration(HKSVRecordingConfiguration) {
        this.HKSVRecordingConfiguration = HKSVRecordingConfiguration;   // Store the recording configuration HKSV has provided
    }

    async handleSnapshotRequest(snapshotRequestDetails, callback) {
        // snapshotRequestDetails.reason == ResourceRequestReason.PERIODIC
        // snapshotRequestDetails.reason == ResourceRequestReason.EVENT

        // Get current image from doorbell/camera
        var imageBuffer = Buffer.alloc(0);    // Empty buffer 

        if (this.deviceData.HKSV == true && typeof this.NexusStreamer == "object") {
            // Since HKSV is enabled, try getting a snapshot image from the buffer
            // If no buffering running, the image buffer will still be empty. We can try the old method if that fails 
            imageBuffer = await this.NexusStreamer.getBufferSnapshot();
        }

        if (this.deviceData.streaming_enabled == true && this.deviceData.online == true && imageBuffer.length == 0) {
            if (this.deviceData.HKSV == false && this.snapshotEvent.type != "" && this.snapshotEvent.done == false) {
                // Grab event snapshot from doorbell/camera stream for a non-HKSV camera
                await axios.get(this.deviceData.nexus_api_nest_domain_host + "/event_snapshot/" + this.deviceData.device_uuid.split(".")[1] + "/" + this.snapshotEvent.id + "?crop_type=timeline&width=" + snapshotRequestDetails.width + "&cachebuster=" + Math.floor(Date.now() / 1000), {responseType: "arraybuffer", headers: {"referer": "https://" + nest.REFERER, "user-agent": USERAGENT, "accept" : "*/*", [nest.cameraAPI.key] : nest.cameraAPI.value + nest.cameraAPI.token}, timeout: 3000})
                .then((response) => {
                    if (typeof response.status != "number" || response.status != 200) {
                        throw new Error("Nest Camera API snapshot failed with error");
                    }
                    
                    this.snapshotEvent.done = true;  // Successfully got the snapshot for the event
                    imageBuffer = response.data;
                })
                .catch((error) => {
                });
            }
            if (imageBuffer.length == 0) {
                // Still empty image buffer, so try old method for a direct grab
                await axios.get(this.deviceData.nexus_api_nest_domain_host + "/get_image?uuid=" + this.deviceData.device_uuid.split(".")[1] + "&width=" + snapshotRequestDetails.width, {responseType: "arraybuffer", headers: {"referer": "https://" + nest.REFERER, "user-agent": USERAGENT, "accept" : "*/*", [nest.cameraAPI.key] : nest.cameraAPI.value + nest.cameraAPI.token}, timeout: 3000})
                .then((response) => {
                    if (typeof response.status != "number" || response.status != 200) {
                        throw new Error("Nest Camera API snapshot failed with error");
                    }

                    imageBuffer = response.data;
                })
                .catch((error) => {
                });
            }
        }

        if (this.deviceData.streaming_enabled == false && this.deviceData.online == true && fs.existsSync(__dirname + "/" + CAMERAOFFJPGFILE) == true) { 
            // Return "camera switched off" jpg to image buffer
            imageBuffer = fs.readFileSync(__dirname + "/" + CAMERAOFFJPGFILE);
        }

        if (this.deviceData.online == false && fs.existsSync(__dirname + "/" + CAMERAOFFLINEJPGFILE) == true) {
            // Return "camera offline" jpg to image buffer
            imageBuffer = fs.readFileSync(__dirname + "/" + CAMERAOFFLINEJPGFILE);
        }

        callback((imageBuffer.length == 0 ? "No Camera/Doorbell snapshot obtained" : null), imageBuffer);
    }

    async prepareStream(request, callback) {
        // Generate streaming session information
        var sessionInfo = {
            HomeKitSessionID: request.sessionID,  // Store session ID
            address: request.targetAddress,
            videoPort: request.video.port,
            localVideoPort: await this.#getPort(),
            videoCryptoSuite: request.video.srtpCryptoSuite,
            videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
            videoSSRC: HAP.CameraController.generateSynchronisationSource(),

            audioPort: request.audio.port,
            localAudioPort: await this.#getPort(),
            audioTalkbackPort: await this.#getPort(),
            rptSplitterPort: await this.#getPort(),
            audioCryptoSuite: request.video.srtpCryptoSuite,
            audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
            audioSSRC: HAP.CameraController.generateSynchronisationSource(),

            rtpSplitter: null,
            ffmpeg: [], // Array of ffmpeg process we create for streaming video/audio and audio talkback
            video: null,
            audio: null
        };

        // Build response back to HomeKit with our details
        var response = {
            address: ip.address("public", request.addressVersion), // IP Address version must match
            video: {
                port: sessionInfo.localVideoPort,
                ssrc: sessionInfo.videoSSRC,
                srtp_key: request.video.srtp_key,
                srtp_salt: request.video.srtp_salt,
            },
            audio: {
                port: sessionInfo.rptSplitterPort,
                ssrc: sessionInfo.audioSSRC,
                srtp_key: request.audio.srtp_key,
                srtp_salt: request.audio.srtp_salt,
            }
        };
        this.pendingSessions[request.sessionID] = sessionInfo;  // Store the session information
        callback(null, response);
    }

    async handleStreamRequest(request, callback) {
        // called when HomeKit asks to start/stop/reconfigure a camera/doorbell stream
        if (request.type == HAP.StreamRequestTypes.START) {
            this.ongoingSessions[request.sessionID] = this.pendingSessions[request.sessionID];  // Move our pending session to ongoing session
            delete this.pendingSessions[request.sessionID]; // remove this pending session information

            var includeAudio = (this.deviceData.audio_enabled == true);

            // Build our ffmpeg command string for the video stream
            var commandLine = "-hide_banner -nostats"
                + " -use_wallclock_as_timestamps 1"
                + " -f h264 -an -thread_queue_size 1024 -copytb 1 -i pipe:0"  // Video data only on stdin
                + (includeAudio == true ? " -f aac -vn -thread_queue_size 1024 -i pipe:3" : "");  // Audio data only on extra pipe created in spawn command
    
            // Build our video command for ffmpeg
            commandLine = commandLine 
                + " -map 0:v"   // stdin, the first input is video data
                + " -max_muxing_queue_size 9999"
                + " -codec:v copy"
                + " -fflags +nobuffer"
                + " -payload_type " + request.video.pt
                + " -ssrc " + this.ongoingSessions[request.sessionID].videoSSRC
                + " -f rtp"
                + " -avoid_negative_ts make_zero"
                + " -srtp_out_suite " + HAP.SRTPCryptoSuites[this.ongoingSessions[request.sessionID].videoCryptoSuite] + " -srtp_out_params " + this.ongoingSessions[request.sessionID].videoSRTP.toString("base64")
                + " srtp://" + this.ongoingSessions[request.sessionID].address + ":" + this.ongoingSessions[request.sessionID].videoPort + "?rtcpport=" + this.ongoingSessions[request.sessionID].videoPort + "&localrtcpport=" + this.ongoingSessions[request.sessionID].localVideoPort + "&pkt_size=" + request.video.mtu;

            // We have seperate video and audio streams that need to be muxed together if audio enabled
            if (includeAudio == true) {
                commandLine = commandLine 
                    + " -map 1:a"   // pipe:3, the second input is audio data
                    + " -codec:a " + AudioCodecs.LIBFDK_AAC
                    + " -profile:a aac_eld" // request.codec == "ACC-eld"
                    + " -flags +global_header"
                    + " -ar " + request.audio.sample_rate + "k"
                    + " -b:a " + request.audio.max_bit_rate + "k"
                    + " -ac " + request.audio.channel 
                    + " -payload_type " + request.audio.pt
                    + " -ssrc " + this.ongoingSessions[request.sessionID].audioSSRC
                    + " -f rtp"
                    + " -srtp_out_suite " + HAP.SRTPCryptoSuites[this.ongoingSessions[request.sessionID].audioCryptoSuite] + " -srtp_out_params " + this.ongoingSessions[request.sessionID].audioSRTP.toString("base64")
                    + " srtp://" + this.ongoingSessions[request.sessionID].address + ":" + this.ongoingSessions[request.sessionID].audioPort + "?rtcpport=" + this.ongoingSessions[request.sessionID].audioPort + "&localrtcpport=" + this.ongoingSessions[request.sessionID].localAudioPort + "&pkt_size=188";
            }

            // Start our ffmpeg streaming process and stream from nexus
            config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Live stream started on '%s'", this.deviceData.mac_address);
            var ffmpegStreaming = child_process.spawn(__dirname + "/ffmpeg", commandLine.split(" "), { env: process.env, stdio: ["pipe", "pipe", "pipe", "pipe"] });    // Extra pipe, #3 for audio data
            this.NexusStreamer && this.NexusStreamer.startLiveStream(request.sessionID, ffmpegStreaming.stdin, (includeAudio == true && ffmpegStreaming.stdio[3] ? ffmpegStreaming.stdio[3] : null), false);

            // ffmpeg console output is via stderr
            ffmpegStreaming.stderr.on("data", (data) => {
                if (data.toString().includes("frame=") == false) {
                    // Monitor ffmpeg output while testing. Use "ffmpeg as a debug option"
                    config.debug.includes(Debugging.FFMPEG) && outputLogging(ACCESSORYNAME, true, data.toString());
                }
            });

            ffmpegStreaming.on("exit", (code, signal) => {
                if (signal != "SIGKILL" || signal == null) {
                    config.debug.includes(Debugging.FFMPEG) && outputLogging(ACCESSORYNAME, true, "FFmpeg Audio/Video streaming processes stopped", code, signal);
                    this.controller.forceStopStreamingSession(request.sessionID);
                }
            });

            // We only create the the rtpsplitter and ffmpeg processs if twoway audio is supported AND audio enabled on doorbell/camera
            var ffmpegAudioTalkback = null;   // No ffmpeg process for return audio yet
            if (includeAudio == true && this.audioTalkback == true) {
                // Setup RTP splitter for two/away audio
                this.ongoingSessions[request.sessionID].rtpSplitter = dgram.createSocket("udp4");
                this.ongoingSessions[request.sessionID].rtpSplitter.bind(this.ongoingSessions[request.sessionID].rptSplitterPort);

                this.ongoingSessions[request.sessionID].rtpSplitter.on("error", (error) => {
                    this.ongoingSessions[request.sessionID].rtpSplitter.close();
                });
                
                this.ongoingSessions[request.sessionID].rtpSplitter.on("message", (message) => {
                    var payloadType = (message.readUInt8(1) & 0x7f);
                    if (payloadType == request.audio.pt) {
                        // Audio payload type from HomeKit should match our payload type for audio
                        if (message.length > 50) {
                            // Only send on audio data if we have a longer audio packet. (not sure it makes any difference, as under iOS 15 packets are roughly same length)
                            this.ongoingSessions[request.sessionID].rtpSplitter.send(message, this.ongoingSessions[request.sessionID].audioTalkbackPort);
                        }
                    } else {
                        this.ongoingSessions[request.sessionID].rtpSplitter.send(message, this.ongoingSessions[request.sessionID].localAudioPort);
                        // Send RTCP to return audio as a heartbeat
                        this.ongoingSessions[request.sessionID].rtpSplitter.send(message, this.ongoingSessions[request.sessionID].audioTalkbackPort);
                    }
                });

                // Build ffmpeg command
                var commandLine = "-hide_banner -nostats"
                    + " -protocol_whitelist pipe,udp,rtp"
                    + " -f sdp"
                    + " -codec:a " + AudioCodecs.LIBFDK_AAC
                    + " -i pipe:0"
                    + " -map 0:a"
                    + " -codec:a " + AudioCodecs.LIBSPEEX
                    + " -frames_per_packet 4"
                    + " -vad 1" // testing to filter background noise?
                    + " -ac 1"
                    + " -ar " + request.audio.sample_rate + "k"
                    + " -f data pipe:1";
            
                ffmpegAudioTalkback = child_process.spawn(__dirname + "/ffmpeg", commandLine.split(" "), { env: process.env });
                ffmpegAudioTalkback.on("error", (error) => {
                    config.debug.includes(Debugging.FFMPEG) && outputLogging(ACCESSORYNAME, true, "FFmpeg failed to start Nest camera talkback audio process", error.message);
                });

                ffmpegAudioTalkback.stderr.on("data", (data) => {
                    if (data.toString().includes("size=") == false) {
                        // Monitor ffmpeg output while testing. Use "ffmpeg as a debug option"
                        config.debug.includes(Debugging.FFMPEG) && outputLogging(ACCESSORYNAME, true, data.toString());
                    }
                });

                // Write out SDP configuration
                // Tried to align the SDP configuration to what HomeKit has sent us in its audio request details
                ffmpegAudioTalkback.stdin.write("v=0\n"
                    + "o=- 0 0 IN " + (this.ongoingSessions[request.sessionID].ipv6 ? "IP6" : "IP4") + " " + this.ongoingSessions[request.sessionID].address + "\n"
                    + "s=Nest Audio Talkback\n"
                    + "c=IN " + (this.ongoingSessions[request.sessionID].ipv6 ? "IP6" : "IP4") + " " + this.ongoingSessions[request.sessionID].address + "\n"
                    + "t=0 0\n"
                    + "m=audio " + this.ongoingSessions[request.sessionID].audioTalkbackPort + " RTP/AVP " + request.audio.pt + "\n"
                    + "b=AS:" + request.audio.max_bit_rate + "\n"
                    + "a=ptime:" + request.audio.packet_time + "\n"
                    + "a=rtpmap:" + request.audio.pt + " MPEG4-GENERIC/" + (request.audio.sample_rate * 1000) + "/1\n"
                    + "a=fmtp:" + request.audio.pt + " profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=F8F0212C00BC00\n"
                    + "a=crypto:1 " + HAP.SRTPCryptoSuites[this.ongoingSessions[request.sessionID].audioCryptoSuite] + " inline:" + this.ongoingSessions[request.sessionID].audioSRTP.toString("base64"));
                ffmpegAudioTalkback.stdin.end();

                config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Audio talkback stream started for '%s'", this.deviceData.mac_address);
                this.NexusStreamer && this.NexusStreamer.startTalkStream(request.sessionID, ffmpegAudioTalkback.stdout);
            }

            // Store our ffmpeg sessions
            ffmpegStreaming && this.ongoingSessions[request.sessionID].ffmpeg.push(ffmpegStreaming);  // Store ffmpeg process ID
            ffmpegAudioTalkback && this.ongoingSessions[request.sessionID].ffmpeg.push(ffmpegAudioTalkback);  // Store ffmpeg audio return process ID
            this.ongoingSessions[request.sessionID].video = request.video;  // Cache the video request details
            this.ongoingSessions[request.sessionID].audio = request.audio;  // Cache the audio request details
        }

        if (request.type == HAP.StreamRequestTypes.STOP && typeof this.ongoingSessions[request.sessionID] == "object") {
            this.NexusStreamer && this.NexusStreamer.stopTalkStream(request.sessionID);
            this.NexusStreamer && this.NexusStreamer.stopLiveStream(request.sessionID);
            this.ongoingSessions[request.sessionID].rtpSplitter && this.ongoingSessions[request.sessionID].rtpSplitter.close();
            this.ongoingSessions[request.sessionID].ffmpeg && this.ongoingSessions[request.sessionID].ffmpeg.forEach((ffmpeg) => {
                ffmpeg && ffmpeg.kill("SIGKILL"); // Kill this ffmpeg process
            });
            this.controller.forceStopStreamingSession(request.sessionID);
            delete this.ongoingSessions[request.sessionID]; // this session has finished
            config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Live stream stopped on '%s'", this.deviceData.mac_address);
        }

        if (request.type == HAP.StreamRequestTypes.RECONFIGURE && typeof this.ongoingSessions[request.sessionID] == "object") {
            // todo - implement???
            //config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Reconfiguration request for live stream on '%s'", this.deviceData.mac_address);
        }
        
        if (typeof callback === "function") callback();  // do callback if defined
    }

    updateHomeKitServices(updatedDeviceData) {
        if (typeof updatedDeviceData != "object" || typeof this.controller != "object" || typeof this.NexusStreamer != "object" || this.NexusStreamer == null) {
            return;
        }

        // For non-HKSV enabled devices, we will process any activity zone changes to add or remove any motion services
        if (updatedDeviceData.HKSV == false && (JSON.stringify(updatedDeviceData.activity_zones) !== JSON.stringify(this.deviceData.activity_zones))) {
            // Check to see if any activity zones were added
            updatedDeviceData.activity_zones.filter(zone => {return zone.id != 0}).forEach((zone) => {
                var index = this.motionServices.findIndex( ({ id }) => id == zone.id);
                if (index == -1) {
                    // Zone doesn't have an associated motion sensor, so add one
                    var tempService = this.HomeKitAccessory.addService(HAP.Service.MotionSensor, zone.name, zone.id);
                    this.motionServices.push({"service": tempService, "id": zone.id})
                } else {
                    // found an associated motion sensor for this zone, so update name
                    this.motionServices[index].service.updateCharacteristic(HAP.Characteristic.Name, zone.name);
                }
            });

            // Check to see if any activity zones were removed
            this.motionServices.filter(service => {return service.id != 0}).forEach((service, index) => {
                if (updatedDeviceData.activity_zones.findIndex( ({ id }) => id == service.id) == -1) {
                    // Motion service we created doesn't appear in zone list anymore, so assume deleted
                    this.HomeKitAccessory.removeService(service.service);
                    this.motionServices.splice(index, 1);
                }
            });
        }

        if (updatedDeviceData.HKSV == true && typeof this.controller.recordingManagement.operatingModeService == "object") {
            // Update camera off/on status for HKSV
            this.controller.recordingManagement.operatingModeService.updateCharacteristic(HAP.Characteristic.ManuallyDisabled, (updatedDeviceData.streaming_enabled == true ? HAP.Characteristic.ManuallyDisabled.ENABLED : HAP.Characteristic.ManuallyDisabled.DISABLED));

            if (updatedDeviceData.capabilities.includes("statusled") == true && typeof updatedDeviceData.properties["statusled.brightness"] == "number") {
                // Set camera recording indicator. This cannot be turned off on Nest Cameras/Doorbells
                // 0 = auto
                // 1 = low
                // 2 = high
                this.controller.recordingManagement.operatingModeService.updateCharacteristic(HAP.Characteristic.CameraOperatingModeIndicator, (updatedDeviceData.properties["statusled.brightness"] != 1 ? HAP.Characteristic.CameraOperatingModeIndicator.ENABLE : HAP.Characteristic.CameraOperatingModeIndicator.DISABLE));
            }
            if (updatedDeviceData.capabilities.includes("irled") == true && typeof updatedDeviceData.properties["irled.state"] == "string") {
                // Set nightvision status in HomeKit
                this.controller.recordingManagement.operatingModeService.updateCharacteristic(HAP.Characteristic.NightVision, (updatedDeviceData.properties["irled.state"] != "always_off" ? true : false));
            }
        }
        
        if (updatedDeviceData.HKSV == true && typeof this.controller.recordingManagement.recordingManagementService == "object") {
            if (typeof updatedDeviceData.properties["audio.enabled"] == "boolean") {
                // Update recording audio status
                this.controller.recordingManagement.recordingManagementService.updateCharacteristic(HAP.Characteristic.RecordingAudioActive, updatedDeviceData.properties["audio.enabled"] == true ? HAP.Characteristic.RecordingAudioActive.ENABLE : HAP.Characteristic.RecordingAudioActive.DISABLE);
            }
        }

        // Update online status of Doorbell/Camera in HomeKit
        if (typeof this.controller.doorbellService == "object") {
            this.controller.doorbellService.updateCharacteristic(HAP.Characteristic.StatusActive, updatedDeviceData.online);
        }
        if (typeof this.controller.cameraService == "object") {
            this.controller.cameraService.updateCharacteristic(HAP.Characteristic.StatusActive, updatedDeviceData.online);
        }

        // If we have a service enabled to allow switching on/off indoor chime, update
        if (this.chimeService != null && updatedDeviceData.properties.hasOwnProperty("doorbell.indoor_chime.enabled") == true) {
            this.chimeService.updateCharacteristic(HAP.Characteristic.On, updatedDeviceData.properties["doorbell.indoor_chime.enabled"]);
        }

        this.audioTalkback = (updatedDeviceData.capabilities.includes("audio.speaker") == true && updatedDeviceData.capabilities.includes("audio.microphone") == true) ? true : false;  // If both speaker & microphone capabilities, then we support twoway audio
        this.controller.setSpeakerMuted(updatedDeviceData.audio_enabled == false ? true : false);    // if audio is disabled, we'll mute speaker
        this.NexusStreamer.update(nest.cameraAPI.token, nest.tokenType, updatedDeviceData);         // Notify the Nexus object of any camera detail updates that it might need to know about

        // Process alerts, most recent first
        // For HKSV, we're interested in doorbell and motion events
        // For non-HKSV, we're interested in doorbell, face and person events (maybe sound and package later)
        updatedDeviceData.alerts.reverse().forEach((event) => {
            // Handle doorbell event, should always be handled first
            // We'll always process a doorbell press event regardless of HAP.Characteristic.HomeKitCameraActive state in HKSV
            if (typeof this.controller.doorbellService == "object" && event.types.includes("doorbell") == true && this.doorbellTimer == null) {
                // Cooldown for doorbell button being pressed (filters out constant pressing for time period)
                // Start this before we process further
                this.doorbellTimer = setTimeout(() => {
                    this.snapshotEvent = {type: "", time: 0, id: 0, done: false}; // Clear snapshot event image after timeout
                    this.doorbellTimer = null;  // No doorbell timer active
                }, this.deviceData.DoorbellCooldown);

                if (event.types.includes("motion") == false) {
                    // No motion event with the doorbell alert, add one to trigger HKSV recording
                    event.types.push("motion");
                }

                this.snapshotEvent = {type: "ring", time: event.playback_time, id : event.id, done: false}; // needed for a HKSV enabled doorbell???

                if (updatedDeviceData.properties.hasOwnProperty("doorbell.indoor_chime.enabled") == true && updatedDeviceData.properties["doorbell.indoor_chime.enabled"] == false) {
                    // Indoor chime is disabled, so we won't "ring" the doorbell
                    config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Doorbell pressed on '%s' but indoor chime is silenced", this.deviceData.mac_address);  
                }
                if (updatedDeviceData.properties.hasOwnProperty("doorbell.indoor_chime.enabled") == true && updatedDeviceData.properties["doorbell.indoor_chime.enabled"] == true) {
                    // Indoor chime is enabled, so "ring" the doorbel
                    config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Doorbell pressed on '%s'", this.deviceData.mac_address);
                    this.controller.ringDoorbell();
                }

                if (this.HomeKitHistory != null) {
                    this.HomeKitHistory.addHistory(this.controller.doorbellService, {time: Math.floor(Date.now() / 1000), status: 1});   // Doorbell pressed history
                    this.HomeKitHistory.addHistory(this.controller.doorbellService, {time: Math.floor(Date.now() / 1000), status: 0});   // Doorbell un-pressed history
                }
            }

            // Handle motion event only for HKSV enabled camera. We will use this to trigger the starting of the HKSV recording
            // Motion is only activated if configured via HAP.Characteristic.HomeKitCameraActive == 1 (on)
            if (updatedDeviceData.HKSV == true && event.types.includes("motion") == true) {
                this.HKSVRecorder.time = event.playback_time; // Timestamp for playback from Nest for the detected motion

                if (this.controller.recordingManagement.operatingModeService.getCharacteristic(HAP.Characteristic.HomeKitCameraActive).value == HAP.Characteristic.HomeKitCameraActive.ON) {
                    if (this.motionServices[0].service.getCharacteristic(HAP.Characteristic.MotionDetected).value != true) {
                        // Make sure if motion detected, the motion sensor is still active
                        config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Motion started on '%s'", this.deviceData.mac_address);
                        this.motionServices[0].service.updateCharacteristic(HAP.Characteristic.MotionDetected, true);    // Trigger motion
                        this.HomeKitHistory && this.HomeKitHistory.addHistory(this.motionServices[0].service, {time: Math.floor(Date.now() / 1000), status: 1});   // Motion started for history
                    }

                    clearTimeout(this.motionTimer); // Clear any motion active timer so we can extend
                    this.motionTimer = setTimeout(() => {
                        config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Motion ended on '%s'", this.deviceData.mac_address);
                        this.motionServices[0].service.updateCharacteristic(HAP.Characteristic.MotionDetected, false);  // clear motion
                        this.HomeKitHistory && this.HomeKitHistory.addHistory(this.motionServices[0].service, {time: Math.floor(Date.now() / 1000), status: 0});   // Motion ended for history
                        this.motionTimer = null;   // No motion timer active
                    }, this.deviceData.MotionCooldown);
                }
            }

            // Handle person/face event for non HKSV enabled cameras and only those marked as important
            // We also treat a "face" event the same as a person event ie: if you have a face, you have a person
            if (updatedDeviceData.HKSV == false && (event.types.includes("person") == true || event.types.includes("face") == true)) {
                if (event.is_important == true && this.doorbellTimer == null && this.personTimer == null) {
                    config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Person detected on '%s'", this.deviceData.mac_address);

                    // Cooldown for person being detected
                    // Start this before we process further
                    this.personTimer = setTimeout(() => {
                        this.snapshotEvent = {type: "", time: 0, id: 0, done: false}; // Clear snapshot event image after timeout
                        this.HomeKitHistory && this.HomeKitHistory.addHistory(this.motionServices[0].service, {time: Math.floor(Date.now() / 1000), status: 0});   // Motion ended for history
                        this.motionServices.forEach((motionService, index) => { 
                            motionService.service.updateCharacteristic(HAP.Characteristic.MotionDetected, false);  // clear any motion
                        });
                        this.personTimer = null;  // No person timer active
                    }, this.deviceData.PersonCooldown);

                    // Check which zone triggered the person alert and update associated motion sensor(s)
                    this.HomeKitHistory && this.HomeKitHistory.addHistory(this.motionServices[0].service, {time: Math.floor(Date.now() / 1000), status: 1});   // Motion started for history
                    this.snapshotEvent = {type: "person", time: event.playback_time, id : event.id, done: false};
                    event.zone_ids.forEach((zoneID) => {
                        var index = this.motionServices.findIndex( ({ id }) => id == zoneID);
                        if (index != -1) {
                            this.motionServices[index].service.updateCharacteristic(HAP.Characteristic.MotionDetected, true);    // Trigger motion for matching zone
                        }
                    });
                }
            }

            // Handle motion event for non HKSV enabled cameras
            if (updatedDeviceData.HKSV == false && event.types.includes("motion") == true) {
                // <---- To implement
            }

            // Handle package event for non HKSV enabled cameras
            if (updatedDeviceData.HKSV == false && event.types.includes("package") == true) {
                // <---- To implement
            }
            
            // Handle sound event for non HKSV enabled cameras
            if (updatedDeviceData.HKSV == false && event.types.includes("sound") == true) {
                // <---- To implement
            }
        });
    }

    async #getPort(options) {
        return new Promise((resolve, reject) => {
            var server = net.createServer();
            server.unref();
            server.on("error", reject);
            server.listen(options, () => {
                var port = server.address().port;
                server.close(() => {
                    resolve(port);  // return port
                });
            });
        });
    }
}


// Nest "virtual" weather
class NestWeather extends HomeKitDevice {
    constructor(currentDeviceData, globalEventEmitter) {
        super(ACCESSORYNAME, ACCESSORYPINCODE, config.mDNS, currentDeviceData.device_uuid, currentDeviceData, globalEventEmitter);
 
        this.batteryService = null;
        this.airPressureService = null;
        this.temperatureService = null;
        this.humidityService = null;
    }


    // Class functions 
    addHomeKitServices(serviceName) {
        this.temperatureService = this.HomeKitAccessory.addService(HAP.Service.TemperatureSensor, "Temperature", 1);
        this.airPressureService = this.HomeKitAccessory.addService(HAP.Service.EveAirPressureSensor, "", 1);
        this.humidityService = this.HomeKitAccessory.addService(HAP.Service.HumiditySensor, "Humidity", 1);  
        this.batteryService = this.HomeKitAccessory.addService(HAP.Service.BatteryService, "", 1);
        this.batteryService.updateCharacteristic(HAP.Characteristic.ChargingState, HAP.Characteristic.ChargingState.NOT_CHARGEABLE);    // Really not chargeable ;-)

        // Add custom weather characteristics
        this.temperatureService.addCharacteristic(HAP.Characteristic.ForecastDay);
        this.temperatureService.addCharacteristic(HAP.Characteristic.ObservationStation);
        this.temperatureService.addCharacteristic(HAP.Characteristic.Condition);
        this.temperatureService.addCharacteristic(HAP.Characteristic.WindDirection);
        this.temperatureService.addCharacteristic(HAP.Characteristic.WindSpeed);
        this.temperatureService.addCharacteristic(HAP.Characteristic.SunriseTime);
        this.temperatureService.addCharacteristic(HAP.Characteristic.SunsetTime);

        this.HomeKitAccessory.setPrimaryService(this.temperatureService);

        // Setup linkage to EveHome app if configured todo so
        if (this.deviceData.EveApp == true && this.HomeKitHistory != null) {
            this.HomeKitHistory.linkToEveHome(this.HomeKitAccessory, this.airPressureService, {debug: config.debug.includes(Debugging.HISTORY)});
        }

        outputLogging(ACCESSORYNAME, false, "Setup Nest virtual weather station '%s'", serviceName);
    }

    updateHomeKitServices(updatedDeviceData) {
        if (typeof updatedDeviceData != "object" || this.temperatureService == null || this.humidityService == null || this.batteryService == null || this.airPressureService == null) {
            return;
        }

        this.batteryService.updateCharacteristic(HAP.Characteristic.BatteryLevel, 100); // Always %100
        this.batteryService.updateCharacteristic(HAP.Characteristic.StatusLowBattery, HAP.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

        this.temperatureService.updateCharacteristic(HAP.Characteristic.CurrentTemperature, updatedDeviceData.current_temperature);
        this.humidityService.updateCharacteristic(HAP.Characteristic.CurrentRelativeHumidity, updatedDeviceData.current_humidity);
        //this.airPressureService.updateCharacteristic(HAP.Characteristic.EveAirPressure, 0);   // Need to work out where can get this from
        this.airPressureService.updateCharacteristic(HAP.Characteristic.EveElevation, updatedDeviceData.elevation);

        // Update custom characteristics
        this.temperatureService.updateCharacteristic(HAP.Characteristic.ForecastDay, updatedDeviceData.forecast);
        this.temperatureService.updateCharacteristic(HAP.Characteristic.ObservationStation, updatedDeviceData.station);
        this.temperatureService.updateCharacteristic(HAP.Characteristic.Condition, updatedDeviceData.condition);
        this.temperatureService.updateCharacteristic(HAP.Characteristic.WindDirection, updatedDeviceData.wind_direction);
        this.temperatureService.updateCharacteristic(HAP.Characteristic.WindSpeed, updatedDeviceData.wind_speed);
        this.temperatureService.updateCharacteristic(HAP.Characteristic.SunriseTime, new Date(updatedDeviceData.sunrise * 1000).toLocaleTimeString());
        this.temperatureService.updateCharacteristic(HAP.Characteristic.SunsetTime, new Date(updatedDeviceData.sunset * 1000).toLocaleTimeString());

        if (this.HomeKitHistory != null) {
            // Record history every 5mins
            this.HomeKitHistory.addHistory(this.airPressureService, {time: Math.floor(Date.now() / 1000), temperature: updatedDeviceData.current_temperature, humidity: updatedDeviceData.current_humidity, pressure: 0}, 300);
        }
    }
}


// NestSystem class
//
// Handles access to/from the Nest system API
const CAMERAALERTPOLLING = 2000;                                            // Camera alerts polling timer
const CAMERAZONEPOLLING = 30000;                                            // Camera zones changes polling timer
const WEATHERPOLLING = 300000;                                              // Refresh weather data every 5mins
const SUBSCRIBETIMEOUT = (5 * 60 * 1000);                                   // Timeout for no subscription data
const NESTAPITIMEOUT = 10000;                                               // Calls to Nest API timeout
const USERAGENT = "Nest/5.71.0 (iOScom.nestlabs.jasper.release) os=16.6";   // User Agent string
const TEMPSENSORONLINETIMEOUT = (3600 * 4);                                 // Temp sensor online reporting timeout                    

const SystemEvent = {
    ADD : "addDevice",
    REMOVE : "removeDevice"
}

const NestDeviceType = {
    THERMOSTAT : "thermostat",
    TEMPSENSOR : "temperature",
    SMOKESENSOR : "protect",
    CAMERA : "camera",
    DOORBELL : "doorbell",
    WEATHER : "weather",
    LOCK : "lock",  // yet to implement
    ALARM : "alarm" // yet to implement
}

class NestSystem {
	constructor(fieldTest, token, tokenType, globalEventEmitter) {
        this.initialToken = token;                                              // Inital token to access Nest system
        this.tokenType = tokenType;                                             // Type of account we authorised to Nest with
        this.nestAPIToken = "";                                                 // Access token for Nest API requests
        this.tokenTimer = null;                                                 // Handle for token refresh timer
        this.fieldTest = fieldTest;                                             // Nest FieldTest mode
        this.cameraAPI = {key: "", value: "", token: ""};                       // Header Keys for camera API calls
        this.transport_url = "";                                                // URL for Nest API requests
        this.weather_url = "";                                                  // URL for Nest weather API
        this.userID = "";                                                       // User ID
        this.rawData = {};                                                      // Full copy of nest structure data
        this.abortController = new AbortController();                           // Abort controller object
        this.eventEmitter = globalEventEmitter;                                 // Global event emitter
        this.subscribePollingTimers = [];                                       // Array of polling timers where we cannot do subscribe requests
        this.startTime = Math.floor(Date.now() / 1000);                         // Time we started the object. used to filter out old alerts

        // Setup API endpoints
        this.REFERER = "home.nest.com";                                         // Which host is "actually" doing the request
        this.NESTAPIHOST = "home.nest.com"                                      // Root URL for Nest system API
        this.CAMERAAPIHOST = "camera.home.nest.com";                            // Root URL for Camera system API

        if (fieldTest == true) {
            // Nest FieldTest mode support enabled in configuration, so update required endpoints
            // This is all "untested"
            this.REFERER = "home.ft.nest.com";                                  // Which host is "actually" doing the request
            this.NESTAPIHOST = "home.ft.nest.com"                               // Root FT URL for Nest system API
            this.CAMERAAPIHOST = "camera.home.ft.nest.com";                     // Root FT URL for Camera system API
        }

        // Setup event processing for set/get properties
        this.eventEmitter.addListener(HomeKitDevice.SET, this.#set.bind(this));
        this.eventEmitter.addListener(HomeKitDevice.GET, this.#get.bind(this));
    }

    
    // Class functions
    async connect() {
        var tempToken = "";
        var tokenExpire = null;
        clearInterval(this.tokenTimer); // Clear any current token refresh timeout

        if (this.fieldTest == true) {
            // Nest FieldTest account support has been enabled in the configuration
            outputLogging(ACCESSORYNAME, false, "Using Nest FieldTest API");
        }

        if (this.tokenType == "google" && typeof this.initialToken == "object" && this.initialToken.hasOwnProperty("issuetoken") && this.initialToken.hasOwnProperty("cookie") && this.initialToken.issuetoken != "" && this.initialToken.cookie != "") {
            // Google cookie method as refresh token method no longer supported by Google since October 2022
            // Instructions from homebridge_nest or homebridge_nest_cam to obtain this
            outputLogging(ACCESSORYNAME, false, "Performing Google account authorisation");
            try {
                var response = await axios.get(this.initialToken.issuetoken, {headers: {"user-agent": USERAGENT, "cookie": this.initialToken.cookie, "referer": "https://accounts.google.com/o/oauth2/iframe", "Sec-Fetch-Mode": "cors", "X-Requested-With": "XmlHttpRequest"} });
                if (typeof response.status != "number" || response.status != 200) {
                    throw new Error("Google API Authorisation failed with error");
                }

                var response = await axios.post("https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt", "embed_google_oauth_access_token=true&expire_after=3600s&google_oauth_access_token=" + response.data.access_token + "&policy_id=authproxy-oauth-policy", {headers: {"referer": "https://" + this.REFERER,"user-agent": USERAGENT, "Authorization": "Bearer " + response.data.access_token} });
                if (typeof response.status != "number" || response.status != 200) {
                    throw new Error("Google Camera API Token get failed with error");
                }

                tempToken = response.data.jwt;
                tokenExpire = Math.floor(new Date(response.data.claims.expirationTime) / 1000);   // Token expiry, should be 1hr
                this.tokenType = "google";  // Google account
                this.cameraAPI.key = "Authorization"; // We'll put this in API header calls for cameras
                this.cameraAPI.value = "Basic ";    // NOTE: space at end of string. Required
                this.cameraAPI.token = response.data.jwt; // We'll put this in API header calls for cameras
            } 
            catch (error) {
            }
        }

        if (this.tokenType == "nest" && typeof this.initialToken == "string" && this.initialToken != "") {
            // Nest session token method. Get WEBSITE2 cookie for use with camera API calls if needed later
            outputLogging(ACCESSORYNAME, false, "Performing Nest account authorisation");
            try {
                var response = await axios.post("https://webapi." + this.CAMERAAPIHOST + "/api/v1/login.login_nest", Buffer.from("access_token=" + this.initialToken, "utf8"), {withCredentials: true, headers: {"referer": "https://" + this.REFERER, "Content-Type": "application/x-www-form-urlencoded", "user-agent": USERAGENT} });
                if (typeof response.status != "number" || response.status != 200 || typeof response.data.status != "number" || response.data.status != 0) {
                    throw new Error("Nest API Authorisation failed with error");
                }

                tempToken = this.initialToken; // Since we got camera details, this is a good token to use
                tokenExpire = Math.floor(Date.now() / 1000) + (3600 * 24);  // 24hrs expiry from now
                this.tokenType = "nest";  // Nest account
                this.cameraAPI.key = "cookie";  // We'll put this in API header calls for cameras
                this.cameraAPI.value = this.fieldTest == true ? "website_ft=" : "website_2=";
                this.cameraAPI.token = response.data.items[0].session_token; // We'll put this in API header calls for cameras
            } 
            catch (error) {
            }
        }

        // We have a token, so open Nest session to get further details we require
        try {
            var response = await axios.get("https://" + this.NESTAPIHOST + "/session", {headers: {"user-agent": USERAGENT, "Authorization": "Basic " + tempToken} });
            if (typeof response.status != "number" || response.status != 200) {
                throw new Error("Nest Session API get failed with error");
            }
    
            this.transport_url = response.data.urls.transport_url;
            this.weather_url = response.data.urls.weather_url;
            this.userID = response.data.userid;
            this.nestAPIToken = tempToken; // Since we've successfully gotten Nest user data, store token for later. Means valid token

            // Set timeout for token expiry refresh
            this.tokenTimer = setTimeout(() => {
                outputLogging(ACCESSORYNAME, false, "Performing periodic token refresh");
                this.connect();
            }, (tokenExpire - Math.floor(Date.now() / 1000) - 60) * 1000); // Refresh just before token expiry

            outputLogging(ACCESSORYNAME, false, "Successfully authorised");
        } 
        catch (error) {
            // The token we used to obtained a Nest session failed, so overall authorisation failed
            outputLogging(ACCESSORYNAME, false, "Authorisation failed!");
        }
    }

    async getData() {
        if (typeof this.nestAPIToken != "string" || typeof this.transport_url != "string" || typeof this.userID != "string" ||
            this.nestAPIToken == "" || this.transport_url == "" || this.userID == "") {
            return;
        }

        try {
            var response = await axios.get(this.transport_url + "/v3/mobile/user." + this.userID, {headers: {"content-type": "application/json", "user-agent": USERAGENT, "Authorization": "Basic " + this.nestAPIToken}, data: ""})
            if (typeof response.status != "number" || response.status != 200) {
                throw new Error("Nest API HTTP get failed with error");
            }

            this.rawData = response.data;    // Used to generate subscribed versions/times

            // Fetch other details for any doorbells/cameras we have, such as activity zones etc. We'll merge this into the Nest structure for processing
            this.rawData.quartz && await Promise.all(Object.entries(this.rawData.quartz).map(async ([camera_uuid]) => {
                this.rawData.quartz[camera_uuid].nexus_api_nest_domain_host = this.rawData.quartz[camera_uuid].nexus_api_http_server_url.replace(/dropcam.com/ig, this.CAMERAAPIHOST);  // avoid extra API call to get this detail by simple domain name replace
                this.rawData.quartz[camera_uuid].activity_zones = [];  // no activity zones yet
                this.rawData.quartz[camera_uuid].alerts = [];  // no active alerts yet
                this.rawData.quartz[camera_uuid].properties = [];  // no properties yet

                // Get doorbell/camera activity zone details
                try {
                    var response = await axios.get(this.rawData.quartz[camera_uuid].nexus_api_nest_domain_host + "/cuepoint_category/" + camera_uuid, {headers: {"user-agent": USERAGENT, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: NESTAPITIMEOUT, retry: 3, retryDelay: 1000})
                    if (typeof response.status != "number" || response.status != 200) {
                        throw new Error("Nest Camera API HTTP get failed with error");
                    }
      
                    // Insert activity zones into the nest structure
                    response.data.forEach((zone) => {
                        if (zone.type.toUpperCase() == "ACTIVITY" || zone.type.toUpperCase() == "REGION") {
                            this.rawData.quartz[camera_uuid].activity_zones.push({"id" : zone.id, "name" : this.#validateHomeKitName(zone.label), "hidden" : zone.hidden, "uri" : zone.nexusapi_image_uri});
                        }
                    });
                } 
                catch (error) {
                }

                // Get doorbell/camera properties
                try {
                    var response = await axios.get("https://webapi." + this.CAMERAAPIHOST + "/api/cameras.get_with_properties?uuid=" + camera_uuid, {headers: {"user-agent": USERAGENT, "Referer" : "https://" + this.REFERER, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: NESTAPITIMEOUT, retry: 3, retryDelay: 1000})
                    if (typeof response.status != "number" || response.status != 200) {
                        throw new Error("Nest Camera API HTTP get failed with error");
                    }

                    // Insert extra camera properties into the nest structure. We need information from this to use with HomeKit Secure Video
                    this.rawData.quartz[camera_uuid].properties = response.data.items[0].properties;
                } 
                catch (error) {
                }
            }));

            // Get weather data. We'll merge this into the Nest structure for processing
            this.rawData.structure && await Promise.all(Object.entries(this.rawData.structure).map(async ([structure_id, data]) => {
                this.rawData.structure[structure_id].weather = {}; // We'll store Weather data here under the exising structure
                if (this.weather_url != "" && data.latitude > -90 && data.latitude < 90 && data.longitude > -180 && data.longitude < 180) {
                    try {
                        var response = await axios.get(this.weather_url + data.latitude + "," + data.longitude, {headers: {"user-agent": USERAGENT, timeout: 10000}})
                        if (typeof response.status != "number" || response.status != 200) {
                            throw new Error("Nest Weather API HTTP get failed with error");
                        }

                        this.rawData.structure[structure_id].weather.current_temperature = this.#adjustTemperature(response.data[data.latitude + "," + data.longitude].current.temp_f, "F", "C", false);
                        this.rawData.structure[structure_id].weather.current_temperature = this.#adjustTemperature(response.data[data.latitude + "," + data.longitude].current.temp_c, "C", "C", false);
                        this.rawData.structure[structure_id].weather.current_humidity = response.data[data.latitude + "," + data.longitude].current.humidity;
                        this.rawData.structure[structure_id].weather.condition = response.data[data.latitude + "," + data.longitude].current.condition;
                        this.rawData.structure[structure_id].weather.wind_direction = response.data[data.latitude + "," + data.longitude].current.wind_dir;
                        this.rawData.structure[structure_id].weather.wind_speed = (response.data[data.latitude + "," + data.longitude].current.wind_mph * 1.609344);    // convert to km/h
                        this.rawData.structure[structure_id].weather.sunrise = response.data[data.latitude + "," + data.longitude].current.sunrise;
                        this.rawData.structure[structure_id].weather.sunset = response.data[data.latitude + "," + data.longitude].current.sunset;
                        this.rawData.structure[structure_id].weather.station = response.data[data.latitude + "," + data.longitude].location.short_name;
                        this.rawData.structure[structure_id].weather.forecast = response.data[data.latitude + "," + data.longitude].forecast.daily[0].condition;
                        this.rawData.structure[structure_id].weather.elevation = 0;  // Can be feed in via config
                    } 
                    catch (error) {
                    }
                }
            }));
        }
        catch (error) {
        }
    }

    processData() {
        var devices = {};

        this.rawData.device && Object.entries(this.rawData.device).forEach(([nestStructureID, thermostat]) => {
            // process thermostats
            thermostat.serial_number = thermostat.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = thermostat.mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);

            var tempDevice = {};
            tempDevice.excluded = (config.deviceOptions.Global.Exclude == true && (typeof config.deviceOptions[thermostat.serial_number] == "undefined" || typeof config.deviceOptions[thermostat.serial_number] == "object" && typeof config.deviceOptions[thermostat.serial_number].Exclude == "undefined")) || (typeof config.deviceOptions[thermostat.serial_number] == "object" && typeof config.deviceOptions[thermostat.serial_number].Exclude == "boolean" && config.deviceOptions[thermostat.serial_number].Exclude == true);    // Mark device as excluded or not
            tempDevice.device_type = NestDeviceType.THERMOSTAT;  // nest thermostat
            tempDevice.device_uuid = "device." + nestStructureID;
            tempDevice.manufacturer = ACCESSORYNAME;
            tempDevice.software_version = (typeof thermostat.current_version != "undefined" ? thermostat.current_version.replace(/-/g, ".") : "0.0.0");
            tempDevice.mac_address = tempMACAddress;    // Our created MAC address
            tempDevice.current_humidity = thermostat.current_humidity;
            tempDevice.temperature_scale = thermostat.temperature_scale;
            tempDevice.battery_level = thermostat.battery_level;
            tempDevice.serial_number = thermostat.serial_number;
            tempDevice.removed_from_base = thermostat.nlclient_state.toUpperCase() == "BPD" ? true : false;
            tempDevice.online = this.rawData.track[thermostat.serial_number].online;
            tempDevice.has_fan = thermostat.has_fan;
            tempDevice.has_humidifier = thermostat.has_humidifier;
            tempDevice.has_dehumidifier = thermostat.has_dehumidifier;
            tempDevice.leaf = thermostat.leaf;
            tempDevice.can_cool = this.rawData.shared[thermostat.serial_number].can_cool;
            tempDevice.can_heat = this.rawData.shared[thermostat.serial_number].can_heat;
            tempDevice.description = this.rawData.shared[thermostat.serial_number].hasOwnProperty("name") ? this.#validateHomeKitName(this.rawData.shared[thermostat.serial_number].name) : "";
            tempDevice.target_temperature_type = this.rawData.shared[thermostat.serial_number].target_temperature_type;
            tempDevice.target_change_pending = this.rawData.shared[thermostat.serial_number].target_change_pending;
            tempDevice.target_temperature = this.#adjustTemperature(this.rawData.shared[thermostat.serial_number].target_temperature, "C", "C", true);
            tempDevice.backplate_temperature = this.#adjustTemperature(thermostat.backplate_temperature, "C", "C", true);
            tempDevice.temperature_lock = thermostat.temperature_lock;
            tempDevice.temperature_lock_pin_hash = thermostat.temperature_lock_pin_hash;
            tempDevice.model = "Thermostat";
            if (thermostat.serial_number.substring(0,2) == "15") tempDevice.model = "Thermostat E";  // Nest Thermostat E
            if (thermostat.serial_number.substring(0,2) == "09") tempDevice.model = "Thermostat 3rd Generation";  // Nest Thermostat 3rd Gen
            if (thermostat.serial_number.substring(0,2) == "02") tempDevice.model = "Thermostat 2nd Generation";  // Nest Thermostat 2nd Gen
            if (thermostat.serial_number.substring(0,2) == "01") tempDevice.model = "Thermostat 1st Generation";  // Nest Thermostat 1st Gen

            // Work out the current mode on the thermostat
            if (thermostat.eco.mode.toUpperCase() == "AUTO-ECO" || thermostat.eco.mode.toUpperCase() == "MANUAL-ECO") {
                // thermostat is running in "eco" mode, we'll override the target temps to be that of eco mode ones
                // also define a new hvac mode of "eco"
                tempDevice.target_temperature_high = this.#adjustTemperature(thermostat.away_temperature_high, "C", "C", true);
                tempDevice.target_temperature_low = this.#adjustTemperature(thermostat.away_temperature_low, "C", "C", true);
                if (thermostat.away_temperature_high_enabled == true && thermostat.away_temperature_low_enabled == true) {
                    // eco range
                    tempDevice.hvac_mode = "eco";
                    tempDevice.target_temperature_type = "range"
                }
                if (thermostat.away_temperature_high_enabled == true && thermostat.away_temperature_low_enabled == false) {
                    // eco cool
                    tempDevice.hvac_mode = "eco";
                    tempDevice.target_temperature_type = "cool"
                    tempDevice.target_temperature = tempDevice.target_temperature_high;
                }
                if (thermostat.away_temperature_high_enabled == false && thermostat.away_temperature_low_enabled == true) {
                    // eco heat
                    tempDevice.hvac_mode = "eco";
                    tempDevice.target_temperature_type = "heat"
                    tempDevice.target_temperature = tempDevice.target_temperature_low;
                }
                if (thermostat.away_temperature_high_enabled == false && thermostat.away_temperature_low_enabled == false) {
                    // eco off or just off??
                    tempDevice.hvac_mode = "off";
                    tempDevice.target_temperature_type = "off"
                }
            }
            else {
                // Just a normal mode, ie: not eco type
                tempDevice.target_temperature_high = this.#adjustTemperature(this.rawData.shared[thermostat.serial_number].target_temperature_high, "C", "C", true);
                tempDevice.target_temperature_low = this.#adjustTemperature(this.rawData.shared[thermostat.serial_number].target_temperature_low, "C", "C", true);
                tempDevice.hvac_mode = this.rawData.shared[thermostat.serial_number].target_temperature_type;
            }
        
            // Work out current state ie: heating, cooling etc
            if (this.rawData.shared[thermostat.serial_number].hvac_heater_state == true || this.rawData.shared[thermostat.serial_number].hvac_heat_x2_state == true || 
                this.rawData.shared[thermostat.serial_number].hvac_heat_x3_state == true || this.rawData.shared[thermostat.serial_number].hvac_aux_heater_state == true || 
                this.rawData.shared[thermostat.serial_number].hvac_alt_heat_x2_state == true || this.rawData.shared[thermostat.serial_number].hvac_emer_heat_state == true ||
                this.rawData.shared[thermostat.serial_number].hvac_alt_heat_state == true) {
                
                // A heating source is on, so we're in heating mode
                tempDevice.hvac_state = "heating";
            }
            if (this.rawData.shared[thermostat.serial_number].hvac_ac_state == true || this.rawData.shared[thermostat.serial_number].hvac_cool_x2_state == true || this.rawData.shared[thermostat.serial_number].hvac_cool_x3_state == true) {
                
                // A cooling source is on, so we're in cooling mode
                tempDevice.hvac_state = "cooling";
            }
            if (this.rawData.shared[thermostat.serial_number].hvac_heater_state == false && this.rawData.shared[thermostat.serial_number].hvac_heat_x2_state == false && 
                this.rawData.shared[thermostat.serial_number].hvac_heat_x3_state == false && this.rawData.shared[thermostat.serial_number].hvac_aux_heater_state == false && 
                this.rawData.shared[thermostat.serial_number].hvac_alt_heat_x2_state == false && this.rawData.shared[thermostat.serial_number].hvac_emer_heat_state == false &&
                this.rawData.shared[thermostat.serial_number].hvac_alt_heat_state == false && this.rawData.shared[thermostat.serial_number].hvac_ac_state == false &&
                this.rawData.shared[thermostat.serial_number].hvac_cool_x2_state == false && this.rawData.shared[thermostat.serial_number].hvac_cool_x3_state == false) {
                
                // No heating or cooling sources are on, so we're in off mode
                tempDevice.hvac_state = "off";
            }

            // Update fan status, on or off
            tempDevice.fan_duration = thermostat.fan_timer_duration;   // default runtime for fan
            tempDevice.fan_state = thermostat.fan_timer_timeout > 0 ? true : false;

            // Humidifier/dehumidifier details
            tempDevice.target_humidity = thermostat.target_humidity;
            tempDevice.humidifier_state = thermostat.humidifier_state;
            tempDevice.dehumidifier_state = thermostat.dehumidifier_state;
    
            // Get device location name
            tempDevice.location = "";
            this.rawData.where[this.rawData.link[thermostat.serial_number].structure.split(".")[1]].wheres.forEach((where) => {
                if (thermostat.where_id == where.where_id) {
                    tempDevice.location = this.#validateHomeKitName(where.name);
                }
            });

            // If the device description is empty, use the location as the description
            if (tempDevice.description == "") {
                tempDevice.description = tempDevice.location;
                tempDevice.location = "";   // Clear location name
            }
            
            tempDevice.away = this.rawData.structure[this.rawData.link[thermostat.serial_number].structure.split(".")[1]].away;    // away status
            tempDevice.vacation_mode = this.rawData.structure[this.rawData.link[thermostat.serial_number].structure.split(".")[1]].vacation_mode;  // vacation mode
            tempDevice.home_name = this.#validateHomeKitName(this.rawData.structure[this.rawData.link[thermostat.serial_number].structure.split(".")[1]].name);  // Home name
            tempDevice.belongs_to_structure = this.rawData.link[thermostat.serial_number].structure.split(".")[1]; // structure ID
            tempDevice.active_rcs_sensor = "";
            tempDevice.active_temperature = this.#adjustTemperature(thermostat.backplate_temperature, "C", "C", true);  // already adjusted temperature
            tempDevice.linked_rcs_sensors = [];

            // Hot water
            tempDevice.hot_water_active = thermostat.hot_water_active;
            tempDevice.hot_water_boiling_state = thermostat.hot_water_boiling_state;
            tempDevice.has_hot_water_temperature = thermostat.has_hot_water_temperature;
            tempDevice.has_hot_water_control = tempDevice.has_hot_water_control;

            // Get associated schedules
            tempDevice.schedules = {};
            tempDevice.schedule_mode = "";
            if (typeof this.rawData.schedule[thermostat.serial_number] == "object") {
                Object.entries(this.rawData.schedule[thermostat.serial_number].days).forEach(([day, schedules]) => {
                    Object.entries(schedules).forEach(([id, schedule]) => {
                        // Foix up tempaeratures in the schedule
                        if (schedule.hasOwnProperty("temp") == true) {
                            schedule.temp = this.#adjustTemperature(schedule.temp, "C", "C", true);
                        }
                        if (schedule.hasOwnProperty("temp-min") == true) {
                            schedule["temp-min"] = this.#adjustTemperature(schedule["temp-min"], "C", "C", true);
                        }
                        if (schedule.hasOwnProperty("temp-min") == true) {
                            schedule["temp-max"] = this.#adjustTemperature(schedule["temp-max"], "C", "C", true);
                        }
                    });
                });
                tempDevice.schedules = this.rawData.schedule[thermostat.serial_number].days;
                tempDevice.schedule_mode = this.rawData.schedule[thermostat.serial_number].schedule_mode;
            }

            // Air filter details
            tempDevice.has_air_filter = thermostat.has_air_filter;
            tempDevice.filter_replacement_needed = thermostat.filter_replacement_needed;
            tempDevice.filter_changed_date = thermostat.filter_changed_date;
            tempDevice.filter_replacement_threshold_sec = thermostat.filter_replacement_threshold_sec;

            // Insert any extra options we've read in from configuration file
            tempDevice.EveApp = config.deviceOptions.Global.EveApp;    // Global config option for EveHome App integration. Gets overriden below for thermostat devices
            config.deviceOptions[thermostat.serial_number] && Object.entries(config.deviceOptions[thermostat.serial_number]).forEach(([key, value]) => {
                tempDevice[key] = value;
            });

            // Even if this thermostat is excluded, we need to process any associated temperature sensors
            this.rawData.rcs_settings[thermostat.serial_number].associated_rcs_sensors.forEach((sensor) => {
                this.rawData.kryptonite[sensor.split(".")[1]].associated_thermostat = thermostat.serial_number;

                var sensorInfo = this.rawData.kryptonite[sensor.split(".")[1]];
                sensorInfo.serial_number = sensorInfo.serial_number.toUpperCase();
                if (typeof tempDevice == "object" && (config.deviceOptions.Global.Exclude == true && (typeof config.deviceOptions[sensorInfo.serial_number] == "undefined" || typeof config.deviceOptions[sensorInfo.serial_number] == "object" && typeof config.deviceOptions[sensorInfo.serial_number].Exclude == "undefined")) || (typeof config.deviceOptions[sensorInfo.serial_number] == "object" && typeof config.deviceOptions[sensorInfo.serial_number].Exclude == "boolean" && config.deviceOptions[sensorInfo.serial_number].Exclude == true)) {
                    // Associated temperature sensor isn't excluded
                    tempDevice.linked_rcs_sensors.push(sensorInfo.serial_number);

                    // Is this sensor the active one? If so, get some details about it
                    if (this.rawData.rcs_settings[thermostat.serial_number].active_rcs_sensors.includes(sensor)) {
                        tempDevice.active_rcs_sensor = sensorInfo.serial_number;
                        tempDevice.active_temperature =  this.#adjustTemperature(sensorInfo.current_temperature, "C", "C", true);
                    }
                }
            });

            devices[thermostat.serial_number] = tempDevice;  // Store processed device
        });

        this.rawData.kryptonite && Object.entries(this.rawData.kryptonite).forEach(([nestStructureID, sensor]) => {
            // Process temperature sensors. Needs to be done AFTER thermostat as we inserted some extra details in there
            sensor.serial_number = sensor.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = "18B430" + this.#crc24(sensor.serial_number).toUpperCase(); // Use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off serial number for last 6 digits.
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);
            
            var tempDevice = {};
            tempDevice.excluded = (config.deviceOptions.Global.Exclude == true && (typeof config.deviceOptions[sensor.serial_number] == "undefined" || typeof config.deviceOptions[sensor.serial_number] == "object" && typeof config.deviceOptions[sensor.serial_number].Exclude == "undefined")) || (typeof config.deviceOptions[sensor.serial_number] == "object" && typeof config.deviceOptions[sensor.serial_number].Exclude == "boolean" && config.deviceOptions[sensor.serial_number].Exclude == true);    // Mark device as excluded or not
            tempDevice.device_type = NestDeviceType.TEMPSENSOR;  // nest temperature sensor
            tempDevice.device_uuid = "kryptonite." + nestStructureID;
            tempDevice.manufacturer = ACCESSORYNAME;
            tempDevice.serial_number = sensor.serial_number;
            tempDevice.description = sensor.hasOwnProperty("description") ? this.#validateHomeKitName(sensor.description) : ""; 
            tempDevice.mac_address = tempMACAddress;   // Our created MAC address
            tempDevice.battery_level = sensor.battery_level;
            tempDevice.software_version = "1.0";
            tempDevice.model = "Temperature Sensor";
            tempDevice.current_temperature = this.#adjustTemperature(sensor.current_temperature, "C", "C", true);
            tempDevice.active_sensor = this.rawData.rcs_settings[sensor.associated_thermostat].active_rcs_sensors.includes("kryptonite." + nestStructureID);
            tempDevice.associated_thermostat = sensor.associated_thermostat;

            // Get device location name
            tempDevice.location = "";
            this.rawData.where[sensor.structure_id].wheres.forEach((where) => {
                if (sensor.where_id == where.where_id) {
                    tempDevice.location = this.#validateHomeKitName(where.name);
                }
            });

            // If the device description is empty, use the location as the description
            if (tempDevice.description == "") {
                tempDevice.description = tempDevice.location;
                tempDevice.location = "";   // Clear location name
            }

            tempDevice.online = (Math.floor(Date.now() / 1000) - sensor.last_updated_at) < TEMPSENSORONLINETIMEOUT ? true : false;    // online status for reporting before report sensor offline
            tempDevice.home_name = this.#validateHomeKitName(this.rawData.structure[sensor.structure_id].name);    // Home name
            tempDevice.belongs_to_structure = sensor.structure_id; // structure ID

            // Insert any extra options we've read in from configuration file for this device
            tempDevice.EveApp = config.deviceOptions.Global.EveApp;    // Global config option for EveHome App integration. Gets overriden below for temperature sensor devices
            config.deviceOptions[sensor.serial_number] && Object.entries(config.deviceOptions[sensor.serial_number]).forEach(([key, value]) => {
                tempDevice[key] = value;
            });

            devices[sensor.serial_number] = tempDevice;  // Store processed device
        });

        this.rawData.topaz && Object.entries(this.rawData.topaz).forEach(([nestStructureID, protect]) => {            
            // Process smoke detectors
            protect.serial_number = protect.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = protect.wifi_mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);

            var tempDevice = {};
            tempDevice.excluded = (config.deviceOptions.Global.Exclude == true && (typeof config.deviceOptions[protect.serial_number] == "undefined" || typeof config.deviceOptions[protect.serial_number] == "object" && typeof config.deviceOptions[protect.serial_number].Exclude == "undefined")) || (typeof config.deviceOptions[protect.serial_number] == "object" && typeof config.deviceOptions[protect.serial_number].Exclude == "boolean" && config.deviceOptions[protect.serial_number].Exclude == true);    // Mark device as excluded or not
            tempDevice.device_type = NestDeviceType.SMOKESENSOR;  // nest protect
            tempDevice.device_uuid = "topaz." + nestStructureID;
            tempDevice.manufacturer = ACCESSORYNAME;
            tempDevice.serial_number = protect.serial_number;
            tempDevice.line_power_present = protect.line_power_present;
            tempDevice.wired_or_battery = protect.wired_or_battery;
            tempDevice.battery_level = protect.battery_level;
            tempDevice.battery_health_state = protect.battery_health_state;
            tempDevice.smoke_status = protect.smoke_status;
            tempDevice.co_status = protect.co_status;
            tempDevice.heat_status = protect.heat_status;
            tempDevice.hushed_state = protect.hushed_state;
            tempDevice.ntp_green_led = protect.ntp_green_led_enable;
            tempDevice.ntp_green_led_brightness = protect.ntp_green_led_brightness;   // 1 = low, 2 = medium, 3 = high
            tempDevice.night_light_enable = protect.night_light_enable;
            tempDevice.night_light_brightness = protect.night_light_brightness;   // 1 = low, 2 = medium, 3 = high
            tempDevice.smoke_test_passed = protect.component_smoke_test_passed;
            tempDevice.heat_test_passed = protect.component_temp_test_passed; // Seems heat test component test is always false, so use temp test??
            tempDevice.replacement_date = protect.replace_by_date_utc_secs;
            tempDevice.co_previous_peak = protect.co_previous_peak;
            tempDevice.mac_address = tempMACAddress;  // Our created MAC address
            tempDevice.online = this.rawData.widget_track[protect.thread_mac_address.toUpperCase()].online;
            tempDevice.removed_from_base = protect.removed_from_base;
            tempDevice.latest_alarm_test = protect.latest_manual_test_end_utc_secs;
            tempDevice.self_test_in_progress = this.rawData.safety[protect.structure_id].manual_self_test_in_progress;
            tempDevice.description = protect.hasOwnProperty("description") ? this.#validateHomeKitName(protect.description) : "";
            tempDevice.software_version = (typeof protect.software_version != "undefined" ? protect.software_version.replace(/-/g, ".") : "0.0.0");
            tempDevice.ui_color_state = "grey";
            tempDevice.topaz_hush_key = this.rawData.structure[protect.structure_id].topaz_hush_key;
            if (protect.battery_health_state == 0 && protect.co_status == 0 && protect.smoke_status == 0) tempDevice.ui_color_state = "green";
            if (protect.battery_health_state != 0 || protect.co_status == 1 || protect.smoke_status == 1) tempDevice.ui_color_state = "yellow";
            if (protect.co_status == 2 || protect.smoke_status == 2) tempDevice.ui_color_state = "red";

            tempDevice.model = "Protect";
            if (protect.serial_number.substring(0,2) == "06") tempDevice.model = "Protect 2nd Generation";  // Nest Protect 2nd Gen
            if (protect.serial_number.substring(0,2) == "05") tempDevice.model = "Protect 1st Generation";  // Nest Protect 1st Gen
            if (protect.wired_or_battery == 0) tempDevice.model = tempDevice.model + " (wired)";    // Mains powered
            if (protect.wired_or_battery == 1) tempDevice.model = tempDevice.model + " (battery)";    // Battery powered
        
            // Get device location name
            tempDevice.location = "";
            this.rawData.where[protect.structure_id].wheres.forEach((where) => {
                if (protect.where_id == where.where_id) {
                    tempDevice.location = this.#validateHomeKitName(where.name);
                }
            });

            // If the device description is empty, use the location as the description
            if (tempDevice.description == "") {
                tempDevice.description = tempDevice.location;
                tempDevice.location = "";   // Clear location name
            }

            tempDevice.away = protect.auto_away;   // away status
            tempDevice.vacation_mode = this.rawData.structure[protect.structure_id].vacation_mode;  // vacation mode
            tempDevice.home_name = this.#validateHomeKitName(this.rawData.structure[protect.structure_id].name);  // Home name
            tempDevice.belongs_to_structure = protect.structure_id; // structure ID

            // Insert any extra options we've read in from configuration file for this device
            tempDevice.EveApp = config.deviceOptions.Global.EveApp;    // Global config option for EveHome App integration. Gets overriden below for protect devices
            config.deviceOptions[protect.serial_number] && Object.entries(config.deviceOptions[protect.serial_number]).forEach(([key, value]) => {
                tempDevice[key] = value;
            });

            devices[protect.serial_number] = tempDevice;  // Store processed device
        });

        this.rawData.quartz && Object.entries(this.rawData.quartz).forEach(([nestStructureID, camera]) => {
            // Process doorbell/cameras
            camera.serial_number = camera.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = camera.mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);
            
            var tempDevice = {};
            tempDevice.excluded = (config.deviceOptions.Global.Exclude == true && (typeof config.deviceOptions[camera.serial_number] == "undefined" || typeof config.deviceOptions[camera.serial_number] == "object" && typeof config.deviceOptions[camera.serial_number].Exclude == "undefined")) || (typeof config.deviceOptions[camera.serial_number] == "object" && typeof config.deviceOptions[camera.serial_number].Exclude == "boolean" && config.deviceOptions[camera.serial_number].Exclude == true);    // Mark device as excluded or not
            tempDevice.device_type = camera.camera_type == 12 ? NestDeviceType.DOORBELL : NestDeviceType.CAMERA;  // nest doorbell or camera
            tempDevice.device_uuid = "quartz." + nestStructureID;
            tempDevice.manufacturer = ACCESSORYNAME;
            tempDevice.serial_number = camera.serial_number;
            tempDevice.software_version = (typeof camera.software_version != "undefined" ? camera.software_version.replace(/-/g, ".") : "0.0.0");
            tempDevice.model = camera.model.replace(/nest\s*/ig, "");    // We'll use doorbell/camera model description that Nest supplies
            tempDevice.mac_address = tempMACAddress;  // Our created MAC address;
            tempDevice.last_disconnect_reason = (typeof camera.last_disconnect_reason != "undefined" ? camera.last_disconnect_reason : "");
            tempDevice.description = camera.hasOwnProperty("description") ? this.#validateHomeKitName(camera.description) : "";
            tempDevice.nest_aware = (typeof camera.cvr_enrolled != "undefined" ? ((camera.cvr_enrolled.toUpperCase() != "NONE") ? true : false) : false);  // Does user have an active Nest aware subscription 
            tempDevice.direct_nexustalk_host = camera.direct_nexustalk_host;
            tempDevice.websocket_nexustalk_host = camera.websocket_nexustalk_host;
            tempDevice.streaming_enabled = (camera.streaming_state.includes("enabled") ? true : false);
            tempDevice.nexus_api_http_server_url = camera.nexus_api_http_server_url;
            tempDevice.nexus_api_nest_domain_host = camera.nexus_api_http_server_url.replace(/dropcam.com/ig, this.CAMERAAPIHOST);  // avoid extra API call to get this detail by simple domain name replace
            tempDevice.online = (camera.streaming_state.includes("offline") ? false : true);
            tempDevice.audio_enabled = camera.audio_input_enabled;
            tempDevice.capabilities = camera.capabilities;
            tempDevice.properties = camera.properties;  // structure elements we added
            tempDevice.activity_zones = camera.activity_zones; // structure elements we added
            tempDevice.alerts = camera.alerts; // structure elements we added

            // Get device location name
            tempDevice.location = "";
            this.rawData.where[camera.structure_id].wheres.forEach((where) => {
                if (camera.where_id == where.where_id) {
                    tempDevice.location = this.#validateHomeKitName(where.name);
                }
            });

            // If the device description is empty, use the location as the description
            if (tempDevice.description == "") {
                tempDevice.description = tempDevice.location;
                tempDevice.location = "";   // Clear location name
            }

            tempDevice.away = this.rawData.structure[camera.structure_id].away;    // away status
            tempDevice.vacation_mode = this.rawData.structure[camera.structure_id].vacation_mode;  // vacation mode
            tempDevice.home_name = this.#validateHomeKitName(this.rawData.structure[camera.structure_id].name);  // Home name
            tempDevice.belongs_to_structure = camera.structure_id; // structure ID

            // Insert any extra options we've read in from configuration file for this device
            tempDevice.EveApp = config.deviceOptions.Global.EveApp;    // Global config option for EveHome App integration. Gets overriden below for specific doorbell/camera
            tempDevice.HKSV = config.deviceOptions.Global.HKSV;    // Global config option for HomeKit Secure Video. Gets overriden below for specific doorbell/camera
            tempDevice.H264EncoderRecord = config.deviceOptions.Global.H264EncoderRecord; // Global config option for using H264EncoderRecord. Gets overriden below for specific doorbell/camera
            tempDevice.H264EncoderLive = config.deviceOptions.Global.H264EncoderLive; // Global config option for using H264EncoderLive. Gets overriden below for specific doorbell/camera
            tempDevice.HKSVPreBuffer = config.deviceOptions.Global.HKSVPreBuffer;  // Global config option for HKSV pre buffering size. Gets overriden below for specific doorbell/camera
            tempDevice.DoorbellCooldown = config.deviceOptions.Global.DoorbellCooldown; // Global default for doorbell press cooldown. Gets overriden below for specific doorbell/camera
            tempDevice.MotionCooldown = config.deviceOptions.Global.MotionCooldown; // Global default for motion detected cooldown. Gets overriden below for specific doorbell/camera
            tempDevice.PersonCooldown = config.deviceOptions.Global.PersonCooldown; // Global default for person detected cooldown. Gets overriden below for specific doorbell/camera
            tempDevice.indoor_chime_switch = config.deviceOptions.Global.indoor_chime_switch; // Global default for indoor chime switch on/off. Gets overriden below for specific doorbell
            config.deviceOptions[camera.serial_number] && Object.entries(config.deviceOptions[camera.serial_number]).forEach(([key, value]) => {
                tempDevice[key] = value;
            });
            
            devices[camera.serial_number] = tempDevice;  // Store processed device
        });

        // Make up a virtual weather station data
        this.rawData.structure && Object.entries(this.rawData.structure).forEach(([nestStructureID, structure]) => {
            // Process structure
            var tempMACAddress = "18B430" + this.#crc24(nestStructureID).toUpperCase(); // Use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off structure for last 6 digits.
            var serial_number = tempMACAddress; // Serial number will be the mac address we've created
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);
            
            var tempDevice = {};
            tempDevice.excluded = (config.weather == false); // Mark device as excluded or not
            tempDevice.device_type = NestDeviceType.WEATHER;
            tempDevice.mac_address = tempMACAddress;
            tempDevice.device_uuid = "structure." + nestStructureID;
            tempDevice.manufacturer = ACCESSORYNAME;
            tempDevice.description = this.#validateHomeKitName(structure.location);
            tempDevice.location = "";
            tempDevice.serial_number = serial_number;
            tempDevice.software_version = "1.0.0";
            tempDevice.postal_code = structure.postal_code;
            tempDevice.country_code = structure.country_code;
            tempDevice.city = structure.city;
            tempDevice.state = structure.state;
            tempDevice.latitude = structure.latitude;
            tempDevice.longitude = structure.longitude;
            tempDevice.model = "Weather";

            // Process data we inserted
            tempDevice.current_temperature = structure.weather.current_temperature;
            tempDevice.current_humidity = structure.weather.current_humidity;
            tempDevice.condition = structure.weather.condition;
            tempDevice.wind_direction = structure.weather.wind_direction;
            tempDevice.wind_speed = structure.weather.wind_speed;
            tempDevice.sunrise = structure.weather.sunrise;
            tempDevice.sunset = structure.weather.sunset;
            tempDevice.station = structure.weather.station;
            tempDevice.forecast = structure.weather.forecast;
            tempDevice.elevation = structure.weather.elevation;

            // Insert any extra options we've read in from configuration file for this device
            tempDevice.EveApp = config.deviceOptions.Global.EveApp;    // Global config option for EveHome App integration. Gets overridden below for weather
            config.deviceOptions[serial_number] && Object.entries(config.deviceOptions[serial_number]).forEach(([key, value]) => {
                tempDevice[key] = value;
            });

            devices[serial_number] = tempDevice;  // Store processed device
        });            

        return devices; // Return our processed data
    }

    async subscribe() {
        const SUBSCRIBEKEYS = ["structure", "where", "safety", "device", "shared", "track", "link", "rcs_settings", "schedule", "kryptonite", "topaz", "widget_track", "quartz"];

        var subscribeAgainTimeout = 500;    // 500ms default before we subscribe again

        // Build subscription object for data we want to track
        var subscriptionData = {objects: []};
        Object.entries(this.rawData).filter(([filterKey]) => SUBSCRIBEKEYS.includes(filterKey)).forEach(([mainKey]) => {
            Object.entries(this.rawData[mainKey]).forEach(([subKey]) => {
                subscriptionData.objects.push({"object_key" : mainKey + "." + subKey, "object_revision" : this.rawData[mainKey][subKey]["$version"], "object_timestamp": this.rawData[mainKey][subKey]["$timestamp"]});

                if (mainKey == "quartz" && this.subscribePollingTimers.findIndex( ({ nestDevice, type }) => (nestDevice === mainKey + "." + subKey && type === "alerts")) == -1) {
                    // Need todo something special for cameras to get alerts and zone changes
                    // We'll setup polling loop here if not already running
                    var tempTimer = setInterval(() => {
                        // Do doorbell/camera alerts
                        this.rawData.quartz[subKey] && axios.get(this.rawData.quartz[subKey].nexus_api_nest_domain_host + "/cuepoint/" + subKey + "/2?start_time=" + Math.floor((Date.now() / 1000) - 30), {headers: {"user-agent": USERAGENT, "Referer" : "https://" + this.REFERER, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: CAMERAALERTPOLLING, retry: 3, retryDelay: 1000})
                        .then((response) => {
                            if (typeof response.status != "number" || response.status != 200) {
                                throw new Error("Nest Camera API HTTP get failed with error");
                            }

                            // Filter out any alerts which occured before we started this accessory
                            response.data = response.data.filter(alert => (Math.floor(alert.start_time / 1000) >= this.startTime));
        
                            // Fix up alert zone id's
                            // Appears if no Nest Aware subscription, the zone_id in the associated alert is left blank
                            // We'll assign the alert zone id to '0' ie: main zone in this case
                            response.data.forEach((alert) => {
                                if (alert.zone_ids.length == 0) {
                                    alert.zone_ids = [0];   // Default zone ID ie: main zone
                                }
                            });
                
                            // Insert alerts into the Nest structure, then notify device
                            this.rawData.quartz[subKey].alerts = response.data;
                            
                            this.eventEmitter.emit("quartz." + subKey, HomeKitDevice.UPDATE, {alerts: this.rawData.quartz[subKey].alerts});
                        })
                        .catch((error) => {
                        });
                    }, CAMERAALERTPOLLING);
                    this.subscribePollingTimers.push({nestDevice: "quartz." + subKey, type: "alerts", timer: tempTimer});
                }

                if (mainKey == "quartz" && this.subscribePollingTimers.findIndex( ({ nestDevice, type }) => (nestDevice === mainKey + "." + subKey && type === "zones")) == -1) {
                    var tempTimer = setInterval(() => {
                        // Do doorbell/camera zones
                        this.rawData.quartz[subKey] && axios.get(this.rawData.quartz[subKey].nexus_api_nest_domain_host + "/cuepoint_category/" + subKey, {headers: {"user-agent": USERAGENT, "Referer" : "https://" + this.REFERER, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: CAMERAZONEPOLLING, retry: 3, retryDelay: 1000})
                        .then((response) => {
                            if (typeof response.status != "number" || response.status != 200) {
                                throw new Error("Nest Camera API HTTP get failed with error");
                            }

                            var tempZones = [];
                            response.data.forEach((zone) => {
                                if (zone.hidden == false && (zone.type.toUpperCase() == "ACTIVITY" || zone.type.toUpperCase() == "REGION")) {
                                    tempZones.push({"id": zone.id, "name" : this.#validateHomeKitName(zone.label), "hidden" : zone.hidden, "uri" : zone.nexusapi_image_uri});
                                }
                            });

                            // Insert activity zones into the Nest structure, then notify device
                            this.rawData.quartz[subKey].activity_zones = tempZones;

                            this.eventEmitter.emit("quartz." + subKey, HomeKitDevice.UPDATE, {activity_zones: this.rawData.quartz[subKey].activity_zones});
                        })
                        .catch((error) => {
                        });
                    }, CAMERAZONEPOLLING);
                    this.subscribePollingTimers.push({nestDevice: "quartz." + subKey, type: "zones", timer: tempTimer});
                }

                if (mainKey == "structure" && this.subscribePollingTimers.findIndex( ({ nestDevice, type }) => (nestDevice === mainKey + "." + subKey && type === "weather")) == -1) {
                    var tempTimer = setInterval(() => {
                        if (typeof this.rawData.structure[subKey].weather != "object") this.rawData.structure[subKey].weather = {}; // Weather data will be here
                        axios.get(this.weather_url + this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude, {headers: {"user-agent": USERAGENT, timeout: 10000}})
                        .then((response) => {
                            if (typeof response.status != "number" || response.status != 200) {
                                throw new Error("Nest Weather API HTTP get failed with error");
                            }

                            this.rawData.structure[subKey].weather.current_temperature = this.#adjustTemperature(response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.temp_f, "F", "C", false);
                            this.rawData.structure[subKey].weather.current_temperature = this.#adjustTemperature(response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.temp_c, "C", "C", false);
                            this.rawData.structure[subKey].weather.current_humidity = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.humidity;
                            this.rawData.structure[subKey].weather.condition = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.condition;
                            this.rawData.structure[subKey].weather.wind_direction = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.wind_dir;
                            this.rawData.structure[subKey].weather.wind_speed = (response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.wind_mph * 1.609344);    // convert to km/h
                            this.rawData.structure[subKey].weather.sunrise = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.sunrise;
                            this.rawData.structure[subKey].weather.sunset = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.sunset;
                            this.rawData.structure[subKey].weather.station = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].location.short_name;
                            this.rawData.structure[subKey].weather.forecast = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].forecast.daily[0].condition;

                            this.eventEmitter.emit("structure." + subKey, HomeKitDevice.UPDATE, {weather: this.rawData.structure[subKey].weather});
                        })
                        .catch((error) => {
                        });
                    }, WEATHERPOLLING);
                    this.subscribePollingTimers.push({nestDevice: "structure." + subKey, type: "weather", timer: tempTimer});
                }
            });
        });


        // Do subscription for the data we need from the Nest structure.
        // We set a Timeout after a certain period of no data received
        // If timed-out, rinse and repeat :-) 
        var addRemoveDevices = [];
        axios({
            method: "post",
            url: this.transport_url + "/v6/subscribe",
            data: JSON.stringify(subscriptionData), 
            headers: {"user-agent": USERAGENT, "Authorization": "Basic " + this.nestAPIToken}, 
            responseType: "json", 
            timeout: SUBSCRIBETIMEOUT,
            signal: this.abortController.signal
        })
        .then(async (response) => {
            if (typeof response.status != "number" || response.status != 200) {
                throw new Error("Nest API HTTP subscribe failed with error");
            }

            // Got subscribed update data, so merge and process them
            response.data.objects && await Promise.all(response.data.objects.map(async (updatedData) => {
                var mainKey = updatedData.object_key.split(".")[0];
                var subKey = updatedData.object_key.split(".")[1];

                // See if we have a structure change and the "swarm" property list has changed, seems to indicated a new or removed device(s)
                if (mainKey == "structure" && updatedData.value.swarm && this.rawData[mainKey][subKey].swarm.toString() !== updatedData.value.swarm.toString()) {
                    var oldDeviceList = this.rawData[mainKey][subKey].swarm.toString().split(",").map(String);
                    var newDeviceList = updatedData.value.swarm.toString().split(",").map(String);
                    for (var index in oldDeviceList) {
                        if (newDeviceList.includes(oldDeviceList[index]) == false && oldDeviceList[index] != "") {
                            addRemoveDevices.push({"nestDevice": oldDeviceList[index], "action" : "remove"});    // Removed device
                        }
                    }
                    for (index in newDeviceList) {
                        if (oldDeviceList.includes(newDeviceList[index]) == false && newDeviceList[index] != "") {
                            addRemoveDevices.push({"nestDevice": newDeviceList[index], "action" : "add"});    // Added device
                        }
                    }
                    addRemoveDevices = addRemoveDevices.sort((a, b) => a - b);  // filter out duplicates
                } else {
                    // Update internally saved Nest structure for the remaining changed key/value pairs
                    for (const [fieldKey, fieldValue] of Object.entries(updatedData.value)) {
                        this.rawData[mainKey][subKey][fieldKey] = fieldValue;
                    }

                    if (mainKey == "quartz") {
                        // We've had a "quartz" structure change, so need to update doorbell/camera properties
                        await axios.get("https://webapi." + this.CAMERAAPIHOST + "/api/cameras.get_with_properties?uuid=" + subKey, {headers: {"user-agent": USERAGENT, "Referer" : "https://" + this.REFERER, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: NESTAPITIMEOUT})
                        .then((response) => {
                            if (typeof response.status != "number" || response.status != 200) {
                                throw new Error("Nest Camera API HTTP get failed with error");
                            }

                            this.rawData[mainKey][subKey].properties = response.data.items[0].properties;
                        })
                        .catch((error) => {
                        });
                    }

                    // Update verion and timestamp of this structure element for future subscribe calls
                    this.rawData[mainKey][subKey]["$version"] = updatedData.object_revision;
                    this.rawData[mainKey][subKey]["$timestamp"] = updatedData.object_timestamp;
                }
            }));
            
            if (addRemoveDevices.length > 0) {
                // Change in devices via an addition or removal, so get current Nest structure data before we process any device changes
                await this.getData();
            }

            // Process any device updates and additions here
            Object.entries(this.processData()).forEach(([deviceID, deviceData]) => {
                var addRemoveIndex = addRemoveDevices.findIndex( ({ nestDevice }) => nestDevice === deviceData.device_uuid)
                if (addRemoveIndex == -1) {
                    // Send current data to the HomeKit accessory for processing
                    // The accessory will determine if data has changed compared to what it has stored
                    this.eventEmitter.emit(deviceData.device_uuid, HomeKitDevice.UPDATE, deviceData);
                } else if (addRemoveIndex != -1 && addRemoveDevices[addRemoveIndex].action == "add") {
                    // Device addition to process
                    config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Detected additional Nest device");
                    this.eventEmitter.emit(SystemEvent.ADD, deviceData);    // new device, so process addition to HomeKit
                }
            });

            // Process any device removals here
            addRemoveDevices.forEach((device) => {
                if (device.action == "remove") {
                    config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Detected removal of Nest device");

                    // Remove any polling timers that might have been associated with this device
                    this.subscribePollingTimers.forEach((pollingTimer) => {
                        if (pollingTimer.nestDevice == device.nestDevice) {
                            clearInterval(pollingTimer.timer)
                        }
                    });

                    this.eventEmitter.emit(device.nestDevice, HomeKitDevice.REMOVE, {});    // this will handle removal without knowing previous data for device
                }
            });
        })
        .catch((error) => {
            if (axios.isCancel(error) == false && error.code !== "ECONNABORTED" && error.code !== "ETIMEDOUT") {
                if (error.response && error.response.status == 404) {
                    // URL not found
                    subscribeAgainTimeout = 5000;   // Since bad URL, try again after 5 seconds
                    config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Nest subscription failed. URL not found");
                } else if (error.response && error.response.status == 400) {
                    // bad subscribe
                    subscribeAgainTimeout = 5000;   // Since bad subscribe, try again after 5 seconds
                    config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Nest subscription failed. Bad subscription data");
                } else if (error.response && error.response.status == 502) {
                    // gateway error
                    subscribeAgainTimeout = 10000;  // Since bad gateway error, try again after 10 seconds
                    config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Nest subscription failed. Bad gateway");
                } else {
                    // Other unknown error  
                    subscribeAgainTimeout = 5000;   // Try again afer 5 seconds
                    config.debug.includes(Debugging.NEST) && outputLogging(ACCESSORYNAME, true, "Nest subscription failed with error");
                }
            }
        })
        .finally(() => {
            // subscribe again after delay :-)
            setTimeout(this.subscribe.bind(this), subscribeAgainTimeout);
        });
    }

    async #set(deviceUUID, keyValues) {
        if (typeof deviceUUID != "string" || typeof keyValues != "object" || typeof this.nestAPIToken != "string" || typeof this.transport_url != "string" ||
            deviceUUID == "" || this.nestAPIToken == "" || this.transport_url == "") {
            return;
        }

        await Promise.all(Object.entries(keyValues).map(async ([nestStuctureKey, nestStructureValues]) => {
            if (nestStuctureKey == "quartz") {
                // request is to set a doorbell/camera property. Handle here
                await Promise.all(Object.entries(nestStructureValues).map(async ([key, value]) => {
                    await axios.post("https://webapi." + this.CAMERAAPIHOST + "/api/dropcams.set_properties", [key] + "=" + value + "&uuid=" + deviceUUID.split(".")[1], {headers: {"content-type": "application/x-www-form-urlencoded", "user-agent": USERAGENT, "Referer" : "https://" + this.REFERER, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json"})
                    .then((response) => {
                        if (typeof response.status != "number" || response.status != 200 || typeof response.data.status != "number" || response.data.status != 0) {
                            throw new Error("Nest Camera API HTTP post failed with error");
                        }
                    })
                    .catch((error) => {
                    });        
                }));
            }

            if (nestStuctureKey != "quartz") {
                // request is to set a Nest device structure element. Handle here
                var put = {objects: []};
                Object.entries(nestStructureValues).forEach(([key, value]) => {
                    if (nestStuctureKey == "structure" && typeof this.rawData.structure[this.rawData.link[deviceUUID.split(".")[1]].structure.split(".")[1]] == "object") {
                        put.objects.push({"object_key" : this.rawData.link[deviceUUID.split(".")[1]].structure, "op" : "MERGE", "value": {[key]: value}});
                    }
                    if (nestStuctureKey != "structure") {
                        put.objects.push({"object_key" : nestStuctureKey + "." + deviceUUID.split(".")[1], "op" : "MERGE", "value": {[key]: value}});
                    }
                });
                await axios.post(this.transport_url + "/v5/put", JSON.stringify(put), {headers: {"user-agent": USERAGENT, "Authorization": "Basic " + this.nestAPIToken} })
                .then((response) => {
                    if (typeof response.status != "number" || response.status != 200) {
                        throw new Error("Nest API HTTP post failed with error");
                    }
                })
                .catch((error) => {
                });
            }
        }));
    }

    async #get(deviceUUID) {
        // <---- To Implement
    }

    #adjustTemperature(temperature, currentTemperatureUnit, targetTemperatureUnit, round) {
        // Converts temperatures between C/F and vice-versa. 
        // Also rounds temperatures to 0.5 increments for C and 1.0 for F
        if (targetTemperatureUnit == "C" || targetTemperatureUnit == "c" || targetTemperatureUnit == HAP.Characteristic.TemperatureDisplayUnits.CELSIUS) {
            if (currentTemperatureUnit == "F" || currentTemperatureUnit == "f" || currentTemperatureUnit == HAP.Characteristic.TemperatureDisplayUnits.FAHRENHEIT) {
                // convert from F to C
                temperature = (temperature - 32) * 5 / 9;
            }
            if (round == true) {
                // round to nearest 0.5C
                temperature = Math.round(temperature * 2) / 2;
            }
        }

        if (targetTemperatureUnit == "F" || targetTemperatureUnit == "f" || targetTemperatureUnit == HAP.Characteristic.TemperatureDisplayUnits.FAHRENHEIT) {
            if (currentTemperatureUnit == "C" || currentTemperatureUnit == "c" || currentTemperatureUnit == HAP.Characteristic.TemperatureDisplayUnits.CELSIUS) {
                // convert from C to F
                temperature = (temperature * 9 / 5) + 32;
            }
            if (round == true) {
                // round to nearest 1F
                temperature = Math.round(temperature);
            }
        }

        return temperature;
    }

    #validateHomeKitName(nameToMakeValid) {
        // Strip invalid characters to meet HomeKit naming requirements
        // Ensure only letters or numbers are at the beginning AND/OR end of string
        return nameToMakeValid.replace(/[^A-Za-z0-9 ,.-]/g, "").replace(/^[^a-zA-Z0-9]*/g, "").replace(/[^a-zA-Z0-9]+$/g, "");
    }

    #crc24(valueToHash) {
        var crc24HashTable = [
            0x000000, 0x864cfb, 0x8ad50d, 0x0c99f6, 0x93e6e1, 0x15aa1a, 0x1933ec, 0x9f7f17, 
            0xa18139, 0x27cdc2, 0x2b5434, 0xad18cf, 0x3267d8, 0xb42b23, 0xb8b2d5, 0x3efe2e, 
            0xc54e89, 0x430272, 0x4f9b84, 0xc9d77f, 0x56a868, 0xd0e493, 0xdc7d65, 0x5a319e, 
            0x64cfb0, 0xe2834b, 0xee1abd, 0x685646, 0xf72951, 0x7165aa, 0x7dfc5c, 0xfbb0a7, 
            0x0cd1e9, 0x8a9d12, 0x8604e4, 0x00481f, 0x9f3708, 0x197bf3, 0x15e205, 0x93aefe, 
            0xad50d0, 0x2b1c2b, 0x2785dd, 0xa1c926, 0x3eb631, 0xb8faca, 0xb4633c, 0x322fc7, 
            0xc99f60, 0x4fd39b, 0x434a6d, 0xc50696, 0x5a7981, 0xdc357a, 0xd0ac8c, 0x56e077, 
            0x681e59, 0xee52a2, 0xe2cb54, 0x6487af, 0xfbf8b8, 0x7db443, 0x712db5, 0xf7614e, 
            0x19a3d2, 0x9fef29, 0x9376df, 0x153a24, 0x8a4533, 0x0c09c8, 0x00903e, 0x86dcc5, 
            0xb822eb, 0x3e6e10, 0x32f7e6, 0xb4bb1d, 0x2bc40a, 0xad88f1, 0xa11107, 0x275dfc, 
            0xdced5b, 0x5aa1a0, 0x563856, 0xd074ad, 0x4f0bba, 0xc94741, 0xc5deb7, 0x43924c, 
            0x7d6c62, 0xfb2099, 0xf7b96f, 0x71f594, 0xee8a83, 0x68c678, 0x645f8e, 0xe21375, 
            0x15723b, 0x933ec0, 0x9fa736, 0x19ebcd, 0x8694da, 0x00d821, 0x0c41d7, 0x8a0d2c, 
            0xb4f302, 0x32bff9, 0x3e260f, 0xb86af4, 0x2715e3, 0xa15918, 0xadc0ee, 0x2b8c15, 
            0xd03cb2, 0x567049, 0x5ae9bf, 0xdca544, 0x43da53, 0xc596a8, 0xc90f5e, 0x4f43a5, 
            0x71bd8b, 0xf7f170, 0xfb6886, 0x7d247d, 0xe25b6a, 0x641791, 0x688e67, 0xeec29c, 
            0x3347a4, 0xb50b5f, 0xb992a9, 0x3fde52, 0xa0a145, 0x26edbe, 0x2a7448, 0xac38b3, 
            0x92c69d, 0x148a66, 0x181390, 0x9e5f6b, 0x01207c, 0x876c87, 0x8bf571, 0x0db98a, 
            0xf6092d, 0x7045d6, 0x7cdc20, 0xfa90db, 0x65efcc, 0xe3a337, 0xef3ac1, 0x69763a, 
            0x578814, 0xd1c4ef, 0xdd5d19, 0x5b11e2, 0xc46ef5, 0x42220e, 0x4ebbf8, 0xc8f703, 
            0x3f964d, 0xb9dab6, 0xb54340, 0x330fbb, 0xac70ac, 0x2a3c57, 0x26a5a1, 0xa0e95a, 
            0x9e1774, 0x185b8f, 0x14c279, 0x928e82, 0x0df195, 0x8bbd6e, 0x872498, 0x016863, 
            0xfad8c4, 0x7c943f, 0x700dc9, 0xf64132, 0x693e25, 0xef72de, 0xe3eb28, 0x65a7d3, 
            0x5b59fd, 0xdd1506, 0xd18cf0, 0x57c00b, 0xc8bf1c, 0x4ef3e7, 0x426a11, 0xc426ea, 
            0x2ae476, 0xaca88d, 0xa0317b, 0x267d80, 0xb90297, 0x3f4e6c, 0x33d79a, 0xb59b61, 
            0x8b654f, 0x0d29b4, 0x01b042, 0x87fcb9, 0x1883ae, 0x9ecf55, 0x9256a3, 0x141a58, 
            0xefaaff, 0x69e604, 0x657ff2, 0xe33309, 0x7c4c1e, 0xfa00e5, 0xf69913, 0x70d5e8, 
            0x4e2bc6, 0xc8673d, 0xc4fecb, 0x42b230, 0xddcd27, 0x5b81dc, 0x57182a, 0xd154d1, 
            0x26359f, 0xa07964, 0xace092, 0x2aac69, 0xb5d37e, 0x339f85, 0x3f0673, 0xb94a88, 
            0x87b4a6, 0x01f85d, 0x0d61ab, 0x8b2d50, 0x145247, 0x921ebc, 0x9e874a, 0x18cbb1, 
            0xe37b16, 0x6537ed, 0x69ae1b, 0xefe2e0, 0x709df7, 0xf6d10c, 0xfa48fa, 0x7c0401, 
            0x42fa2f, 0xc4b6d4, 0xc82f22, 0x4e63d9, 0xd11cce, 0x575035, 0x5bc9c3, 0xdd8538
        ]
        var crc24 = 0xb704ce; // init crc24 hash;
        valueToHash = Buffer.from(valueToHash);    // convert value into buffer for processing
        for (var index = 0; index < valueToHash.length; index++) {
            crc24 = (crc24HashTable[((crc24 >> 16) ^ valueToHash[index]) & 0xff] ^ (crc24 << 8)) & 0xffffff;
        }
        return crc24.toString(16);    // return crc24 as hex string
    }
}


// Configuration class
//
// Handles system configuration file
const CONFIGURATIONFILE = "Nest_config.json";           // Default configuration file name, located in current directory

// Available debugging output options
const Debugging = {
    NONE : "none",
    NEST : "nest",
    NEXUS : "nexus",
    FFMPEG : "ffmpeg",
    HKSV : "hksv",
    EXTERNAL : "external",
    WEATHER : "weather",
    HISTORY : "history"
}

class Configuration {
    constructor(configurationFile) {
        this.loaded = false;                            // Have we loaded a configuration
        this.configurationFile = "";                    // Saved configuration file path/name once loaded
        this.debug = [Debugging.NONE];                  // Debug output, off by default
        this.fieldTest = false;                         // Fieldtest (FT) APIs/Account, off by default
        this.token = "";                                // Token to access Nest system. Can be either a session token or google cookie token
        this.tokenType = "";                            // Type of token we're using, either be "nest" or "google"
        this.weather = false;                           // Create a virtual weather station using Nest weather data
        this.mDNS = HAP.MDNSAdvertiser.BONJOUR;         // Default mDNS advertiser for HAP-NodeJS library
        this.deviceOptions = {};                        // Configuration options per device. Key of

        // Load configuration
        if (typeof configurationFile != "string" || configurationFile == "" || fs.existsSync(configurationFile) == false) {
            return;
        }

        try {
            var config = JSON.parse(fs.readFileSync(configurationFile));
            this.loaded = true; // Loaded
            this.configurationFile = configurationFile; // Save the name

            // Global default options for all devices
            this.deviceOptions.Global = {};
            this.deviceOptions.Global.HKSV = false;                             // Enable HKSV for all camera/doorbells. HKSV is disabled by default
            this.deviceOptions.Global.HKSVPreBuffer = 15000;                    // Milliseconds to hold in buffer. default is 15secs. using 0 disables pre-buffer
            this.deviceOptions.Global.DoorbellCooldown = 60000;                 // Default cooldown period for doorbell button press (1min/60secs)
            this.deviceOptions.Global.MotionCooldown = 60000;                   // Default cooldown period for motion detected (1min/60secs)
            this.deviceOptions.Global.PersonCooldown = 120000;                  // Default cooldown person for person detected (2mins/120secs)
            this.deviceOptions.Global.H264EncoderRecord = VideoCodecs.LIBX264;  // Default H264 Encoder for HKSV recording
            this.deviceOptions.Global.H264EncoderLive = VideoCodecs.COPY;       // Default H264 Encoder for HomeKit/HKSV live video
            this.deviceOptions.Global.EveApp = true;                            // Integration with evehome app
            this.deviceOptions.Global.Exclude = false;                          // By default, we don't exclude all devices
            this.deviceOptions.Global.indoor_chime_switch = false;              // By default, we don't expose the switch to toggle indoor chiming on/off for doorbells

            Object.entries(config).forEach(([key, value]) => {
                // Global options if not an object
                if (key == "SessionToken" && typeof value == "string" && value != "") {
                    this.tokenType = "nest";
                    this.token = value.trim();  // Nest accounts Session token to use for Nest API calls
                }
                if (key == "GoogleToken" && typeof value == "object" && value.hasOwnProperty("issuetoken") == true && value.hasOwnProperty("cookie") == true && typeof value.issuetoken == "string" && value.issuetoken != "" && typeof value.cookie == "string" && value.cookie != "") {
                    this.tokenType = "google";
                    this.token = {};
                    this.token.issuetoken = value.issuetoken.trim();    // Google issue token to use for Nest API calls
                    this.token.cookie = value.cookie.trim()    // Google cookie to use for Nest API calls
                }
                if (key == "FieldTest" && typeof value == "boolean" && value != "") {
                    this.fieldTest = value;  // Fieldtest (FT) account and APIs
                }
                if (key == "Weather" && typeof value == "boolean") {
                    this.weather = value;    // Virtual weather station
                }
                if (key == "mDNS" && typeof value == "string" & value != "") {
                    if (value.trim().toUpperCase() == "CIAO") this.mDNS = HAP.MDNSAdvertiser.CIAO;    // Use ciao as the mDNS advertiser
                    if (value.trim().toUpperCase() == "BONJOUR") this.mDNS = HAP.MDNSAdvertiser.BONJOUR;    // Use bonjour as the mDNS advertiser
                    if (value.trim().toUpperCase() == "AVAHI") this.mDNS = HAP.MDNSAdvertiser.AVAHI;    // Use avahi as the mDNS advertiser
                }
                if (key == "Debug") {
                    // Comma delimited string for what we output in debugging
                    var tempDebug = [];
                    var values = value.toString().match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g);
                    values.forEach((debug) => {
                        debug = debug.trim();
                        if (debug.toUpperCase() == "TRUE") tempDebug.push(Debugging.NEST, Debugging.HKSV, Debugging.NEXUS);
                        if (debug.toUpperCase() == "FALSE") tempDebug.push(Debugging.NONE);
                        if (Debugging.hasOwnProperty(debug.toUpperCase()) == true) {
                            tempDebug.push(Debugging[debug.toUpperCase()])
                        }
                    });
                    if (tempDebug.includes(Debugging.NONE) == true) {
                        tempDebug = [Debugging.NONE];
                    }
                    if (tempDebug.length != 0) {
                        this.debug = tempDebug
                    }
                }
                if ((key == "HKSV" || key == "EveApp" || key == "Exclude") && typeof value == "boolean") {
                    // Global HomeKit Secure Video
                    // Global Evehome app integration
                    // Global excluding for all devices by default
                    this.deviceOptions.Global[key] = value;
                }
                if ((key == "HKSVPreBuffer" || key == "DoorbellCooldown" || key == "MotionCooldown" || key == "PersonCooldown") && typeof value == "number") {
                    // Global Cooldown options
                    // Global HKSV pre-buffer sizing
                    if (value < 1000) value = value * 1000;  // If less than 1000, assume seconds value passed in, so convert to milliseconds
                    this.deviceOptions.Global[key] = value;
                }
                if (key != "GoogleToken" && typeof value == "object") {
                    // Since key value is an object, and not an object for a value we expect, asumme its a device configuration for matching serial number
                    this.deviceOptions[key] = {};
                    Object.entries(value).forEach(([subKey, value]) => {
                        if ((subKey == "HKSV" || subKey == "EveApp" || subKey == "Exclude" || subKey == "HumiditySensor") && typeof value == "boolean") {
                            // Per device HomeKit Secure Video
                            // Per device Evehome app integration
                            // Per device excluding
                            // Seperate humidity sensor for this device (Only valid for thermostats)
                            this.deviceOptions[key][subKey] = value;
                        }
                        if ((key == "HKSVPreBuffer" || key == "DoorbellCooldown" || key == "MotionCooldown" || key == "PersonCooldown") && typeof value == "number") {
                            // Cooldown options for this device
                            // HKSV pre-buffer sizing for this device
                            if (value < 1000) value = value * 1000;  // If less than 1000, assume seconds value passed in, so convert to milliseconds
                            this.deviceOptions[key][subKey] = value;
                        }
                        if (subKey.startsWith("External") == true && typeof value == "string" && value != "") {
                            var values = value.match(/(".*?"|[^" ]+)(?=\s* |\s*$)/g);
                            var script = values[0]; // external library name to load
                            var options = values.slice(1);  // options to be passed into the external external library
                            try {
                                this.deviceOptions[key][subKey] = require(script)(...options);  // Try to load external library
                            }
                            catch (error) {    
                            }
                        }
                        if (subKey.startsWith("Option.") && typeof subKey.split(".")[1] != "undefined") {
                            // device options we'll insert into the Nest data for non excluded devices
                            // also allows us to override existing Nest data for the device, such as MAC address etc
                            this.deviceOptions[key][subKey.split(".")[1]] = value;
                        }
                    });
                }
            });
        }
        catch (error) {
        }
    }
}


// General functions  
function processDeviceforHomeKit(deviceData) {
    // adding device into HomeKit based on Nest device types, ignoring excluded devices
    if (typeof deviceData != "object" || deviceData.excluded == true) {
        return;
    }

    if (deviceData.device_type == NestDeviceType.THERMOSTAT) {
        // Nest Thermostat
        var tempDevice = new NestThermostat(deviceData, eventEmitter);
        tempDevice.add("Nest Thermostat", HAP.Accessory.Categories.THERMOSTAT, true);
    }

    if (deviceData.device_type == NestDeviceType.TEMPSENSOR) {
        // Nest Temperature Sensor
        var tempDevice = new NestTemperatureSensor(deviceData, eventEmitter);
        tempDevice.add("Nest Temperature Sensor", HAP.Accessory.Categories.SENSOR, true);
    }

    if (deviceData.device_type == NestDeviceType.SMOKESENSOR) {
        // Nest Protect
        var tempDevice = new NestProtect(deviceData, eventEmitter);
        tempDevice.add("Nest Protect", HAP.Accessory.Categories.SENSOR, true);
    }

    if (deviceData.device_type == NestDeviceType.CAMERA || deviceData.device_type == NestDeviceType.DOORBELL) {
        // Nest Hello and Nest Cam(s)
        // Basically the same 
        var tempDevice = new NestCameraDoorbell(deviceData, eventEmitter);
        tempDevice.add("Nest " + deviceData.model.replace(/\s*(?:\([^()]*\))/ig, ""), (deviceData.device_type == NestDeviceType.DOORBELL ? HAP.Accessory.Categories.VIDEO_DOORBELL : HAP.Accessory.Categories.IP_CAMERA), true)
    }

    if (deviceData.device_type == NestDeviceType.WEATHER) {
        // "Virtual" weather station
        var tempDevice = new NestWeather(deviceData, eventEmitter);
        tempDevice.add("Nest Weather", HAP.Accessory.Categories.SENSOR, true);
    }  
}

// Below taken from https://lifesaver.codes/answer/adding-retry-parameter
axios.interceptors.response.use(undefined, function axiosRetryInterceptor(err) {
    var config = err.config;
    // If config does not exist or the retry option is not set, reject
    if (!config || !config.retry) return Promise.reject(err);
    
    // Set the variable for keeping track of the retry count
    config.__retryCount = config.__retryCount || 0;
    
    // Check if we've maxed out the total number of retries
    if (config.__retryCount >= config.retry) {
        // Reject with the error
        return Promise.reject(err);
    }
    
    // Increase the retry count
    config.__retryCount += 1;
    
    // Create new promise to handle exponential backoff
    var backoff = new Promise(function(resolve) {
        setTimeout(function() {
            resolve();
        }, config.retryDelay || 1);
    });
    
    // Return the promise in which re-calls axios to retry the request
    return backoff.then(function() {
        return axios(config);
    });
});

function scaleValue(value, sourceRangeMin, sourceRangeMax, targetRangeMin, targetRangeMax) {
    if (value < sourceRangeMin) value = sourceRangeMin;
    if (value > sourceRangeMax) value = sourceRangeMax;
    return (value - sourceRangeMin) * (targetRangeMax - targetRangeMin) / (sourceRangeMax - sourceRangeMin) + targetRangeMin;
}

function validateFFMPEGBinary() {
    // Validates if the ffmpeg binary has been compiled to support the required libraries we need for doorbell/camera support
    // <---- TODO ensure also has the right codecs, protocols, muxers etc for what we need
    var ffmpegProcess = child_process.spawnSync(__dirname + "/ffmpeg", ["-version"], { env: process.env });
    if (ffmpegProcess.stdout == null) {
        // Since we didn't get a standard output handle, we'll assume the ffmpeg binary is missing AND/OR failed to start correctly
        return;
    }

    // Determine ffmpeg version
    var ffmpegVersion = ffmpegProcess.stdout.toString().match(/(?:ffmpeg version:(\d+)\.)?(?:(\d+)\.)?(?:(\d+)\.\d+)(.*?)/gmi)[0];

    // Determine what libraries ffmpeg is compiled with
    var matchingLibraries = 0;
    FFMPEGLIBARIES.forEach((libraryName) => {
        if (ffmpegProcess.stdout.toString().includes("--enable-"+libraryName) == true) {
            matchingLibraries++;    // One more found library
        }
    });

    return (matchingLibraries == FFMPEGLIBARIES.length && ffmpegVersion >= FFMPEGVERSION);
}

function outputLogging(accessoryName, useConsoleDebug, ...outputMessage) {
    var timeStamp = String(new Date().getFullYear()).padStart(4, "0") + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0") + " " + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + ":" + String(new Date().getSeconds()).padStart(2, "0");
    if (useConsoleDebug == false) {
        console.log(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
    }
    if (useConsoleDebug == true) {
        console.debug(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
    }
}


// Startup code
var eventEmitter = new EventEmitter();  // Need a global event emitter. Will be used for messaging between our classes we create
outputLogging(ACCESSORYNAME, false, "Starting " +  __filename + " using HAP-NodeJS library v" + HAP.HAPLibraryVersion());

// Validate ffmpeg if present and if so, does it include the required libraries to support doorbells/cameras
if (validateFFMPEGBinary() == false) {
    // ffmpeg binary doesn't support the required libraries we require
    outputLogging(ACCESSORYNAME, false, "The FFmpeg binary in path '%s' does not meet the minimum version required AND/OR does not support the required libraries for doorbell and/or camera usage", (__dirname + "/ffmpeg"));
    outputLogging(ACCESSORYNAME, false, "FFmpeg is required to be at minimun version '%s'", FFMPEGVERSION);
    outputLogging(ACCESSORYNAME, false, "FFmpeg needs to be compiled to include the following libraries:", FFMPEGLIBARIES);
    outputLogging(ACCESSORYNAME, false, "Exiting.");
    return;
}

// Create h264 frames for camera off/offline dynamically in video streams. 
// Only required for non-HKSV video devices, but we'll still create at startup
var commandLine = "-hide_banner -loop 1 -i " + __dirname + "/" + CAMERAOFFLINEJPGFILE + " -vframes 1 -r " + EXPECTEDVIDEORATE + " -y -f h264 -profile:v main " + __dirname + "/" + CAMERAOFFLINEH264FILE;
child_process.spawnSync(__dirname + "/ffmpeg", commandLine.split(" "), { env: process.env });
var commandLine = "-hide_banner -loop 1 -i " + __dirname + "/" + CAMERAOFFJPGFILE + " -vframes 1 -r " + EXPECTEDVIDEORATE + " -y -f h264 -profile:v main " + __dirname + "/" + CAMERAOFFH264FILE;
child_process.spawnSync(__dirname + "/ffmpeg", commandLine.split(" "), { env: process.env });
var commandLine = "-hide_banner -loop 1 -i " + __dirname + "/" + CAMERACONNECTINGJPGFILE + " -vframes 1 -r " + EXPECTEDVIDEORATE + " -y -f h264 -profile:v main " + __dirname + "/" + CAMERACONNECTING264FILE;
child_process.spawnSync(__dirname + "/ffmpeg", commandLine.split(" "), { env: process.env });

// Check to see if a configuration file was passed into use and validate if present
var configurationFile = __dirname + "/" + CONFIGURATIONFILE;
if (process.argv.slice(2).length == 1) {  // We only support/process one argument
    configurationFile = process.argv.slice(2)[0];   // Extract the file name from the argument passed in
    if (configurationFile.indexOf("/") == -1) {
        configurationFile = __dirname + "/" + configurationFile;
    }
}
if (fs.existsSync(configurationFile) == false) {
    // Configuration file, either by default name or specified on commandline is missing
    outputLogging(ACCESSORYNAME, false, "Specified configuration '%s' cannot be found", configurationFile);
    outputLogging(ACCESSORYNAME, false, "Exiting.");
    return;
}

// Have a configuration file, now load the configuration options
outputLogging(ACCESSORYNAME, false, "Configuration will be read from '%s'", configurationFile);
var config = new Configuration(configurationFile); // Load configuration details from specified file.
if (config.loaded == false || config.token == "") {
    outputLogging(ACCESSORYNAME, false, "Configuration file '%s' contains invalid options", configurationFile);
    outputLogging(ACCESSORYNAME, false, "Exiting.");
    return;
}

var nest = new NestSystem(config.fieldTest, config.token, config.tokenType, eventEmitter);
nest.connect()   // Initiate connection to Nest System APIs with either the specified session or refresh tokens
.then(() => {
    if (nest.nestAPIToken != "") {
        outputLogging(ACCESSORYNAME, false, "Getting list of devices assigned to account");
        nest.getData()  // Get data for devices we have in our Nest structure
        .then(() => {
            // Process any discovered Nest devices into HomeKit
            outputLogging(ACCESSORYNAME, false, "Devices will be advertised to HomeKit using '%s' mDNS provider", config.mDNS);

            Object.entries(nest.processData()).forEach(([deviceID, deviceData]) => {
                processDeviceforHomeKit(deviceData);  
            });

            outputLogging(ACCESSORYNAME, false, "Starting subscription for device updates, additions and/or removals");
            nest.eventEmitter.addListener(SystemEvent.ADD, processDeviceforHomeKit); // Notifications for any device additions in Nest structure
            nest.subscribe();  // Start subscription
        });
    }
});