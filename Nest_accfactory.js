// This is a HAP-NodeJS accessory I have developed to allow Nest devices to be used with HomeKit including having support for HomeKit Secure Video on doorbells and camera devices
//
// The following Nest devices are supported
// 
// Nest Thermostats (Gen 1, Gen 2, Gen 3, E)
// Nest Protects (Gen 1, Gen 2)
// Nest Temp Sensors
// Nest Cameras (Cam Indoor, IQ Indoor, Outdoor, IQ Outdoor)
// Nest Hello (Wired Gen 1)
//
// The accessory supports connection to Nest using a Nest account OR a Google (migrated Nest account) account.
//
// Code version 4/11/2022
// Mark Hulskamp

module.exports = accessories = [];

"use strict";

// Define HAP-NodeJS requirements
var HAPNodeJS = require("hap-nodejs");
var Accessory = HAPNodeJS.Accessory; 
var Service = HAPNodeJS.Service;
var Characteristic = HAPNodeJS.Characteristic;
var uuid = HAPNodeJS.uuid;
var DoorbellController = HAPNodeJS.DoorbellController;
var CameraController = HAPNodeJS.CameraController;
var SRTPCryptoSuites = HAPNodeJS.SRTPCryptoSuites;
var HDSProtocolSpecificErrorReason = HAPNodeJS.HDSProtocolSpecificErrorReason;
var H264Profile = HAPNodeJS.H264Profile;
var H264Level = HAPNodeJS.H264Level;
var AudioStreamingCodecType = HAPNodeJS.AudioStreamingCodecType;
var AudioStreamingSamplerate = HAPNodeJS.AudioStreamingSamplerate;
var AudioRecordingCodecType = HAPNodeJS.AudioRecordingCodecType;
var AudioRecordingSamplerate = HAPNodeJS.AudioRecordingSamplerate;
var VideoCodecType = HAPNodeJS.VideoCodecType;
var MediaContainerType = HAPNodeJS.MediaContainerType;
var MDNSAdvertiser = HAPNodeJS.MDNSAdvertiser;

// Define external lbrary requirements
var axios = require("axios");
try {
    // Easier installation of ffmpeg binaries we support
    var ffmpegPath = require("ffmpeg-for-homebridge");
} catch(error) {
    // ffmpeg-for-homebridge isnt installed, so we'll assume ffmpeg will be available in path
    var ffmpegPath = undefined;
}

// Define nodejs module requirements
var EventEmitter = require("events");
var dgram = require("dgram");
var net = require("net");
var ip = require("ip");
var fs = require("fs");
var {spawn} = require("child_process");
var {spawnSync} = require("child_process");

// Define our external module requirements
var HomeKitHistory = require("./HomeKitHistory");
var NexusStreamer = require("./nexusstreamer");

// Define constants
const AccessoryName =  "Nest";
const AccessoryPincode = "031-45-154";                          // HomeKit pairing code
const LOWBATTERYLEVEL = 10;                                     // Low battery level percentage
const FFMPEGLIBARIES = ["libspeex", "libx264", "libfdk-aac"];   // List of ffmpeg libraries we require for doorbell/camera(s)


// NestDevice class
//
// All HomeKit accessories will be derived from this class
const NESTDEVICETYPE = {
    THERMOSTAT : "thermostat",
    TEMPSENSOR : "temperature",
    SMOKESENSOR : "protect",
    CAMERA : "camera",
    DOORBELL : "doorbell",
    WEATHER : "weather"
}

const MESSAGETYPE = {
    UPDATE : "dataUpdate",
    REMOVE : "deviceRemove"
}

class NestDevice {
    constructor(deviceData, eventEmitter) {
        this.deviceData = deviceData;                   // Current data for the device
        this.HomeKitAccessory = null;                   // HomeKit Accessory object
        this.events = eventEmitter;                     // Event emitter to use. Should be a "global" define one to allow comms from NestSystem object
        this.historyService = null;                     // History logging service

        // Setup event listener to process "messages" to our device
        this.events.addListener(this.deviceData.nest_device_structure, this.#message.bind(this)); 
    }

    // Class functions
    add(deviceTypeName, deviceTypeModel, HomeKitCategory, enableHistory) {
        if (this.HomeKitAccessory == null) {
            this.HomeKitAccessory = exports.accessory = new Accessory(deviceTypeName, uuid.generate("hap-nodejs:accessories:nest_" + this.deviceData.serial_number));
            this.HomeKitAccessory.username = this.deviceData.mac_address;
            this.HomeKitAccessory.pincode = AccessoryPincode;
            this.HomeKitAccessory.category = HomeKitCategory;
            this.HomeKitAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Nest");
            this.HomeKitAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, deviceTypeModel);
            this.HomeKitAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, this.deviceData.serial_number);
            this.HomeKitAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, this.deviceData.software_version);

            if (enableHistory == true && this.historyService == null) {
                // Setup logging service as requsted
                this.historyService = new HomeKitHistory(this.HomeKitAccessory, {});
            }

            if (typeof this.addHomeKitServices == "function") {
                // We have a class function defined for setting up HomeKit services
                this.addHomeKitServices((this.deviceData.description == "" ? this.deviceData.location : this.deviceData.location + " - " + this.deviceData.description)); 
                this.update(this.deviceData, true);  // perform an inital update using current data
            }

            var accessoryIndex = accessories.findIndex(({username}) => username === this.deviceData.mac_address);
            if (accessoryIndex == -1) accessories.push(this.HomeKitAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
            this.HomeKitAccessory.publish({username: this.HomeKitAccessory.username, pincode: this.HomeKitAccessory.pincode, category: this.HomeKitAccessory.category, advertiser: config.mDNS});    // Publish accessory on local network
        }
    }

    remove() {
        this.events.removeAllListeners(this.deviceData.nest_device_structure);  // Remove listener for "messages"
        if (typeof this.removeHomeKitServices == "function") {
            // We have a class function defined for removal of HomeKit services
            this.removeHomeKitServices(); 
        }
        this.HomeKitAccessory.unpublish();
         console.log("Removed Nest Device '%s' on '%s'", this.HomeKitAccessory.displayName, this.HomeKitAccessory.username);

        // Clear out object properties
        var accessoryIndex = accessories.findIndex(({username}) => username === this.deviceData.mac_address);
        if (accessoryIndex != -1) accessories.splice(accessoryIndex, 1);

        this.deviceData = null;
        this.HomeKitAccessory = null;
        this.events = null;
        this.historyService = null;

        // Do we destroy this object??
        // this = null;
        // delete this;
    }

    update(deviceData, force) {
        if (typeof deviceData == "object") {
            // Updated data may only contain selected fields, so we'll handle that here by taking our internally stored data
            // to ensure we have a complete data object for updates
            Object.entries(this.deviceData).forEach(([key, value]) => {
                if (typeof deviceData[key] == "undefined") {
                    // Update data doesnt have this key, so add it our internal data
                    deviceData[key] = value;
                }
            });

            // Check to see what data elemnets have changed
            var changes = {};
            Object.entries(deviceData).forEach(([key, value]) => {
                if (JSON.stringify(deviceData[key]) !== JSON.stringify(this.deviceData[key])) {
                    changes[key] = deviceData[key];
                }
            }); 

            // If we have any changed data elements OR we've been requested to force an update, do so
            if (Object.keys(changes).length != 0 || force == true) {
                // If there is a function "updateHomeKit" defined in the object, call this.
                if (typeof this.updateHomeKitServices == "function") {
                    this.updateHomeKitServices(deviceData);
                }

                // Finally, update our internally stored data to match what we were sent in
                this.deviceData = deviceData;
            }
        }
    }

    set(structure, values) {
        // Sets properties within Nest system for this device
        if (structure != "" && typeof values == "object") {
            this.events.emit(NESTSYSTEMEVENT.SETELEMENT, structure + "." + this.deviceData.nest_device_structure.split(".")[1], values);
        }
    }

    get(key) {
        // Gets proproperty from Nest system ie: not using cached data
        // <---- To Implement
    }

    #message(messageType, messageData) {
        // Handle events "messages" for this device and performs appropriate action
        if (messageType == MESSAGETYPE.UPDATE) {
            this.update(messageData, false);    // Got some device data, so do updates
        }
        if (messageType == MESSAGETYPE.REMOVE) {
            this.remove();  // Got message for device removal
        }
    }
}


// Nest Thermostat
class ThermostatClass extends NestDevice {
    constructor(deviceData, eventEmitter) {
        super(deviceData, eventEmitter);

        this.ThermostatService = null;                  // HomeKit service for this thermostat
        this.BatteryService = null;                     // Status of Nest Thermostat battery
        this.OccupancyService = null;                   // Status of Away/Home
        this.HumidityService = null;                    // Seperate humidity sensor
        this.FanService = null;                         // Fan service
        this.updatingHomeKit = false;                   // Flag if were doing an HomeKit update or not
        this.previous_target_temperature_type = null;   // Track previous target tempersture type
    }


    // Class functions
    addHomeKitServices(serviceName) {
        // Add this thermostat to the "master" accessory and set properties
        this.ThermostatService = this.HomeKitAccessory.addService(Service.Thermostat, "Thermostat", 1);
        this.ThermostatService.addCharacteristic(Characteristic.StatusActive);  // Used to indicate active temperature
        this.ThermostatService.addCharacteristic(Characteristic.StatusFault);  // Used to indicate Nest online or not
        this.ThermostatService.addCharacteristic(Characteristic.LockPhysicalControls);    // Setting can only be accessed via Eve App (or other 3rd party).
        this.deviceData.has_air_filter && this.ThermostatService.addCharacteristic(Characteristic.FilterChangeIndication);   // Add characteristic if has air filter
        this.deviceData.has_humidifier && this.ThermostatService.addCharacteristic(Characteristic.TargetRelativeHumidity);   // Add characteristic if has dehumidifier

        // Add battery service to display battery level
        this.BatteryService = this.HomeKitAccessory.addService(Service.BatteryService, "", 1);

        // Seperate humidity sensor if configured todo so
        if (this.deviceData.humiditySensor && this.deviceData.humiditySensor == true) {
            this.HumidityService = this.HomeKitAccessory.addService(Service.HumiditySensor, "Humidity", 1);      // Humidity will be listed under seperate sensor
            this.HumidityService.addCharacteristic(Characteristic.StatusFault);
        } else {
            this.ThermostatService.addCharacteristic(Characteristic.CurrentRelativeHumidity); // Humidity will be listed under thermostat only
        }

        // Add home/away status as an occupancy sensor
        this.OccupancyService = this.HomeKitAccessory.addService(Service.OccupancySensor, "Occupancy", 1);
        this.OccupancyService.addCharacteristic(Characteristic.StatusFault);

        // Limit prop ranges
        if (this.deviceData.can_cool == false && this.deviceData.can_heat == true)
        {
            // Can heat only, so set values allowed for mode off/heat
            this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]});
        } else if (this.deviceData.can_cool == true && this.deviceData.can_heat == false) {
            // Can cool only
            this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.COOL]});
        } else if (this.deviceData.can_cool == true && this.deviceData.can_heat == true) {
            // heat and cool 
            this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.COOL, Characteristic.TargetHeatingCoolingState.AUTO]});
        } else {
            // only off mode
            this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF]});
        }

        // Add fan service if Nest supports a fan
        if (this.deviceData.has_fan == true) {
            this.FanService = this.HomeKitAccessory.addService(Service.Fan, "Fan", 1);
            this.FanService.getCharacteristic(Characteristic.On).on("set", this.setFan.bind(this));
        }

        // Set default ranges - based on celsuis ranges
        this.ThermostatService.setCharacteristic(Characteristic.TemperatureDisplayUnits, Characteristic.TemperatureDisplayUnits.CELSIUS);
        this.ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: 0.5});
        this.ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});
        this.ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});
        this.ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: 0.5}, {minValue: 9}, {maxValue: 32});

        // Setup set callbacks for characteristics
        this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).on("set", this.setDisplayUnits.bind(this));
        this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).on("set", this.setMode.bind(this));
        this.ThermostatService.getCharacteristic(Characteristic.TargetTemperature).on("set", (value, callback) => {this.setTemperature(Characteristic.TargetTemperature, value, callback)});
        this.ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).on("set", (value, callback) => {this.setTemperature(Characteristic.CoolingThresholdTemperature, value, callback)});
        this.ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).on("set", (value, callback) => {this.setTemperature(Characteristic.HeatingThresholdTemperature, value, callback)});
        this.ThermostatService.getCharacteristic(Characteristic.LockPhysicalControls).on("set", (value, callback) => {this.setChildlock("", value, callback)});

        this.HomeKitAccessory.setPrimaryService(this.ThermostatService);

        // Setup linkage to EveHome app if configured todo so
        this.deviceData.EveApp && this.historyService && this.historyService.linkToEveHome(this.HomeKitAccessory, this.ThermostatService, {debug: config.debug.includes("HISTORY")});

        console.log("Setup Nest Thermostat '%s' on '%s'", serviceName, this.HomeKitAccessory.username, (this.HumidityService != null ? "with seperate humidity sensor" : ""));
        this.deviceData.externalCool && console.log("  += using external cooling");
        this.deviceData.externalHeat && console.log("  += using external heating");
        this.deviceData.externalFan && console.log("  += using external fan");
        this.deviceData.externalDehumidifier && console.log("  += using external dehumidification");
    }

    setFan(value, callback) {
        this.updatingHomeKit = true;
      
        config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Set fan on thermostat '%s' to '%s'", this.deviceData.mac_address, (value == true ? "On" : "Off"));
        this.set("device", {"fan_timer_timeout" : (value == false ? 0 : this.deviceData.fan_duration + Math.floor(new Date() / 1000))} );
        this.FanService.updateCharacteristic(Characteristic.On, value);
       
        if (typeof callback === "function") callback();  // do callback if defined
        this.updatingHomeKit = false;
    }

    setDisplayUnits(value, callback) {
        this.updatingHomeKit = true;

        // Update HomeKit steps and ranges for temperatures
        this.ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)});
        this.ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 90)});
        this.ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 90)});
        this.ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 90)});

        config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Set temperature units on thermostat '%s' to '%s'", this.deviceData.mac_address, (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? "°C" : "°F"));
        this.set("device", {"temperature_scale" : (value == Characteristic.TemperatureDisplayUnits.CELSIUS ? "C" : "F") });
        this.ThermostatService.updateCharacteristic(Characteristic.TemperatureDisplayUnits, value);
        
        if (typeof callback === "function") callback();  // do callback if defined
        this.updatingHomeKit = false;
    }

    setMode(value, callback) {
        this.updatingHomeKit = true;

        if (value != this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value) {
            // Only change heating/cooling mode if change requested is different than current HomeKit state
            var tempMode = "";
            var tempValue = null;

            if (value == Characteristic.TargetHeatingCoolingState.HEAT && this.deviceData.can_heat == true) {
                tempMode = "heat";
                tempValue = Characteristic.TargetHeatingCoolingState.HEAT;
            }
            if (value == Characteristic.TargetHeatingCoolingState.COOL && this.deviceData.can_cool == true) {
                tempMode = "cool";
                tempValue = Characteristic.TargetHeatingCoolingState.COOL;
            }
            if (value == Characteristic.TargetHeatingCoolingState.AUTO) {
                // Workaround for "Hey Siri, turn on my thermostat". Appears to automatically request mode as "auto", but we need to see what Nest device supports
                if (this.deviceData.can_cool == true && this.deviceData.can_heat == true) {
                    tempMode = "range";
                    tempValue = Characteristic.TargetHeatingCoolingState.AUTO;
                } else if (this.deviceData.can_cool == true && this.deviceData.can_heat == false) {
                    tempMode = "cool";
                    tempValue = Characteristic.TargetHeatingCoolingState.COOL;
                } else if (this.deviceData.can_cool == false && this.deviceData.can_heat == true) {
                    tempMode = "heat";
                    tempValue = Characteristic.TargetHeatingCoolingState.HEAT;
                } else {
                    tempMode = "off"
                    tempValue = Characteristic.TargetHeatingCoolingState.OFF;
                }
            }
            if (value == Characteristic.TargetHeatingCoolingState.OFF) {
                tempMode = "off";
                tempValue = Characteristic.TargetHeatingCoolingState.OFF;
            }

            if (tempValue != null && tempMode != "") {
                config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Set thermostat on '%s' to '%s'", this.deviceData.mac_address, tempMode);
                this.set("shared", {"target_temperature_type" : tempMode, "target_change_pending" : true});
                this.ThermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, tempValue);
                
                if (this.previous_target_temperature_type == "range" && (tempMode == "heat" || tempMode == "cool")) {
                    // If switching from range to heat/cool, update HomeKit using previous target temp
                    this.ThermostatService.updateCharacteristic(Characteristic.TargetTemperature, this.deviceData.target_temperature);
                }
            }
        }

        if (typeof callback === "function") callback();  // do callback if defined
        this.updatingHomeKit = false;
    }

    setTemperature(characteristic, value, callback) {
        this.updatingHomeKit = true;

        var tempValue = __adjustTemperature(value, "C", "C");

        if (characteristic == Characteristic.TargetTemperature && this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value != Characteristic.TargetHeatingCoolingState.AUTO) {
            config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Set thermostat %s temperature on '%s' to '%s °C'", (this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value == Characteristic.TargetHeatingCoolingState.HEAT ? "heating" : "cooling"), this.deviceData.mac_address, tempValue);
            this.set("shared", {"target_temperature": tempValue, "target_change_pending" : true});
        }
        if (characteristic == Characteristic.HeatingThresholdTemperature && this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value == Characteristic.TargetHeatingCoolingState.AUTO) {
            config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Set maximum heating temperature on thermostat '%s' to '%s °C'", this.deviceData.mac_address, tempValue);
            this.set("shared", {"target_temperature_low": tempValue, "target_change_pending" : true});
        }
        if (characteristic == Characteristic.CoolingThresholdTemperature && this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).value == Characteristic.TargetHeatingCoolingState.AUTO) {
            config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Set minimum cooling temperature on thermostat '%s' to '%s °C'", this.deviceData.mac_address, tempValue);
            this.set("shared", {"target_temperature_high": tempValue, "target_change_pending" : true});
        }

        this.ThermostatService.updateCharacteristic(characteristic, value);  // Update HomeKit with value
        
        if (typeof callback === "function") callback();  // do callback if defined
        this.updatingHomeKit = false;
    }

    setChildlock(pin, value, callback) {
        this.updatingHomeKit = true;
        // TODO - pincode setting when turning on. Writes to device.xxxxxxxx.temperature_lock_pin_hash. How is the hash calculated???
        // Do we set temperature range limits when child lock on??

        this.ThermostatService.updateCharacteristic(Characteristic.LockPhysicalControls, value);  // Update HomeKit with value
        if (value == Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED) {
            // Set pin hash????
        }
        if (value == Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED) {
            // Clear pin hash????
        }
        config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Setting Childlock on '%s' to '%s'", this.deviceData.mac_address, (value == Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? "Enabled" : "Disabled"));
        this.set("device", {"temperature_lock" : (value == Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? true : false) });
        
        if (typeof callback === "function") callback();  // do callback if defined
        this.updatingHomeKit = false;
    }

    updateHomeKitServices(deviceData) {
        var historyEntry = {};

        if (this.updatingHomeKit == false) {
            if (this.ThermostatService != null && this.BatteryService != null && this.OccupancyService != null) {
                this.HomeKitAccessory.getService(Service.AccessoryInformation).updateCharacteristic(Characteristic.FirmwareRevision, deviceData.software_version);   // Update firmware version
                this.ThermostatService.updateCharacteristic(Characteristic.TemperatureDisplayUnits, deviceData.temperature_scale.toUpperCase() == "C" ? Characteristic.TemperatureDisplayUnits.CELSIUS : Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
                this.ThermostatService.updateCharacteristic(Characteristic.CurrentTemperature, deviceData.active_temperature);
                this.ThermostatService.updateCharacteristic(Characteristic.StatusFault, (deviceData.online == true && deviceData.removed_from_base == false) ? Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT);  // If Nest isn't online or removed from base, report in HomeKit
                this.ThermostatService.updateCharacteristic(Characteristic.LockPhysicalControls, deviceData.temperature_lock == true ? Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED : Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED);
                this.ThermostatService.updateCharacteristic(Characteristic.FilterChangeIndication, (deviceData.has_air_filter && deviceData.filter_replacement_needed == true ? Characteristic.FilterChangeIndication.CHANGE_FILTER : Characteristic.FilterChangeIndication.FILTER_OK));
                this.ThermostatService.updateCharacteristic(Characteristic.StatusActive, (deviceData.active_rcs_sensor != "" ? false : true));  // Using a temperature sensor as active temperature?
                
                // Update HomeKit steps and ranges for temperatures
                // Do we limit ranges when childlock on????
                this.ThermostatService.getCharacteristic(Characteristic.CurrentTemperature).setProps({minStep: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)});
                this.ThermostatService.getCharacteristic(Characteristic.TargetTemperature).setProps({minStep: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
                this.ThermostatService.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps({minStep: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
                this.ThermostatService.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps({minStep: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 0.5 : 1)}, {minValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 9 : 48)}, {maxValue: (this.ThermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits).value == Characteristic.TemperatureDisplayUnits.CELSIUS ? 32 : 90)});
        
                // Battery status if defined. Since Nest needs 3.6 volts to turn on, we'll use that as the lower limit. Havent seen battery level above 3.9ish, so assume 3.9 is upper limit
                var tempBatteryLevel = __scale(deviceData.battery_level, 3.6, 3.9, 0, 100);
                this.BatteryService.updateCharacteristic(Characteristic.BatteryLevel, tempBatteryLevel);
                this.BatteryService.updateCharacteristic(Characteristic.StatusLowBattery, tempBatteryLevel > LOWBATTERYLEVEL ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
                this.BatteryService.updateCharacteristic(Characteristic.ChargingState, (deviceData.battery_level > this.deviceData.battery_level && this.deviceData.battery_level != 0 ? true : false) ? Characteristic.ChargingState.CHARGING : Characteristic.ChargingState.NOT_CHARGING);
        
                // Update for away/home status. Away = no occupancy detected, Home = Occupancy Detected
                this.OccupancyService.updateCharacteristic(Characteristic.OccupancyDetected, deviceData.away == true ? Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED : Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
                this.OccupancyService.updateCharacteristic(Characteristic.StatusFault, (deviceData.online == true && deviceData.removed_from_base == false) ? Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT);  // If Nest isn't online or removed from base, report in HomeKit

                // Update seperate humidity sensor if configured todo so
                if (this.HumidityService != null) {
                    this.HumidityService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);  // Humidity will be listed under seperate sensor
                    this.HumidityService.updateCharacteristic(Characteristic.StatusFault, (deviceData.online == true && deviceData.removed_from_base == false) ? Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT);  // If Nest isn't online or removed from base, report in HomeKit
                } else {
                    this.ThermostatService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);    // Humidity will be listed under thermostat only
                }

                // Check for fan setup change on thermostat
                if (deviceData.has_fan != this.deviceData.has_fan) {
                    if (deviceData.has_fan == false && this.deviceData.has_fan == true && this.FanService == null) {
                        // Fan has been added
                        this.FanService = this.HomeKitAccessory.addService(Service.Fan, "Fan", 1);
                        this.FanService.getCharacteristic(Characteristic.On).on("set", this.setFan.bind(this));
                    }
                    if (deviceData.has_fan == true && this.deviceData.has_fan == false && this.FanService != null) {
                        // Fan has been removed
                        this.HomeKitAccessory.removeService(this.FanService);
                        this.FanService = null;
                    }
                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Fan setup on thermostat '%s' has changed. Fan was", this.deviceData.mac_address, (this.FanService == null ? "removed" : "added"));
                }

                if ((deviceData.can_cool != this.deviceData.can_cool) || (deviceData.can_heat != this.deviceData.can_heat)) {
                    // Heating and/cooling setup has changed on thermostat

                    // Limit prop ranges
                    if (deviceData.can_cool == false && deviceData.can_heat == true)
                    {
                        // Can heat only, so set values allowed for mode off/heat
                        this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT]});
                    }
                    if (deviceData.can_cool == true && deviceData.can_heat == false) {
                        // Can cool only
                        this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.COOL]});
                    }
                    if (deviceData.can_cool == true && deviceData.can_heat == true) {
                        // heat and cool 
                        this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF, Characteristic.TargetHeatingCoolingState.HEAT, Characteristic.TargetHeatingCoolingState.COOL, Characteristic.TargetHeatingCoolingState.AUTO]});
                    }
                    if (deviceData.can_cool == false && deviceData.can_heat == false) {
                        // only off mode
                        this.ThermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).setProps({validValues: [Characteristic.TargetHeatingCoolingState.OFF]});
                    }
                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Heating/cooling setup on thermostat on '%s' has changed", this.deviceData.mac_address);
                } 

                // Update current mode temperatures
                if (deviceData.target_temperature_type != this.deviceData.target_temperature_type) {
                    // track target temperature type changes
                    this.previous_target_temperature_type = this.deviceData.target_temperature_type;
                }
                if (deviceData.hvac_mode.toUpperCase() == "HEAT" || (deviceData.hvac_mode.toUpperCase() == "ECO" && deviceData.target_temperature_type.toUpperCase() == "HEAT")) {
                    // heating mode, either eco or normal
                    this.ThermostatService.updateCharacteristic(Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
                    this.ThermostatService.updateCharacteristic(Characteristic.CoolingThresholdTemperature, deviceData.target_temperature_high);
                    this.ThermostatService.updateCharacteristic(Characteristic.TargetTemperature, deviceData.target_temperature);
                    this.ThermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.HEAT);
                    historyEntry.target = {low: 0, high: deviceData.target_temperature};    // single target temperature for heating limit
                }
                if (deviceData.hvac_mode.toUpperCase() == "COOL" || (deviceData.hvac_mode.toUpperCase() == "ECO" && deviceData.target_temperature_type.toUpperCase() == "COOL")) {
                    // cooling mode, either eco or normal
                    this.ThermostatService.updateCharacteristic(Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
                    this.ThermostatService.updateCharacteristic(Characteristic.CoolingThresholdTemperature, deviceData.target_temperature_high);
                    this.ThermostatService.updateCharacteristic(Characteristic.TargetTemperature, deviceData.target_temperature);
                    this.ThermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.COOL);
                    historyEntry.target = {low: deviceData.target_temperature, high: 0};    // single target temperature for cooling limit
                }
                if (deviceData.hvac_mode.toUpperCase() == "RANGE" || (deviceData.hvac_mode.toUpperCase() == "ECO" && deviceData.target_temperature_type.toUpperCase() == "RANGE")) {
                    // range mode, either eco or normal
                    this.ThermostatService.updateCharacteristic(Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
                    this.ThermostatService.updateCharacteristic(Characteristic.CoolingThresholdTemperature, deviceData.target_temperature_high);
                    this.ThermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.AUTO);
                    historyEntry.target = {low: deviceData.target_temperature_low, high: deviceData.target_temperature_high};    // target temperature range
                }
                if (deviceData.hvac_mode.toUpperCase() == "OFF") {
                    // off mode.
                    this.ThermostatService.updateCharacteristic(Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
                    this.ThermostatService.updateCharacteristic(Characteristic.CoolingThresholdTemperature, deviceData.target_temperature_high);
                    this.ThermostatService.updateCharacteristic(Characteristic.TargetTemperature, deviceData.target_temperature);
                    this.ThermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);
                    historyEntry.target = {low: 0, high: 0};    // thermostat off, so no target temperatures
                }
            
                // Update current state
                if (deviceData.hvac_state.toUpperCase() == "HEATING") {
                    if (this.deviceData.hvac_state.toUpperCase() == "COOLING" && typeof deviceData.externalCool == "object") {
                        // Switched to heating mode and external cooling external code was being used, so stop cooling via cooling external code
                        if (typeof deviceData.externalCool.off == "function") deviceData.externalCool.off(config.debug.includes(Debugging.EXTERNAL));
                    }
                    if (this.deviceData.hvac_state.toUpperCase() != "HEATING" && typeof deviceData.externalHeat == "object") {
                        // Switched to heating mode and external heating external code is being used, so start heating via heating external code
                        if (typeof deviceData.externalHeat.heat == "function") deviceData.externalHeat.heat(deviceData.target_temperature, config.debug.includes(Debugging.EXTERNAL));
                    }
                    this.ThermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.HEAT);
                    historyEntry.status = 2;    // heating
                }
                if (deviceData.hvac_state.toUpperCase() == "COOLING") {
                    if (this.deviceData.hvac_state.toUpperCase() == "HEATING" && typeof deviceData.externalHeat == "object") {
                        // Switched to cooling mode and external heating external code was being used, so stop heating via heating external code
                        if (typeof deviceData.externalHeat.off == "function") deviceData.externalHeat.off(config.debug.includes(Debugging.EXTERNAL));
                    }
                    if (this.deviceData.hvac_state.toUpperCase() != "COOLING" && typeof deviceData.externalCool == "object") {
                        // Switched to cooling mode and external cooling external code is being used, so start cooling via cooling external code
                        if (typeof deviceData.externalCool.cool == "function") deviceData.externalCool.cool(deviceData.target_temperature, config.debug.includes(Debugging.EXTERNAL));
                    }
                    this.ThermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.COOL);
                    historyEntry.status = 3;    // cooling
                }
                if (deviceData.hvac_state.toUpperCase() == "OFF") {
                    if (this.deviceData.hvac_state.toUpperCase() == "COOLING" && typeof deviceData.externalCool == "object") {
                        // Switched to off mode and external cooling external code was being used, so stop cooling via cooling external code
                        if (typeof deviceData.externalCool.off == "function") deviceData.externalCool.off(config.debug.includes(Debugging.EXTERNAL));
                    }
                    if (this.deviceData.hvac_state.toUpperCase() == "HEATING" && typeof deviceData.externalHeat == "object") {
                        // Switched to off mode and external heating external code was being used, so stop heating via heating external code
                        if (typeof deviceData.externalHeat.heat == "function") deviceData.externalHeat.off(config.debug.includes(Debugging.EXTERNAL));
                    }
                    this.ThermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
                    historyEntry.status = 0;    // off
                }
                if (this.FanService != null) {
                    if (this.deviceData.fan_state = false && deviceData.fan_state == true && typeof deviceData.externalFan == "object") {
                        // Fan mode was switched on and external fan external code is being used, so start fan via fan external code
                        if (typeof deviceData.externalFan.fan == "function") deviceData.externalFan.fan(0, config.debug.includes(Debugging.EXTERNAL));    // Fan speed will be auto
                    }
                    if (this.deviceData.fan_state == true && deviceData.fan_state == false && typeof deviceData.externalFan == "object") {
                        // Fan mode was switched off and external fan external code was being used, so stop fan via fan external code
                        if (typeof deviceData.externalFan.off == "function") deviceData.externalFan.off(config.debug.includes(Debugging.EXTERNAL));
                    }
                    this.FanService.updateCharacteristic(Characteristic.On, deviceData.fan_state);   // fan status on or off
                    historyEntry.status = 1;    // fan
                }

                // Log thermostat metrics to history only if changed to previous recording
                if (this.historyService != null) {
                    var tempEntry = this.historyService.lastHistory(this.ThermostatService);
                    if (tempEntry == null || (typeof tempEntry == "object" && tempEntry.status != historyEntry.status || tempEntry.temperature != deviceData.active_temperature || JSON.stringify(tempEntry.target) != JSON.stringify(historyEntry.target) || tempEntry.humidity != deviceData.current_humidity)) {
                        this.historyService.addHistory(this.ThermostatService, {time: Math.floor(new Date() / 1000), status: historyEntry.status, temperature: deviceData.active_temperature, target: historyEntry.target, humidity: deviceData.current_humidity});
                    }
                }
            }
        }
    }
}


// Nest Temperature Sensors
class TempSensorClass extends NestDevice {
    constructor(deviceData, eventEmitter) {
        super(deviceData, eventEmitter);

        this.TemperatureService = null;                 // HomeKit service for this temperature sensor
        this.BatteryService = null;                     // Status of Nest Temperature Sensor Battery
    }


    // Class functions
    addHomeKitServices(serviceName) {
        // Add this temperature sensor to the "master" accessory and set properties   
        this.TemperatureService = this.HomeKitAccessory.addService(Service.TemperatureSensor, serviceName, 1);
        this.TemperatureService.addCharacteristic(Characteristic.StatusActive);
        this.TemperatureService.addCharacteristic(Characteristic.StatusFault);

        // Add battery service to display battery level    
        this.BatteryService = this.HomeKitAccessory.addService(Service.BatteryService, "", 1);
        this.BatteryService.updateCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE); //  dont charge as run off battery

        // Setup linkage to EveHome app if configured todo so
        this.deviceData.EveApp && this.historyService && this.historyService.linkToEveHome(this.HomeKitAccessory, this.TemperatureService, {debug: config.debug.includes("HISTORY")});

        console.log("Setup Nest Temperature Sensor '%s' on '%s'", serviceName, this.HomeKitAccessory.username);
    }

    updateHomeKitServices(deviceData) {
        if (this.TemperatureService != null && this.BatteryService != null) {
            this.TemperatureService.updateCharacteristic(Characteristic.StatusFault, (deviceData.online == true ? Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT));  // If Nest isn't online, report in HomeKit
        
            // Is this sensor providing the active temperature for a thermostat
            this.TemperatureService.updateCharacteristic(Characteristic.StatusActive, deviceData.active_sensor);

            // Update temperature
            this.TemperatureService.updateCharacteristic(Characteristic.CurrentTemperature, deviceData.current_temperature);
    
            // Update battery level
            var tempBatteryLevel = __scale(deviceData.battery_level, 0, 100, 0, 100);
            this.BatteryService.updateCharacteristic(Characteristic.BatteryLevel, tempBatteryLevel);
            this.BatteryService.updateCharacteristic(Characteristic.StatusLowBattery, tempBatteryLevel > LOWBATTERYLEVEL ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);

            // Log temperture to history only if changed to previous recording
            if (deviceData.current_temperature != this.deviceData.current_temperature) {
                this.historySevice && this.historyService.addHistory(this.TemperatureService, {time: Math.floor(new Date() / 1000), temperature: deviceData.current_temperature});
            }
        }
    }
}


// Nest Protect
class SmokeSensorClass extends NestDevice {
    constructor(deviceData, eventEmitter) {
        super(deviceData, eventEmitter);
 
        this.SmokeService = null;                       // HomeKit service for this smoke sensor
        this.COService = null;                          // HomeKit service for this CO sensor
        this.BatteryService = null;                     // Status of Nest Protect Sensor Battery
        this.MotionService = null;                      // Status of Nest Protect motion sensor
        this.LightService = null;                       // Status of Nest Protect Pathway light
    }


    // Class functions
    addHomeKitServices(serviceName) {
        // Add this smoke sensor & CO sensor to the "master" accessory and set properties   
        this.SmokeService = this.HomeKitAccessory.addService(Service.SmokeSensor, "Smoke", 1);
        this.SmokeService.addCharacteristic(Characteristic.StatusActive);
        this.SmokeService.addCharacteristic(Characteristic.StatusFault);

        this.COService = this.HomeKitAccessory.addService(Service.CarbonMonoxideSensor, "Carbon Monoxide", 1);
        this.COService.addCharacteristic(Characteristic.StatusActive);
        this.COService.addCharacteristic(Characteristic.StatusFault);

        // Add battery service to display battery level
        this.BatteryService = this.HomeKitAccessory.addService(Service.BatteryService, "", 1);
        this.BatteryService.updateCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE); // dont charge as run off battery

        // Add motion sensor if supported (only on wired versions)
        if (this.deviceData.wired_or_battery == 0) {
            this.MotionService = this.HomeKitAccessory.addService(Service.MotionSensor, "Motion", 1);
            this.MotionService.addCharacteristic(Characteristic.StatusFault);
        }

        // Add light blub to represent "night light" if enabled
        if (this.deviceData.night_light_enable == true) {
            //this.LightService = this.HomeKitAccessory.addService(Service.Lightbulb, "Night Light", 1);
            //this.LightService.addCharacteristic(Characteristic.Brightness);
        }

        this.HomeKitAccessory.setPrimaryService(this.SmokeService);

        // Setup linkage to EveHome app if configured todo so
        this.deviceData.EveApp && this.historyService && this.historyService.linkToEveHome(this.HomeKitAccessory, this.SmokeService, {GetCommand: this.EveHomeGetCommand.bind(this),
                                                                                                    SetCommand: this.EveHomeSetCommand.bind(this),
                                                                                                    EveSmoke_lastalarmtest: this.deviceData.latest_alarm_test,
                                                                                                    EveSmoke_alarmtest: this.deviceData.self_test_in_progress,
                                                                                                    EveSmoke_heatstatus: this.deviceData.heat_status,
                                                                                                    EveSmoke_hushedstate: this.deviceData.hushed_state,
                                                                                                    EveSmoke_statusled: this.deviceData.ntp_green_led,
                                                                                                    EveSmoke_smoketestpassed: this.deviceData.smoke_test_passed,
                                                                                                    EveSmoke_heattestpassed: this.deviceData.heat_test_passed,
                                                                                                    debug: config.debug.includes("HISTORY")
                                                                                                    });

        console.log("Setup Nest Protect '%s' on '%s'", serviceName, this.HomeKitAccessory.username, (this.MotionService != null ? "with motion sensor" : ""));
    }

    updateHomeKitServices(deviceData) {
        if (this.SmokeService != null && this.COService != null && this.BatteryService != null) {
            this.HomeKitAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, deviceData.software_version);
            this.SmokeService.updateCharacteristic(Characteristic.StatusActive, (deviceData.online == true && deviceData.removed_from_base == false ? true : false));  // If Nest isn't online or removed from base, report in HomeKit
            this.SmokeService.updateCharacteristic(Characteristic.StatusFault, ((deviceData.online == true && deviceData.removed_from_base == false) && (Math.floor(new Date() / 1000) <= deviceData.replacement_date) ? Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT));  // General fault if replacement date past or Nest isn't online or removed from base
            this.COService.updateCharacteristic(Characteristic.StatusActive, (deviceData.online == true && deviceData.removed_from_base == false ? true : false));  // If Nest isn't online or removed from base, report in HomeKit
            this.COService.updateCharacteristic(Characteristic.StatusFault, ((deviceData.online == true && deviceData.removed_from_base == false) && (Math.floor(new Date() / 1000) <= deviceData.replacement_date) ? Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT));  // General fault if replacement date past or Nest isn't online or removed from base
        
            if (this.MotionService != null) {
                // Motion detect if auto_away = false. Not supported on battery powered Nest Protects
                this.MotionService.updateCharacteristic(Characteristic.StatusFault, (deviceData.online == true && deviceData.removed_from_base == false) ? Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT);  // If Nest isn't online or removed from base, report in HomeKit
                this.MotionService.updateCharacteristic(Characteristic.MotionDetected, deviceData.away == false ? true : false);

                // Log motion to history only if changed to previous recording
                if (deviceData.away != this.deviceData.away) {
                    this.historySevice && this.historyService.addHistory(this.MotionService, {time: Math.floor(new Date() / 1000), status: deviceData.away == false ? 1 : 0}); 
                }
            }

            // Update battery details
            var tempBatteryLevel = __scale(deviceData.battery_level, 0, 5400, 0, 100);
            this.BatteryService.updateCharacteristic(Characteristic.BatteryLevel, tempBatteryLevel);
            this.BatteryService.updateCharacteristic(Characteristic.StatusLowBattery, (tempBatteryLevel > LOWBATTERYLEVEL && deviceData.battery_health_state == 0 && ((deviceData.line_power_present == true && deviceData.wired_or_battery == 0) || (deviceData.line_power_present == false && deviceData.wired_or_battery == 1))) ? Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL : Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW);
    
            // Update smoke and CO detected status 'ok': 0, 'warning': 1, 'emergency': 2
            this.SmokeService.updateCharacteristic(Characteristic.SmokeDetected, deviceData.smoke_status == 0 ? Characteristic.SmokeDetected.SMOKE_NOT_DETECTED : Characteristic.SmokeDetected.SMOKE_DETECTED);
            this.COService.updateCharacteristic(Characteristic.CarbonMonoxideDetected, deviceData.co_status == 0 ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL : Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL);

            // Notify Eve App of device status changes???
            this.historyService.updateEveHome(this.SmokeService, {GetCommand: this.EveHomeGetCommand.bind(this)});
        }
        if (this.LightService != null) {
            // Update light status

            // TODO if possible
            //this.LightService.updateCharacteristic(Characteristic.On, false);    // light off
            //this.LightService.updateCharacteristic(Characteristic.Brightness, Math.round(deviceData.night_light_brightness * 33.33));    
        }
    }

    EveHomeGetCommand(data) {
        // Pass back extra data for Eve Smoke "get" process command
        data.lastalarmtest = this.deviceData.latest_alarm_test;
        data.alarmtest = this.deviceData.self_test_in_progress;
        data.heatstatus = this.deviceData.heat_status;
        data.statusled = this.deviceData.ntp_green_led;
        data.smoketestpassed = this.deviceData.smoke_test_passed;
        data.heattestpassed = this.deviceData.heat_test_passed;
        data.hushedstate = this.deviceData.hushed_state;
        return data;
    }

   EveHomeSetCommand(processed) {
        if (processed.hasOwnProperty("alarmtest")) {
            //console.log("Eve Smoke Alarm test", (processed.alarmtest == true ? "start" : "stop"));
        }
        if (processed.hasOwnProperty("statusled")) {
            this.deviceData.ntp_green_led = processed.statusled;    // Do quick status update as setting nest values does take sometime
            this.set("topaz", {"ntp_green_led_enable" : processed.statusled});
        }
    }
}


// Nest Hello/Cam(s)

// Available video codecs we can use
const VideoCodecs = {
    COPY : "copy",
    H264_OMX : "h264_omx",
    LIBX264 : "libx264",
    H264_V4L2M2M : "h264_v4l2m2m"   // Not coded yet
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

class CameraClass extends NestDevice {
    constructor(deviceData, eventEmitter) {
        super(deviceData, eventEmitter);

        this.controller = null;                         // HomeKit Camera/Doorbell controller service
        this.MotionServices = [];                       // Status of Nest Hello/Cam(s) motion sensor(s)
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

        // HKSV stuff
        this.HKSVRecordingConfig = {};                  // HomeKit Secure Video recording configuration
        this.HKSVRecorder = {
            record: false,                              // Tracks updateRecordingActive. default is not recording, but HomeKit will select the current state
            ffmpeg: null,                               // ffmpeg process for recording
            mp4boxes: [],                               // array of processed mp4boxes produced during recording
            video: null,                                // video input stream
            audio: null,                                // audio input stream
            id: null,                                   // HKSV Recording ID
            time: 0                                     // Time to record from in buffer, 0 means from start of buffer
        };

        // Load "camera offline" jpg into a buffer
        this.camera_offline_h264_jpg = null;
        if (fs.existsSync(__dirname + "/" + CAMERAOFFLINEJPGFILE)) {
            this.camera_offline_h264_jpg = fs.readFileSync(__dirname + "/" + CAMERAOFFLINEJPGFILE);
        }

        // Load "camera switched off" jpg into a buffer
        this.camera_off_h264_jpg = null;
        if (fs.existsSync(__dirname + "/" + CAMERAOFFJPGFILE)) {
            this.camera_off_h264_jpg = fs.readFileSync(__dirname + "/" + CAMERAOFFJPGFILE);
        }

        this.set("properties", {"watermark.enabled" : false});  // "Try" to turn off Nest watermark in video stream
    }


    // Class functions
    addHomeKitServices(serviceName) {
        var options = {
            cameraStreamCount: 2, // HomeKit requires at least 2 streams, but 1 is also just fine
            delegate: this, // Our class is the delgate for handling streaming/images
            streamingOptions: {
                supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
                video: {
                    resolutions: [
                        [1920, 1080, 30],   // width, height, framerate
                        [1600, 1200, 30],   // Native res of Nest Hello
                        [1280, 960, 30],
                        [1280, 720, 30],
                        [1024, 768, 30],
                        [640, 480, 30],
                        [640, 360, 30],
                        [480, 360, 30],
                        [480, 270, 30],
                        [320, 240, 30],
                        [320, 240, 15],     // Apple Watch requires this configuration (Apple Watch also seems to required OPUS @16K)
                        [320, 180, 30],
                    ],
                    codec: {
                        profiles : [H264Profile.MAIN], // Use H264Profile.MAIN only as that appears what the Nest video stream is at??
                        levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
                    },
                },
                audio : {
                    twoWayAudio: (this.deviceData.capabilities.includes("audio.speaker") && this.deviceData.capabilities.includes("audio.microphone")) ? true : false,    // If both speaker & microphone capabilities, then we support twoway audio
                    codecs: [
                        {
                            type: AudioStreamingCodecType.AAC_ELD,
                            samplerate: AudioStreamingSamplerate.KHZ_16
                        },
                    ], 
                },
            }
        };

        if (this.deviceData.capabilities.includes("detectors.on_camera")) {
            // We have a capability of motion sensing on camera/doorbell
            // Zone id of 0 is the main sensor zone on camera/doorbell
            var tempService = this.HomeKitAccessory.addService(Service.MotionSensor, "Motion", 0);
            tempService.updateCharacteristic(Characteristic.MotionDetected, false);     // No motion in creation
            this.MotionServices.push({"service": tempService, "id": 0})

            if (this.deviceData.HKSV == false) {
                // Setup any additional Motion service(s) for camera/doorbell activity zones as required if HKSV disabled
                this.deviceData.activity_zones && this.deviceData.activity_zones.forEach(zone => {
                    if (zone.id != 0) {
                        var tempService = this.HomeKitAccessory.addService(Service.MotionSensor, zone.name, zone.id);
                        tempService.updateCharacteristic(Characteristic.MotionDetected, false); // No motion in creation
                        this.MotionServices.push({"service": tempService, "id": zone.id})
                    }
                });
            }
        }

        if (this.deviceData.HKSV == true) {
            // Setup HomeKit secure video
            options.recording = {
                delegate: this, // Our class will also handle stream recording
                options: {
                    mediaContainerConfiguration: [
                        {
                            fragmentLength: 4000,
                            type: MediaContainerType.FRAGMENTED_MP4
                        }
                    ],
                    prebufferLength: 4000,  // Seems to always be 4000???
                    video: {
                        resolutions: [
                            [1920, 1080, 30],   // width, height, framerate
                            [1600, 1200, 30],   // Native res of Nest Hello
                            [1280, 960, 30],
                            [1280, 720, 30],
                            [1024, 768, 30],
                            [640, 480, 30],
                            [640, 360, 30],
                            [480, 360, 30],
                            [480, 270, 30],
                            [320, 240, 30],
                            [320, 240, 15],     // Apple Watch requires this configuration (Apple Watch also seems to required OPUS @16K)
                            [320, 180, 30],
                        ],
                        parameters: {
                            profiles : [H264Profile.MAIN],  // Use H264Profile.MAIN only as that appears what the Nest video stream is at??
                            levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
                        },
                        type: VideoCodecType.H264
                    },
                    audio : {
                        codecs: [
                            {
                                type: AudioRecordingCodecType.AAC_ELD,
                                samplerate: AudioRecordingSamplerate.KHZ_16
                            },
                        ], 
                    }
                }
            };

            if (this.MotionServices[0] && this.MotionServices[0].service != null) {
                options.sensors = {
                    motion: this.MotionServices[0].service //motion service
                };
            }
        }

        // Setup HomeKit camera/doorbell controller
        this.controller = this.deviceData.device_type == NESTDEVICETYPE.DOORBELL ? new DoorbellController(options) : new CameraController(options);
        this.HomeKitAccessory.configureController(this.controller);

        if (this.deviceData.HKSV == true) {
            // extra setup for HSKV after created services
            this.deviceData.capabilities.includes("irled") && this.controller.recordingManagement.operatingModeService.addOptionalCharacteristic(Characteristic.NightVision);

            // Setup set callbacks for characteristics
            this.deviceData.capabilities.includes("irled") && this.controller.recordingManagement.operatingModeService.getCharacteristic(Characteristic.NightVision).on("set", (value, callback) => {
                var setValue = (value == true ? "auto_on" : "always_off");    
                if (setValue.toUpperCase() != this.deviceData.properties["irled.state"].toUpperCase()) {
                    // only change IRLed status value if different than on-device
                    this.set("properties", {"irled.state" :  setValue});
                }
                callback();
            });

            this.deviceData.capabilities.includes("audio.microphone") && this.controller.recordingManagement.recordingManagementService.getCharacteristic(Characteristic.RecordingAudioActive).on("set", (value, callback) => {
                var setValue = (value == Characteristic.RecordingAudioActive.ENABLE ? true : false);
                if (setValue != this.deviceData.properties["audio.enabled"]) {
                    // only change audio recording value if different than on-device
                    this.set("properties", {"audio.enabled" :  setValue});
                }
                callback();
            });
            
            this.controller.recordingManagement.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive).on("set", (value, callback) => {
                if (value != this.controller.recordingManagement.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive).value) {
                    // Make sure only updating status if HomeKit value *actually changes*
                    var setValue = (value == Characteristic.HomeKitCameraActive.ON);
                    if (setValue != this.deviceData.streaming_enabled) {
                        // Camera state does not reflect HKSV requested state, so fix
                        this.set("properties", {"streaming.enabled" :  setValue});
                    }
                    if (setValue == false) {
                        // Clear any inflight motion
                        this.MotionServices[0].service.updateCharacteristic(Characteristic.MotionDetected, false);
                    }
                }
                callback();
            });
        }

        this.NexusStreamer = new NexusStreamer(this.HomeKitAccessory.UUID, nest.cameraAPI.token, nest.tokenType, this.deviceData, config.debug.includes(Debugging.NEXUS));  // Create streamer object. used for buffering, streaming and recording

        // Setup linkage to EveHome app if configured todo so. We'll log motion history on the main motion service
        this.deviceData.EveApp && this.MotionServices[0] && this.historyService && this.historyService.linkToEveHome(this.HomeKitAccessory, this.MotionServices[0].service, {debug: config.debug.includes("HISTORY")});  // Link to Eve Home if we have atleast the main montion service

        console.log("Setup %s '%s' on '%s'", this.HomeKitAccessory.displayName, serviceName, this.HomeKitAccessory.username, this.deviceData.HKSV == true ? "with HomeKit Secure Video" : this.MotionServices.length >= 1 ? "with motion sensor(s)" : "");
        console.log("Nest Aware subscription for '%s' is", this.HomeKitAccessory.username, (this.deviceData.nest_aware == true ? "active" : "not active"))
    }

    removeHomeKitServices() {
        // Clean up our camera object since this device is being removed
        clearTimeout(this.doorbellTimer);
        clearTimeout(this.motionTimer);
        this.NexusStreamer && this.NexusStreamer.stopBuffering(); // Stop any buffering
    }

    // Taken and adapted from https://github.com/hjdhjd/homebridge-unifi-protect/blob/eee6a4e379272b659baa6c19986d51f5bf2cbbbc/src/protect-ffmpeg-record.ts
    async *handleRecordingStreamRequest(streamId) {
        // Should only be recording if motion detected
        // Seems sometimes when starting up, HAP-nodeJS or HomeKit triggers this even when motion isn't occuring
        if (this.MotionServices[0].service.getCharacteristic(Characteristic.MotionDetected).value == true) {
            // Audio if enabled on doorbell/camera && audio recording configured for HKSV 
            var includeAudio = (this.deviceData.audio_enabled == true && this.controller.recordingManagement.recordingManagementService.getCharacteristic(Characteristic.RecordingAudioActive).value == Characteristic.RecordingAudioActive.ENABLE);
            var recordCodec = this.deviceData.H264EncoderRecord;    // Codec to use for H264 encoding when recording

            // Build our ffmpeg command string for the video stream
            var ffmpeg = "-hide_banner"
              //  + " -fflags +discardcorrupt"
                //+ " -use_wallclock_as_timestamps 1"
                + " -f h264 -an -thread_queue_size 1024 -copytb 1 -i pipe:0"  // Video data only on stdin
                + (includeAudio == true ? " -f aac -vn -thread_queue_size 1024 -i pipe:3" : "");  // Audio data only on extra pipe created in spawn command

            // Build our video command for ffmpeg
            var ffmpegVideo = " -map 0:v"   // stdin, the first input is video data
                + " -max_muxing_queue_size 9999"
                + " -codec:v " + recordCodec;

            if (recordCodec == VideoCodecs.LIBX264 || recordCodec == VideoCodecs.H264_OMX || recordCodec == VideoCodecs.H264_V4L2M2M) {
                // Configure for libx264 (software encoder) or H264_omx (RPI Hardware enccoder)
                    ffmpegVideo = ffmpegVideo 
                    + " -pix_fmt yuv420p"
                    + (recordCodec != VideoCodecs.H264_V4L2M2M ? " -profile:v " + ((this.HKSVRecordingConfig.videoCodec.parameters.profile == H264Profile.HIGH) ? "high" : (this.HKSVRecordingConfig.videoCodec.parameters.profile == H264Profile.MAIN) ? "main" : "baseline") : "")
                    + (recordCodec == VideoCodecs.LIBX264 ? " -level:v " + ((this.HKSVRecordingConfig.videoCodec.parameters.level == H264Level.LEVEL4_0) ? "4.0" : (this.HKSVRecordingConfig.videoCodec.parameters.level == H264Level.LEVEL3_2) ? "3.2" : "3.1") : "")
                    + (recordCodec == VideoCodecs.LIBX264 ? " -preset veryfast" : "")
                    + " -b:v " + this.HKSVRecordingConfig.videoCodec.parameters.bitRate + "k"
                    + " -filter:v fps=" + this.HKSVRecordingConfig.videoCodec.resolution[2]; // convert to framerate HomeKit has requested
            }

            ffmpegVideo = ffmpegVideo 
                + " -force_key_frames expr:gte\(t,n_forced*" + this.HKSVRecordingConfig.videoCodec.parameters.iFrameInterval / 1000 + "\)"
               // + " -fflags +genpts+discardcorrupt"
                + " -fflags +nobuffer"
                //+ " -reset_timestamps 1"
                + " -movflags frag_keyframe+empty_moov+default_base_moof"

            // We have seperate video and audio streams that need to be muxed together if audio recording enabled
            var ffmpegAudio = "";   // No audio yet command yet
            if (includeAudio == true) {
                var audioSampleRates = ["8", "16", "24", "32", "44.1", "48"];

                ffmpegAudio = " -map 1:a"   // pipe:3, the second input is audio data
                    + " -codec:a " + AudioCodecs.LIBFDK_AAC
                    + " -profile:a aac_eld" // this.HKSVRecordingConfig.audioCodec.type == AudioRecordingCodecType.AAC_ELD
                    + " -ar " + audioSampleRates[this.HKSVRecordingConfig.audioCodec.samplerate] + "k"
                    + " -b:a " + this.HKSVRecordingConfig.audioCodec.bitrate + "k"
                    + " -ac " + this.HKSVRecordingConfig.audioCodec.audioChannels;
            }

            var ffmpegOutput = " -f mp4"    // output is an mp4
                + " -avoid_negative_ts make_zero"
                + " pipe:1";    // output to stdout

            // Build our completed ffmpeg commandline
            var ffmpegCommand = ffmpeg + ffmpegVideo + ffmpegAudio + ffmpegOutput;
            
            this.HKSVRecorder.mp4boxes = [];
            this.HKSVRecorder.ffmpeg = spawn(ffmpegPath || "ffmpeg", ffmpegCommand.split(" "), { env: process.env, stdio: ["pipe", "pipe", "pipe", "pipe"] });    // Extra pipe, #3 for audio data
            //config.debug.includes(Debugging.HKSV) && console.debug(getTimestamp() + " [NEST] ffmpeg recording command is %s", ffmpegCommand);

            this.HKSVRecorder.video = this.HKSVRecorder.ffmpeg.stdin;   // Video data on stdio pipe for ffmpeg
            this.HKSVRecorder.audio = (includeAudio == true ? this.HKSVRecorder.ffmpeg.stdio[3] : null);    // Audio data on extra pipe for ffmpeg or null if audio recording disabled

            // Process FFmpeg output and parse out the fMP4 stream it's generating for HomeKit Secure Video.
            var pendingData = Buffer.alloc(0);
            var mp4segment = {header: Buffer.alloc(0), size: 0, type: "", data: Buffer.alloc(0)};
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
                    this.HKSVRecorder.mp4boxes.push({ header: mp4segment.header, type: mp4segment.type, data: mp4segment.data });
                    this.events.emit(this.deviceData.nest_device_structure + MP4BOX);

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
                    config.debug.includes(Debugging.FFMPEG) && console.debug(getTimestamp() + " [FFMPEG] ffmpeg recorder process exited", code, signal);
                }
            });

            this.HKSVRecorder.ffmpeg.on("error", (error) => {
                config.debug.includes(Debugging.FFMPEG) && console.debug(getTimestamp() + " [FFMPEG] ffmpeg recorder process error", error);
            });

            // ffmpeg outputs to stderr
            this.HKSVRecorder.ffmpeg.stderr.on("data", (data) => {
                if (data.toString().includes("frame=") == false) {
                    // Monitor ffmpeg output while testing. Use "ffmpeg as a debug option"
                    config.debug.includes(Debugging.FFMPEG) && console.debug(getTimestamp() + " [FFMPEG]", data.toString());
                }
            });

            this.NexusStreamer.startRecordStream("HKSV" + streamId, this.HKSVRecorder.ffmpeg, this.HKSVRecorder.video, this.HKSVRecorder.audio, true, 0);
            config.debug.includes(Debugging.HKSV) && console.debug(getTimestamp() + " [HKSV] Recording started on '%s' %s %s", this.deviceData.mac_address, (includeAudio == true ? "with audio" : "without audio"), (recordCodec != VideoCodecs.COPY ? "using H264 encoder " + recordCodec : ""));

            // Loop generating either FTYP/MOOV box pairs or MOOF/MDAT box pairs for HomeKit Secure Video.
            // Exit when the recorder process is nolonger running
            // HAP-NodeJS can cancel this async generator function when recording completes also
            var segment = [];
            for(;;) {
                if (this.HKSVRecorder.ffmpeg == null) {
                    // ffmpeg recorder process isnt running, so finish up the loop
                    break;
                }
                
                if (this.HKSVRecorder.mp4boxes.length == 0) {
                    // since the ffmpeg recorder process hasn't notified us of any mp4 fragment boxes, so wait until there are some
                    await EventEmitter.once(this.events, this.deviceData.nest_device_structure + MP4BOX);
                }
            
                var mp4box = this.HKSVRecorder.mp4boxes.shift();
                if (typeof mp4box != "object") {
                    // Not an mp4 fragment box, so try again
                    continue;
                }

                // Queue up this fragment mp4 box to send back to HomeKit
                segment.push(mp4box.header, mp4box.data);

                if (mp4box.type === "moov" || mp4box.type === "mdat") {
                    yield {
                        data: Buffer.concat(segment),
                        isLast: (this.MotionServices[0].service.getCharacteristic(Characteristic.MotionDetected).value == false || this.HKSVRecorder.ffmpeg == null)
                    };
                    segment = [];
                }
            }
        }
    }

    closeRecordingStream(streamId, reason) {
        this.NexusStreamer.stopRecordStream("HKSV" + streamId); // Stop the associated recording stream
        this.HKSVRecorder.ffmpeg && this.HKSVRecorder.ffmpeg.kill("SIGKILL"); // Kill the ffmpeg recorder process
        this.HKSVRecorder.ffmpeg = null; // No more ffmpeg process
        this.HKSVRecorder.mp4boxes = []; // Clear mp4box array
        this.HKSVRecorder.video = null; // No more video stream handle
        this.HKSVRecorder.audio = null; // No more audio stream handle
        this.events.emit(this.deviceData.nest_device_structure + MP4BOX);   // This will ensure we clean up out of our segment generator
        this.events.removeAllListeners(this.deviceData.nest_device_structure + MP4BOX);  // Tidy up our event listeners
        if (config.debug.includes(Debugging.HKSV) == true) {
            // Log recording finished messages depending on reason
            if (reason == HDSProtocolSpecificErrorReason.NORMAL) {
                console.debug(getTimestamp() + " [HKSV] Recording completed on '%s'", this.deviceData.mac_address);
            } else {
                console.debug(getTimestamp() + " [HKSV] Recording completed with error on '%s'. Reason was '%s'", this.deviceData.mac_address, HDSProtocolSpecificErrorReason[reason]);
            }
        }
    }

    acknowledgeStream(streamId) {
        this.closeRecordingStream(streamId, HDSProtocolSpecificErrorReason.NORMAL);
    }

    updateRecordingActive(active) {
        // We'll use the change here to determine if we start/stop any buffering.
        // Also track the HomeKit status here as gets called multiple times with no change
        // Might be fixed in HAP-NodeJS 11.x or later, but we'll keep out internal check
        if (active != this.HKSVRecorder.record) {
            if (active == true && this.deviceData.HKSVPreBuffer > 0) {
                // Start a buffering stream for this camera/doorbell. Ensures motion captures all video on motion trigger
                // Required due to data delays by on prem Nest to cloud to HomeKit accessory to iCloud etc
                // Make sure have appropriate bandwidth!!!
                config.debug.includes(Debugging.HKSV) && console.debug(getTimestamp() + " [HKSV] Pre-buffering started for '%s'", this.deviceData.mac_address);
                this.NexusStreamer.startBuffering(this.deviceData.HKSVPreBuffer);
            }
            if (active == false) {
                this.NexusStreamer.stopBuffering();
                config.debug.includes(Debugging.HKSV) && console.debug(getTimestamp() + " [HKSV] Pre-buffering stopped for '%s'", this.deviceData.mac_address);
            }
        }
        this.HKSVRecorder.record = active;
    }

    updateRecordingConfiguration(configuration) {
        this.HKSVRecordingConfig = configuration;   // Store the recording configuration
    }

    async handleSnapshotRequest(request, callback) {
        // Get current image from doorbell/camera
        var image = Buffer.alloc(0);    // Empty buffer

        if (this.deviceData.HKSV == true && this.NexusStreamer != null) {
            // Since HKSV is enabled, try getting a snapshot image from the buffer
            // If no buffering running, the image buffer will still be empty. We can try the old method if that fails 
            image = await this.NexusStreamer.getBufferSnapshot(ffmpegPath);
        }
        if (image.length == 0) {
            if (this.deviceData.streaming_enabled == true && this.deviceData.online == true) {
                if (this.deviceData.HKSV == false && this.snapshotEvent.type != "" && this.snapshotEvent.done == false) {
                    // Grab event snapshot from doorbell/camera stream for a non-HKSV camera
                    await axios.get(this.deviceData.nexus_api_nest_domain_host + "/event_snapshot/" + this.deviceData.camera_uuid + "/" + this.snapshotEvent.id + "?crop_type=timeline&width=" + request.width, {responseType: "arraybuffer", headers: {"user-agent": USERAGENT, "accept" : "*/*", [nest.cameraAPI.key] : nest.cameraAPI.value + nest.cameraAPI.token}, timeout: NESTAPITIMEOUT, retry: 3 /*, retryDelay: 2000 */})
                    .then(response => {
                        if (response.status == 200) {
                            this.snapshotEvent.done = true;  // Successfully got the snapshot for the event
                            image = response.data;
                        }
                    })
                    .catch(error => {
                    });
                }
                if (image.length == 0) {
                    // Still empty image buffer, so try old method for a direct grab
                    await axios.get(this.deviceData.nexus_api_http_server_url + "/get_image?uuid=" + this.deviceData.camera_uuid + "&cachebuster=" + Math.floor(new Date() / 1000), {responseType: "arraybuffer", headers: {"user-agent": USERAGENT, "accept" : "*/*", [nest.cameraAPI.key] : nest.cameraAPI.value + nest.cameraAPI.token}, timeout: NESTAPITIMEOUT/*, retry: 3, retryDelay: 2000 */})
                    .then(response => {
                        if (response.status == 200) {
                            image = response.data;
                        }
                    })
                    .catch(error => {
                    });
                }
            }

            if (this.deviceData.streaming_enabled == false && this.deviceData.online == true) { 
                // Return "camera switched off" jpg to image buffer
                image = this.camera_off_h264_jpg;
            }
    
            if (this.deviceData.online == false) {
                // Return "camera offline" jpg to image buffer
                image = this.camera_offline_h264_jpg;
            }
        }

        callback(null, image);
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
            videoSSRC: CameraController.generateSynchronisationSource(),

            audioPort: request.audio.port,
            localAudioPort: await this.#getPort(),
            audioTalkbackPort: await this.#getPort(),
            rptSplitterPort: await this.#getPort(),
            audioCryptoSuite: request.video.srtpCryptoSuite,
            audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
            audioSSRC: CameraController.generateSynchronisationSource(),

            rtpSplitter: null,
            ffmpeg: [], // Array of ffmpeg process we create for streaming video/audio and audio talkback
            video: null,
            audio: null
        };

        // Build response back to HomeKit with our details
        var response = {
            address: ip.address("public", request.addressVersion), // ip Address version must match
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
        // called when HomeKit asks stream to start/stop/reconfigure
        switch (request.type) {
            case "start" : {
                this.ongoingSessions[request.sessionID] = this.pendingSessions[request.sessionID];  // Move our pending session to ongoing session
                delete this.pendingSessions[request.sessionID]; // remove this pending session information

                var includeAudio = (this.deviceData.audio_enabled == true);

                // Build our ffmpeg command string for the video stream
                var ffmpeg = "-hide_banner"
                    + " -use_wallclock_as_timestamps 1"
                    + " -f h264 -an -thread_queue_size 1024 -copytb 1 -i pipe:0"  // Video data only on stdin
                    + (includeAudio == true ? " -f aac -vn -thread_queue_size 1024 -i pipe:3" : "");  // Audio data only on extra pipe created in spawn command
        
                // Build our video command for ffmpeg
                var ffmpegVideo = " -map 0:v"   // stdin, the first input is video data
                    + " -max_muxing_queue_size 9999"
                    + " -codec:v copy"
                    + " -fflags +nobuffer"
                    + " -payload_type " + request.video.pt
                    + " -ssrc " + this.ongoingSessions[request.sessionID].videoSSRC
                    + " -f rtp"
                    + " -avoid_negative_ts make_zero"
                    + " -srtp_out_suite " + SRTPCryptoSuites[this.ongoingSessions[request.sessionID].videoCryptoSuite] + " -srtp_out_params " + this.ongoingSessions[request.sessionID].videoSRTP.toString("base64")
                    + " srtp://" + this.ongoingSessions[request.sessionID].address + ":" + this.ongoingSessions[request.sessionID].videoPort + "?rtcpport=" + this.ongoingSessions[request.sessionID].videoPort + "&localrtcpport=" + this.ongoingSessions[request.sessionID].localVideoPort + "&pkt_size=" + request.video.mtu;

                // We have seperate video and audio streams that need to be muxed together if audio enabled
                var ffmpegAudio = "";      // No audio yet command yet
                if (includeAudio == true) {
                    ffmpegAudio = " -map 1:a"   // pipe:3, the second input is audio data
                        + " -codec:a " + AudioCodecs.LIBFDK_AAC
                        + " -profile:a aac_eld" // request.codec == "ACC-eld"
                        + " -flags +global_header"
                        + " -ar " + request.audio.sample_rate + "k"
                        + " -b:a " + request.audio.max_bit_rate + "k"
                        + " -ac " + request.audio.channel 
                        + " -payload_type " + request.audio.pt
                        + " -ssrc " + this.ongoingSessions[request.sessionID].audioSSRC
                        + " -f rtp"
                        + " -srtp_out_suite " + SRTPCryptoSuites[this.ongoingSessions[request.sessionID].audioCryptoSuite] + " -srtp_out_params " + this.ongoingSessions[request.sessionID].audioSRTP.toString("base64")
                        + " srtp://" + this.ongoingSessions[request.sessionID].address + ":" + this.ongoingSessions[request.sessionID].audioPort + "?rtcpport=" + this.ongoingSessions[request.sessionID].audioPort + "&localrtcpport=" + this.ongoingSessions[request.sessionID].localAudioPort + "&pkt_size=188";
                }

                // Build our completed ffmpeg commandline
                var ffmpegCommand = ffmpeg + ffmpegVideo + ffmpegAudio; 

                // Start our ffmpeg streaming process and stream from nexus
                config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Live stream started on '%s'", this.deviceData.mac_address);
                var ffmpegStreaming = spawn(ffmpegPath || "ffmpeg", ffmpegCommand.split(" "), { env: process.env, stdio: ["pipe", "pipe", "pipe", "pipe"] });    // Extra pipe, #3 for audio data
                this.NexusStreamer && this.NexusStreamer.startLiveStream(request.sessionID, ffmpegStreaming.stdin, (includeAudio == true && ffmpegStreaming.stdio[3] ? ffmpegStreaming.stdio[3] : null), false);

                // ffmpeg console output is via stderr
                ffmpegStreaming.stderr.on("data", (data) => {
                    // If ffmpeg is slow to start frames, produces "slow to respond" error from HAP-NodeJS
                    if (typeof callback == "function") {
                        callback();  // Notify HomeKit we've started video stream
                        callback = null;    // Signal we've done the callback by clearing it
                    }
                    if (data.toString().includes("frame=") == false) {
                        // Monitor ffmpeg output while testing. Use "ffmpeg as a debug option"
                        config.debug.includes(Debugging.FFMPEG) && console.debug(getTimestamp() + " [FFMPEG]", data.toString());
                    }
                });

                ffmpegStreaming.on("exit", (code, signal) => {
                    if (signal != "SIGKILL" || signal == null) {
                        config.debug.includes(Debugging.FFMPEG) && console.debug(getTimestamp() + " [FFMPEG] Audio/Video streaming processes stopped", code, signal);
                        if (typeof callback == "function") callback(new Error("ffmpeg process creation failed!"));
                        callback = null;    // Signal we've done the callback by clearing it
                        this.controller.forceStopStreamingSession(request.sessionID);
                    }
                });

                // We only create the the rtpsplitter and ffmpeg processs if twoway audio is supported AND audio enabled on doorbell/camera
                var ffmpegAudioTalkback = null;   // No ffmpeg process for return audio yet
                if (includeAudio == true && this.audioTalkback == true) {
                    // Setup RTP splitter for two/away audio
                    this.ongoingSessions[request.sessionID].rtpSplitter = dgram.createSocket("udp4");
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
                    this.ongoingSessions[request.sessionID].rtpSplitter.bind(this.ongoingSessions[request.sessionID].rptSplitterPort);

                    // Build ffmpeg command
                    var ffmpegCommand = "-hide_banner"
                        + " -protocol_whitelist pipe,udp,rtp,file,crypto"
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
                
                    ffmpegAudioTalkback = spawn(ffmpegPath || "ffmpeg", ffmpegCommand.split(" "), { env: process.env });
                    ffmpegAudioTalkback.on("error", (error) => {
                        config.debug.includes(Debugging.FFMPEG) && console.debug(getTimestamp() + " [FFMPEG] Failed to start Nest camera talkback audio process", error.message);
                        if (typeof callback == "function") callback(new Error("ffmpeg process creation failed!"));
                        callback = null;    // Signal we've done the callback by clearing it
                    });

                    ffmpegAudioTalkback.stderr.on("data", (data) => {
                        if (data.toString().includes("size=") == false) {
                            // Monitor ffmpeg output while testing. Use "ffmpeg as a debug option"
                            config.debug.includes(Debugging.FFMPEG) && console.debug(getTimestamp() + " [FFMPEG]", data.toString());
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
                        + "a=crypto:1 " + SRTPCryptoSuites[this.ongoingSessions[request.sessionID].audioCryptoSuite] + " inline:" + this.ongoingSessions[request.sessionID].audioSRTP.toString("base64"));
                    ffmpegAudioTalkback.stdin.end();

                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Audio talkback stream started for '%s'", this.deviceData.mac_address);
                    this.NexusStreamer && this.NexusStreamer.startTalkStream(request.sessionID, ffmpegAudioTalkback.stdout);
                }

                // Store our ffmpeg sessions
                ffmpegStreaming && this.ongoingSessions[request.sessionID].ffmpeg.push(ffmpegStreaming);  // Store ffmpeg process ID
                ffmpegAudioTalkback && this.ongoingSessions[request.sessionID].ffmpeg.push(ffmpegAudioTalkback);  // Store ffmpeg audio return process ID
                this.ongoingSessions[request.sessionID].video = request.video;  // Cache the video request details
                this.ongoingSessions[request.sessionID].audio = request.audio;  // Cache the audio request details
                break;
            }

            case "stop" : {
                if (typeof this.ongoingSessions[request.sessionID] == "object") {
                    this.NexusStreamer && this.NexusStreamer.stopTalkStream(request.sessionID);
                    this.NexusStreamer && this.NexusStreamer.stopLiveStream(request.sessionID);
                    this.ongoingSessions[request.sessionID].rtpSplitter && this.ongoingSessions[request.sessionID].rtpSplitter.close();
                    this.ongoingSessions[request.sessionID].ffmpeg && this.ongoingSessions[request.sessionID].ffmpeg.forEach(ffmpeg => {
                        ffmpeg && ffmpeg.kill("SIGKILL"); // Kill this ffmpeg process
                    });
                    this.controller.forceStopStreamingSession(request.sessionID);
                    delete this.ongoingSessions[request.sessionID]; // this session has finished
                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Live stream stopped on '%s'", this.deviceData.mac_address);
                }
                callback();
                break;
            }

            case "reconfigure" : {
                // todo - implement???
                //config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Reconfiguration request for live stream on '%s'", this.deviceData.mac_address);
                callback();
                break;
            }
        }
    }

    updateHomeKitServices(deviceData) {
        this.HomeKitAccessory.getService(Service.AccessoryInformation).updateCharacteristic(Characteristic.FirmwareRevision, deviceData.software_version);   // Update firmware version
        this.controller.setSpeakerMuted(deviceData.audio_enabled == false ? true : false);    // if audio is disabled, we'll mute speaker

        if (deviceData.HKSV == true) {
            // Update camera off/on status for HKSV from Nest
            this.controller.recordingManagement.operatingModeService.updateCharacteristic(Characteristic.ManuallyDisabled, (deviceData.streaming_enabled == true ? Characteristic.ManuallyDisabled.ENABLED : Characteristic.ManuallyDisabled.DISABLED));

            // TODO: If bugs fixed in HAPNodeJS and/or HomeKit for HSKV the below will work correcly
            if (deviceData.capabilities.includes("status") == true) {
                //this.controller.recordingManagement.operatingModeService.updateCharacteristic(Characteristic.CameraOperatingModeIndicator, Characteristic.CameraOperatingModeIndicator.ENABLE);    // Always enabled for Nest?
            }
            if (deviceData.capabilities.includes("irled") == true) {
                // Set nightvision status in HomeKit
                this.controller.recordingManagement.operatingModeService.updateCharacteristic(Characteristic.NightVision, (deviceData.properties["irled.state"] && deviceData.properties["irled.state"].toUpperCase() == "ALWAYS_OFF" ? false : true));
            }
        }

        // Update any camera details if we have a Nexus streamer object created
        this.NexusStreamer && this.NexusStreamer.update(nest.cameraAPI.token, nest.tokenType, deviceData);

        // If both speaker & microphone capabilities, then we support twoway audio
        this.audioTalkback = (deviceData.capabilities.includes("audio.speaker") && deviceData.capabilities.includes("audio.microphone")) ? true : false;

        if (deviceData.nest_aware != this.deviceData.nest_aware) {
            // Nest aware subscription status has changed
            console.log("Nest Aware subscription for '%s' is", this.HomeKitAccessory.username, (deviceData.nest_aware == true ? "active" : "not active"))
        }

        // For non-HKSV enabled devices, we process activity zone changes
        if (deviceData.HKSV == false && (JSON.stringify(deviceData.activity_zones) != this.deviceData.activity_zones)) {
            // Check to see if any activity zones were added
            deviceData.activity_zones.forEach(zone => {
                if (zone.id != 0) {
                    var index = this.MotionServices.findIndex( ({ id }) => id == zone.id);
                    if (index == -1) {
                        // Zone doesn't have an associated motion sensor, so add one
                        var tempService = this.HomeKitAccessory.addService(Service.MotionSensor, zone.name, zone.id);
                        this.MotionServices.push({"service": tempService, "id": zone.id})
                    } else {
                        // found an associated motion sensor for this zone, so update name
                        this.MotionServices[index].service.updateCharacteristic(Characteristic.Name, zone.name);
                    }
                }
            });

            // Check to see if any activity zones were removed
            this.MotionServices.forEach((motionService, index) => {
                if (motionService.id != 0) {
                    if (deviceData.activity_zones.findIndex( ({ id }) => id == motionService.id) == -1) {
                        // Motion service we created doesn't appear in zone list anymore, so assume deleted
                        this.HomeKitAccessory.removeService(motionService.service);
                        this.MotionServices.splice(index, 1);
                    }
                }
            });
        }

        // Process alerts, most recent first
        // For HKSV, we're interested in doorbell and motion events
        // For non-HKSV, we're interested in doorbell, face and person events (maybe sound and package later)
        deviceData.alerts.reverse().forEach(async event => {
            // Handle doorbell event, should always be handled first
            // We'll always process a doorbell press event regardless of Characteristic.HomeKitCameraActive state in HKSV
            if (typeof this.controller.doorbellService == "object" && event.types.includes("doorbell") == true) {
                if (this.doorbellTimer == null) {
                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Doorbell pressed on '%s'", this.deviceData.mac_address);
                    
                    // Cooldown for doorbell button being pressed (filters out constant pressing for time period)
                    // Start this before we process further
                    this.doorbellTimer = setTimeout(() => {
                        this.snapshotEvent = {type: "", time: 0, id: 0, done: false}; // Clear snapshot event image after timeout
                        this.doorbellTimer = null;  // No doorbell timer active
                    }, deviceData.doorbellCooldown);

                    if (event.types.includes("motion") == false) {
                        // No motion event with the doorbell alert, so add one to support any HKSV recording
                        event.types.push("motion");
                    }

                    this.snapshotEvent = {type: "ring", time: event.playback_time, id : event.id, done: false}; // needed for a HKSV enabled doorbell???
                    this.controller.ringDoorbell(); // Finally "ring" doorbell
                    this.historySevice && this.historyService.addHistory(this.controller.doorbellService, {time: Math.floor(new Date() / 1000), status: 1});   // Doorbell pressed history
                    this.historySevice && this.historyService.addHistory(this.controller.doorbellService, {time: Math.floor(new Date() / 1000), status: 0});   // Doorbell un-pressed history
                }
            }

            if (this.MotionServices.length >= 1) {
                // We have at least one motion sensor service, so allows us to proceed here

                // Handle motion event only for HKSV enabled camera. We will use this to trigger the starting of the HKSV recording
                // Motion is only activated if configured via Characteristic.HomeKitCameraActive == 1 (on)
                if (deviceData.HKSV == true && event.types.includes("motion") == true) {

                    this.HKSVRecorder.time = event.playback_time; // Timestamp for playback from Nest for the detected motion

                    if (this.controller.recordingManagement.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive).value == Characteristic.HomeKitCameraActive.ON) {
                        if (this.MotionServices[0].service.getCharacteristic(Characteristic.MotionDetected).value != true) {
                            // Make sure if motion detected, the motion sensor is still active
                            config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Motion started on '%s'", this.deviceData.mac_address);
                            this.MotionServices[0].service.updateCharacteristic(Characteristic.MotionDetected, true);    // Trigger motion
                            this.historySevice && this.historyService.addHistory(this.MotionServices[0].service, {time: Math.floor(new Date() / 1000), status: 1});   // Motion started for history
                        }

                        clearTimeout(this.motionTimer); // Clear any motion active timer so we can extend
                        this.motionTimer = setTimeout(() => {
                            config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Motion ended on '%s'", this.deviceData.mac_address);
                            this.MotionServices[0].service.updateCharacteristic(Characteristic.MotionDetected, false);  // clear motion
                            this.historySevice && this.historyService.addHistory(this.MotionServices[0].service, {time: Math.floor(new Date() / 1000), status: 0});   // Motion ended for history
                            this.motionTimer = null;   // No motion timer active
                        }, deviceData.motionCooldown);
                    }
                }

                // Handle person/face event for non HKSV enabled cameras and only those marked as important
                // We also treat a "face" event the same as a person event ie: if have a face, you have a person
                if (deviceData.HKSV == false && (event.types.includes("person") == true || event.types.includes("face") == true)) {
                    if (event.is_important == true && this.doorbellTimer == null && this.personTimer == null) {
                        config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Person detected on '%s'", this.deviceData.mac_address);

                        // Cooldown for person being detected
                        // Start this before we process further
                        this.personTimer = setTimeout(() => {
                            this.snapshotEvent = {type: "", time: 0, id: 0, done: false}; // Clear snapshot event image after timeout
                            this.historySevice && this.historyService.addHistory(this.MotionServices[0].service, {time: Math.floor(new Date() / 1000), status: 0});   // Motion ended for history
                            this.MotionServices.forEach((motionService, index) => { 
                                motionService.service.updateCharacteristic(Characteristic.MotionDetected, false);  // clear any motion
                            });
                            this.personTimer = null;  // No person timer active
                        }, deviceData.personCooldown);

                        // Check which zone triggered the person alert and update associated motion sensor(s)
                        this.historySevice && this.historyService.addHistory(this.MotionServices[0].service, {time: Math.floor(new Date() / 1000), status: 1});   // Motion started for history
                        this.snapshotEvent = {type: "person", time: event.playback_time, id : event.id, done: false};
                        event.zone_ids.forEach(zoneID => {
                            var index = this.MotionServices.findIndex( ({ id }) => id == zoneID);
                            if (index != -1) {
                                this.MotionServices[index].service.updateCharacteristic(Characteristic.MotionDetected, true);    // Trigger motion for matching zone
                            }
                        });
                    }
                }

                // Handle motion event for non HKSV enabled cameras
                // TODO
                if (deviceData.HKSV == false && event.types.includes("motion") == true) { 
                }
            }

            // Handle package event for non HKSV enabled cameras
            // TODO
            if (deviceData.HKSV == false && event.types.includes("package") == true) {
            }
            
            // Handle sound event for non HKSV enabled cameras
            // TODO
            if (deviceData.HKSV == false && event.types.includes("sound") == true) {
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


// Create weather object
class WeatherClass extends NestDevice {
    constructor(deviceData, eventEmitter) {
        super(deviceData, eventEmitter)
 
        this.BatteryService = null;
        this.airPressureService = null;
        this.TemperatureService = null;
        this.HumidityService = null;
    }


    // Class functions 
    addHomeKitServices(serviceName) {
        this.TemperatureService = this.HomeKitAccessory.addService(Service.TemperatureSensor, serviceName, 1);
        this.airPressureService = this.HomeKitAccessory.addService(Service.EveAirPressureSensor, "", 1);
        this.HumidityService = this.HomeKitAccessory.addService(Service.HumiditySensor, serviceName, 1);  
        this.BatteryService = this.HomeKitAccessory.addService(Service.BatteryService, "", 1);
        this.BatteryService.updateCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE);    // Really not chargeable ;-)

        // Add custom weather characteristics
        this.TemperatureService.addCharacteristic(Characteristic.ForecastDay);
        this.TemperatureService.addCharacteristic(Characteristic.ObservationStation);
        this.TemperatureService.addCharacteristic(Characteristic.Condition);
        this.TemperatureService.addCharacteristic(Characteristic.WindDirection);
        this.TemperatureService.addCharacteristic(Characteristic.WindSpeed);
        this.TemperatureService.addCharacteristic(Characteristic.SunriseTime);
        this.TemperatureService.addCharacteristic(Characteristic.SunsetTime);

        this.HomeKitAccessory.setPrimaryService(this.TemperatureService);

        // Setup linkage to EveHome app if configured todo so
        this.deviceData.EveApp && this.historyService && this.historyService.linkToEveHome(this.HomeKitAccessory, this.airPressureService, {debug: config.debug.includes("HISTORY")});

        console.log("Setup Nest virtual weather station '%s' on '%s'", serviceName, this.HomeKitAccessory.username);
    }

    updateHomeKitServices(deviceData) {
        if (this.TemperatureService != null && this.HumidityService != null && this.BatteryService != null && this.airPressureService != null) {
            this.BatteryService.updateCharacteristic(Characteristic.BatteryLevel, 100); // Always %100
            this.BatteryService.updateCharacteristic(Characteristic.StatusLowBattery, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);

            this.TemperatureService.updateCharacteristic(Characteristic.CurrentTemperature, deviceData.current_temperature);
            this.HumidityService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);
            this.airPressureService.getCharacteristic(Characteristic.EveAirPressure, 0);
            this.airPressureService.updateCharacteristic(Characteristic.EveElevation, 610);

            // Update custom characteristics
            this.TemperatureService.updateCharacteristic(Characteristic.ForecastDay, deviceData.forecast);
            this.TemperatureService.updateCharacteristic(Characteristic.ObservationStation, deviceData.station);
            this.TemperatureService.updateCharacteristic(Characteristic.Condition, deviceData.condition);
            this.TemperatureService.updateCharacteristic(Characteristic.WindDirection, deviceData.wind_direction);
            this.TemperatureService.updateCharacteristic(Characteristic.WindSpeed, deviceData.wind_speed);
            this.TemperatureService.updateCharacteristic(Characteristic.SunriseTime, new Date(deviceData.sunrise * 1000).toLocaleTimeString());
            this.TemperatureService.updateCharacteristic(Characteristic.SunsetTime, new Date(deviceData.sunset * 1000).toLocaleTimeString());

            // Record history
            if ((deviceData.current_temperature != this.deviceData.current_temperature) || (deviceData.current_humidity != this.deviceData.current_humidity)) {
                this.historySevice && this.historyService.addHistory(this.airPressureService, {time: Math.floor(new Date() / 1000), temperature: deviceData.current_temperature, humidity: deviceData.current_humidity, pressure: 0}, 300);
            }
        }
    }
}


// NestSystem class
//
// Handles access to/from the Nest system
const CAMERAALERTPOLLING = 2000;                                            // Camera alerts polling timer
const CAMERAZONEPOLLING = 30000;                                            // Camera zones changes polling timer
const WEATHERPOLLING = 300000;                                              // Refresh weather data every 5mins
const SUBSCRIBETIMEOUT = 120000;                                            // Timeout for no subscription data
const NESTAPITIMEOUT = 10000;                                               // Calls to Nest API timeout
const USERAGENT = "Nest/5.69.0 (iOScom.nestlabs.jasper.release) os=15.6";   // User Agent string
const NESTAPIHOST = "https://home.nest.com";                                // Root URL for Nest system API
const REFERER = "https://home.nest.com"                                     // Which hist is "actually" doing the request
const CAMERAAPIHOST = "https://webapi.camera.home.nest.com";                // Root URL for Camera system API


const NESTSYSTEMEVENT = {
    SETELEMENT : "setElement",
    STRUCTURECHANGE : "structureChange",
    NEWDEVICE : "newDevice"
}

class NestSystem {
	constructor(token, tokenType, eventEmitter) {
        this.initialToken = token;                          // Inital token to access Nest system
        this.tokenType = tokenType;                         // Type of account we authorised to Nest with
        this.nestAPIToken = "";                             // Access token for Nest API requests
        this.tokenExpire = null;                            // Time when token expires (in Unix timestamp)
        this.tokenTimer = null;                             // Handle for token refresh timer
        this.cameraAPI = {key: "", value: "", token: ""};   // Header Keys for camera API calls
        this.transport_url = "";                            // URL for Nest API requests
        this.weather_url = "";                              // URL for Nest weather API
        this.userID = "";                                   // User ID
        this.rawData = {};                                  // Full copy of nest structure data
        this.abortController = new AbortController();       // Abort controller object
        this.events = eventEmitter;                         // Global event emitter
        this.subscribePollingTimers = [];                   // Array of polling timers where we cannot do subscribe requests
        this.startTime = null;                              // Time we started the object. used to filter out old alerts

        // Setup event processing for set/get properties
        this.events.addListener(NESTSYSTEMEVENT.SETELEMENT, this.#setElement.bind(this));

        // Time we create this object. Used to filter camera alert events out before this started
        this.startTime = Math.floor(new Date() / 1000);
    }

    
    // Class functions
    async connect() {
        // Connect to Nest. We support the Nest session token and Google cookie methods
        var tempToken = ""; 
        this.tokenExpire = null;    // Get below
        if (this.tokenType == "google") {
            // Google cookie method as refresh token method no longer supported by Google since October 2022
            // Instructions from homebridge_nest or homebridge_nest_cam to obtain this
            console.debug(getTimestamp() + " [NEST] Performing Google account authorisation");
            await axios.get(this.initialToken.issuetoken, {headers: {"user-agent": USERAGENT, "cookie": this.initialToken.cookie, "referer": "https://accounts.google.com/o/oauth2/iframe", "Sec-Fetch-Mode": "cors", "X-Requested-With": "XmlHttpRequest"} })
            .then(async (response) => {
                if (response.status == 200) {
                    await axios.post("https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt", "embed_google_oauth_access_token=true&expire_after=3600s&google_oauth_access_token=" + response.data.access_token + "&policy_id=authproxy-oauth-policy", {headers: {"referer": REFERER,"user-agent": USERAGENT, "Authorization": "Bearer " + response.data.access_token} })
                    .then(async (response) => {
                        tempToken = response.data.jwt;
                        this.tokenType = "google";  // Google account
                        this.tokenExpire = Math.floor(new Date(response.data.claims.expirationTime) / 1000);   // Token expiry, should be 1hr
                        this.cameraAPI.key = "Authorization"; // We'll put this in API header calls for cameras
                        this.cameraAPI.value = "Basic ";    // NOTE: space at end of string. Required
                        this.cameraAPI.token = response.data.jwt; // We'll put this in API header calls for cameras
                    })
                }
            })
            .catch(error => {
            });
        }

        if (this.tokenType == "nest") {
            // Nest session token method. Get WEBSITE2 cookie for use with camera API calls if needed later
            console.debug(getTimestamp() + " [NEST] Performing Nest account authorisation");
            await axios.post(CAMERAAPIHOST + "/api/v1/login.login_nest", Buffer.from("access_token=" + this.initialToken, "utf8"), {withCredentials: true, headers: {"referer": REFERER, "Content-Type": "application/x-www-form-urlencoded", "user-agent": USERAGENT} })
            .then((response) => {
                if (response.status == 200 && response.data && response.data.status == 0) {
                    tempToken = this.initialToken; // Since we got camera details, this is a good token to use
                    this.tokenType = "nest";  // Nest account
                    this.cameraAPI.key = "cookie";  // We'll put this in API header calls for cameras
                    this.cameraAPI.value = "website_2=";
                    this.cameraAPI.token = response.data.items[0].session_token; // We'll put this in API header calls for cameras
                }
            })
            .catch(error => {
            });
        }

        if (tempToken != "") {
            // We have a token, so open Nest session to get further details we require
            await axios.get(NESTAPIHOST + "/session", {headers: {"user-agent": USERAGENT, "Authorization": "Basic " + tempToken} })
            .then((response) => {
                if (response.status == 200) {
                    this.transport_url = response.data.urls.transport_url;
                    this.weather_url = response.data.urls.weather_url;
                    this.userID = response.data.userid;

                    if (this.tokenExpire == null) {
                        this.tokenExpire = Math.floor(Date.now() / 1000) + (3600 * 24);  // 24hrs expiry from now
                    }
                    
                    this.nestAPIToken = tempToken; // Since we've successfully gotten Nest user data, store token for later. Means valid token

                    // Set timeout for token expiry refresh
                    clearInterval(this.tokenTimer)
                    this.tokenTimer = setTimeout(async () => {
                        console.debug(getTimestamp() + " [NEST] Performing token expiry refresh");
                        this.connect();
                    }, (this.tokenExpire - Math.floor(Date.now() / 1000) - 60) * 1000); // Refresh just before token expiry
                    console.debug(getTimestamp() + " [NEST] Successfully authorised to Nest");
                }
            })
            .catch(error => {
            });
        } else {
            console.debug(getTimestamp() + " [NEST] Authorisation to Nest failed");
        }
        return tempToken;
    }

    async getData() {
        if (this.nestAPIToken != "" && this.transport_url != "" && this.userID != "") {
            await axios.get(this.transport_url + "/v3/mobile/user." + this.userID, {headers: {"content-type": "application/json", "user-agent": USERAGENT, "Authorization": "Basic " + this.nestAPIToken}, data: ""})
               .then(async (response)=> {
                if (response.status == 200) {
                    this.rawData = response.data;    // Used to generate subscribed versions/times

                    // Fetch other details for any doorbells/cameras we have, such as activity zones etc. We'll merge this into the Nest structure for processing
                    this.rawData.quartz && await Promise.all(Object.entries(this.rawData.quartz).map(async ([deviceID, camera]) => {
                        this.rawData.quartz[deviceID].nexus_api_nest_domain_host = camera.nexus_api_http_server_url.replace(/dropcam.com/ig, "camera.home.nest.com");  // avoid extra API call to get this detail by simple domain name replace
                        this.rawData.quartz[deviceID].activity_zones = [];  // no activity zones yet
                        this.rawData.quartz[deviceID].alerts = [];  // no active alerts yet
                        this.rawData.quartz[deviceID].properties = [];  // no properties yet

                        // Get doorbell/camera activity zone details
                        await axios.get(this.rawData.quartz[deviceID].nexus_api_nest_domain_host + "/cuepoint_category/" + deviceID, {headers: {"user-agent": USERAGENT, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: NESTAPITIMEOUT, retry: 3, retryDelay: 1000})
                        .then(async (response) => {
                            if (response.status && response.status == 200) {
                                // Insert activity zones into the nest structure
                                response.data.forEach(zone => {
                                    if (zone.type.toUpperCase() == "ACTIVITY" || zone.type.toUpperCase() == "REGION") {
                                        this.rawData.quartz[deviceID].activity_zones.push({"id" : zone.id, "name" : this.#makeValidHomeKitName(zone.label), "hidden" : zone.hidden, "uri" : zone.nexusapi_image_uri});
                                    }
                                });
                            }
                        })
                        .catch(error => {
                        });

                        // Get doorbell/camera properties
                        await axios.get(CAMERAAPIHOST + "/api/cameras.get_with_properties?uuid=" + deviceID, {headers: {"user-agent": USERAGENT, "Referer" : REFERER, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: NESTAPITIMEOUT, retry: 3, retryDelay: 1000})
                        .then((response) => {
                            if (response.status && response.status == 200) {
                                // Insert extra camera properties. We need this information to use with HomeKit Secure Video
                                this.rawData.quartz[deviceID].properties = response.data.items[0].properties;
                            }
                        })
                        .catch(error => {
                        });
                    }));

                    // Get weather data. We'll merge this into the Nest structure for processing
                    this.rawData.structure && await Promise.all(Object.entries(this.rawData.structure).map(async ([structureID, structureData]) => {
                        this.rawData.structure[structureID].weather = {}; // We'll store Weather data will be here
                        await  axios.get(this.weather_url + structureData.latitude + "," + structureData.longitude, {headers: {"user-agent": USERAGENT, timeout: 10000}})
                        .then(response => {
                            if (response.status == 200) {
                                this.rawData.structure[structureID].weather.current_temperature = response.data[structureData.latitude + "," + structureData.longitude].current.temp_c;
                                this.rawData.structure[structureID].weather.current_humidity = response.data[structureData.latitude + "," + structureData.longitude].current.humidity;
                                this.rawData.structure[structureID].weather.condition = response.data[structureData.latitude + "," + structureData.longitude].current.condition;
                                this.rawData.structure[structureID].weather.wind_direction = response.data[structureData.latitude + "," + structureData.longitude].current.wind_dir;
                                this.rawData.structure[structureID].weather.wind_speed = (response.data[structureData.latitude + "," + structureData.longitude].current.wind_mph * 1.609344);    // convert to km/h
                                this.rawData.structure[structureID].weather.sunrise = response.data[structureData.latitude + "," + structureData.longitude].current.sunrise;
                                this.rawData.structure[structureID].weather.sunset = response.data[structureData.latitude + "," + structureData.longitude].current.sunset;
                                this.rawData.structure[structureID].weather.station = response.data[structureData.latitude + "," + structureData.longitude].location.short_name;
                                this.rawData.structure[structureID].weather.forecast = response.data[structureData.latitude + "," + structureData.longitude].forecast.daily[0].condition;
                            }
                        })
                        .catch(error => {
                        });
                    }));
                }
                else {
                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Failed to get Nest data. HTTP status returned", response.status);
                }
            })
            .catch(error => {
                config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Nest data get failed with error", error.message);
            });
        }
    }

    processData() {
        var devices = {};

        this.rawData.device && Object.entries(this.rawData.device).forEach(([deviceID, thermostat]) => {
            // process thermostats
            thermostat.serial_number = thermostat.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = thermostat.mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);
            
            var tempDevice = {};
            tempDevice.excluded = config.excludedDevices.includes(thermostat.serial_number);  // Mark device as excluded or not
            tempDevice.device_type = NESTDEVICETYPE.THERMOSTAT;  // nest thermostat
            tempDevice.nest_device_structure = "device." + deviceID;
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
            tempDevice.description = this.rawData.shared[thermostat.serial_number].hasOwnProperty("name") ? this.#makeValidHomeKitName(this.rawData.shared[thermostat.serial_number].name) : "";
            tempDevice.target_temperature_type = this.rawData.shared[thermostat.serial_number].target_temperature_type;
            tempDevice.target_change_pending = this.rawData.shared[thermostat.serial_number].target_change_pending;
            tempDevice.target_temperature = __adjustTemperature(this.rawData.shared[thermostat.serial_number].target_temperature, "C", "C");
            tempDevice.backplate_temperature = __adjustTemperature(thermostat.backplate_temperature, "C", "C");
            tempDevice.temperature_lock = thermostat.temperature_lock;
            tempDevice.temperature_lock_pin_hash = thermostat.temperature_lock_pin_hash;

            // There is a "mode" change pending, so setup deta
            if (thermostat.eco.mode.toUpperCase() == "AUTO-ECO" || thermostat.eco.mode.toUpperCase() == "MANUAL-ECO") {
                // thermostat is running in "eco" mode, we'll override the target temps to be that of eco mode ones
                // also define a new hvac mode of "eco"
                tempDevice.target_temperature_high = __adjustTemperature(thermostat.away_temperature_high, "C", "C");
                tempDevice.target_temperature_low = __adjustTemperature(thermostat.away_temperature_low, "C", "C");
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
                tempDevice.target_temperature_high = __adjustTemperature(this.rawData.shared[thermostat.serial_number].target_temperature_high, "C", "C");
                tempDevice.target_temperature_low = __adjustTemperature(this.rawData.shared[thermostat.serial_number].target_temperature_low, "C", "C");
                tempDevice.hvac_mode = this.rawData.shared[thermostat.serial_number].target_temperature_type;
            }
        
            // Work out current state ie" heating, cooling etc
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
            tempDevice.fan_state = false;
            if (thermostat.fan_timer_timeout > 0 || this.rawData.shared[thermostat.serial_number].hvac_fan_state == true) tempDevice.fan_state = true;

            // Humidifier/dehumidifier details
            tempDevice.target_humidity = thermostat.target_humidity;
            tempDevice.humidifier_state = thermostat.humidifier_state;
            tempDevice.dehumidifier_state = thermostat.dehumidifier_state;
    
            // Get device location name
            tempDevice.location = "";
            this.rawData.where[this.rawData.link[thermostat.serial_number].structure.split(".")[1]].wheres.forEach(where => {
                if (thermostat.where_id == where.where_id) {
                    tempDevice.location = this.#makeValidHomeKitName(where.name);
                }
            });
            
            tempDevice.away = this.rawData.structure[this.rawData.link[thermostat.serial_number].structure.split(".")[1]].away;    // away status
            tempDevice.vacation_mode = this.rawData.structure[this.rawData.link[thermostat.serial_number].structure.split(".")[1]].vacation_mode;  // vacation mode
            tempDevice.home_name = this.#makeValidHomeKitName(this.rawData.structure[this.rawData.link[thermostat.serial_number].structure.split(".")[1]].name);  // Home name
            tempDevice.structureID = this.rawData.link[thermostat.serial_number].structure.split(".")[1]; // structure ID
            tempDevice.active_rcs_sensor = "";
            tempDevice.active_temperature = __adjustTemperature(thermostat.backplate_temperature, "C", "C");  // already adjusted temperature
            tempDevice.linked_rcs_sensors = [];

            // Get associated schedules
            tempDevice.schedules = {};
            if (typeof this.rawData.schedule[thermostat.serial_number] == "object") {
                tempDevice.schedules = this.rawData.schedule[thermostat.serial_number].days;
            }

            // Air filter details
            tempDevice.has_air_filter = thermostat.has_air_filter;
            tempDevice.filter_replacement_needed = thermostat.filter_replacement_needed;
            tempDevice.filter_changed_date = thermostat.filter_changed_date;
            tempDevice.filter_replacement_threshold_sec = thermostat.filter_replacement_threshold_sec;

            // Insert any extra options we've read in from configuration file
            tempDevice.EveApp = config.EveApp;    // Global config option for EveHome App integration. Gets overriden below for thermostat devices
            config.extraOptions[thermostat.serial_number] && Object.entries(config.extraOptions[thermostat.serial_number]).forEach(([key, value]) => {
                tempDevice[key] = value;
            });

            // Even if this thermostat is excluded, we need to process any associated temperature sensors
            this.rawData.rcs_settings[thermostat.serial_number].associated_rcs_sensors.forEach(sensor => {
                this.rawData.kryptonite[sensor.split(".")[1]].associated_thermostat = thermostat.serial_number;

                var sensorInfo = this.rawData.kryptonite[sensor.split(".")[1]];
                sensorInfo.serial_number = sensorInfo.serial_number.toUpperCase();
                if (typeof tempDevice == "object" && config.excludedDevices.includes(sensorInfo.serial_number) == false) {
                    // Associated temperature sensor isn't excluded
                    tempDevice.linked_rcs_sensors.push(sensorInfo.serial_number);

                    // Is this sensor the active one? If so, get some details about it
                    if (this.rawData.rcs_settings[thermostat.serial_number].active_rcs_sensors.includes(sensor)) {
                        tempDevice.active_rcs_sensor = sensorInfo.serial_number;
                        tempDevice.active_temperature =  __adjustTemperature(sensorInfo.current_temperature, "C", "C");
                    }
                }
            });

            devices[thermostat.serial_number] = tempDevice;  // Store processed device
        });

        this.rawData.kryptonite && Object.entries(this.rawData.kryptonite).forEach(([deviceID, sensor]) => {
            // Process temperature sensors. Needs to be done AFTER thermostat as we insert some extra details in there
            sensor.serial_number = sensor.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = "18B430" + this.#crc24(sensor.serial_number).toUpperCase(); // Use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off serial number for last 6 digits.
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);
            
            var tempDevice = {};
            tempDevice.excluded = config.excludedDevices.includes(sensor.serial_number);  // Mark device as excluded or not
            tempDevice.device_type = NESTDEVICETYPE.TEMPSENSOR;  // nest temperature sensor
            tempDevice.nest_device_structure = "kryptonite." + deviceID;
            tempDevice.serial_number = sensor.serial_number;
            tempDevice.description = sensor.hasOwnProperty("description") ? this.#makeValidHomeKitName(sensor.description) : ""; 
            tempDevice.mac_address = tempMACAddress;   // Our created MAC address
            tempDevice.battery_level = sensor.battery_level;
            tempDevice.software_version = "1.0";
            tempDevice.current_temperature = __adjustTemperature(sensor.current_temperature, "C", "C");
            tempDevice.active_sensor = this.rawData.rcs_settings[sensor.associated_thermostat].active_rcs_sensors.includes("kryptonite." + deviceID);
            tempDevice.associated_thermostat = sensor.associated_thermostat;

            // Get device location name
            tempDevice.location = "";
            this.rawData.where[sensor.structure_id].wheres.forEach(where => {
                if (sensor.where_id == where.where_id) {
                    tempDevice.location = this.#makeValidHomeKitName(where.name);
                }
            });

            tempDevice.online = (Math.floor(new Date() / 1000) - sensor.last_updated_at) < (3600 * 3) ? true : false;    // online status. allow upto 3hrs for reporting before report sensor offline
            tempDevice.home_name = this.#makeValidHomeKitName(this.rawData.structure[sensor.structure_id].name);    // Home name
            tempDevice.structureID = sensor.structure_id; // structure ID

            // Insert any extra options we've read in from configuration file for this device
            tempDevice.EveApp = config.EveApp;    // Global config option for EveHome App integration. Gets overriden below for temperature sensor devices
            config.extraOptions[sensor.serial_number] && Object.entries(config.extraOptions[sensor.serial_number]).forEach(([key, value]) => {
                tempDevice[key] = value;
            });

            devices[sensor.serial_number] = tempDevice;  // Store processed device
        });

        this.rawData.topaz && Object.entries(this.rawData.topaz).forEach(([deviceID, protect]) => {            
            // Process smoke detectors
            protect.serial_number = protect.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = protect.wifi_mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);

            var tempDevice = {};
            tempDevice.excluded = config.excludedDevices.includes(protect.serial_number);  // Mark device as excluded or not
            tempDevice.device_type = NESTDEVICETYPE.SMOKESENSOR;  // nest protect
            tempDevice.nest_device_structure = "topaz." + deviceID;
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
            tempDevice.description = protect.hasOwnProperty("description") ? this.#makeValidHomeKitName(protect.description) : "";
            tempDevice.software_version = (typeof protect.software_version != "undefined" ? protect.software_version.replace(/-/g, ".") : "0.0.0");
            tempDevice.ui_color_state = "grey";
            tempDevice.topaz_hush_key = this.rawData.structure[protect.structure_id].topaz_hush_key;
            if (protect.battery_health_state == 0 && protect.co_status == 0 && protect.smoke_status == 0) tempDevice.ui_color_state = "green";
            if (protect.battery_health_state != 0 || protect.co_status == 1 || protect.smoke_status == 1) tempDevice.ui_color_state = "yellow";
            if (protect.co_status == 2 || protect.smoke_status == 2) tempDevice.ui_color_state = "red";
        
            // Get device location name
            tempDevice.location = "";
            this.rawData.where[protect.structure_id].wheres.forEach(where => {
                if (protect.where_id == where.where_id) {
                    tempDevice.location = this.#makeValidHomeKitName(where.name);
                }
            });
            tempDevice.away = protect.auto_away;   // away status
            tempDevice.vacation_mode = this.rawData.structure[protect.structure_id].vacation_mode;  // vacation mode
            tempDevice.home_name = this.#makeValidHomeKitName(this.rawData.structure[protect.structure_id].name);  // Home name
            tempDevice.structureID = protect.structure_id; // structure ID

            // Insert any extra options we've read in from configuration file for this device
            tempDevice.EveApp = config.EveApp;    // Global config option for EveHome App integration. Gets overriden below for protect devices
            config.extraOptions[protect.serial_number] && Object.entries(config.extraOptions[protect.serial_number]).forEach(([key, value]) => {
                tempDevice[key] = value;
            });

            devices[protect.serial_number] = tempDevice;  // Store processed device
        });

        this.rawData.quartz && Object.entries(this.rawData.quartz).forEach(([deviceID, camera]) => {
            // Process doorbell/cameras
            camera.serial_number = camera.serial_number.toUpperCase();  // ensure serial numbers are in upper case
            var tempMACAddress = camera.mac_address.toUpperCase();
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);
            
            var tempDevice = {};
            tempDevice.excluded = config.excludedDevices.includes(camera.serial_number);  // Mark device as excluded or not
            tempDevice.device_type = camera.camera_type == 12 ? NESTDEVICETYPE.DOORBELL : NESTDEVICETYPE.CAMERA;  // nest doorbell or camera
            tempDevice.nest_device_structure = "quartz." + deviceID;
            tempDevice.serial_number = camera.serial_number;
            tempDevice.software_version = (typeof camera.software_version != "undefined" ? camera.software_version.replace(/-/g, ".") : "0.0.0");
            tempDevice.model = camera.model;   // Full model name ie "Nest Doorbell (wired)" etc
            tempDevice.mac_address = tempMACAddress;  // Our created MAC address;
            tempDevice.last_disconnect_reason = (typeof camera.last_disconnect_reason != "undefined" ? camera.last_disconnect_reason : "");
            tempDevice.description = camera.hasOwnProperty("description") ? this.#makeValidHomeKitName(camera.description) : "";
            tempDevice.camera_uuid = deviceID;  // Can generate from .nest_device_structure anyway
            tempDevice.nest_aware = (typeof camera.cvr_enrolled != "undefined" ? ((camera.cvr_enrolled.toUpperCase() != "NONE") ? true : false) : false);  // Does user have an active Nest aware subscription 
            tempDevice.direct_nexustalk_host = camera.direct_nexustalk_host;
            tempDevice.websocket_nexustalk_host = camera.websocket_nexustalk_host;
            tempDevice.streaming_enabled = (camera.streaming_state.includes("enabled") ? true : false);
            tempDevice.nexus_api_http_server_url = camera.nexus_api_http_server_url;
            tempDevice.nexus_api_nest_domain_host = camera.nexus_api_http_server_url.replace(/dropcam.com/ig, "camera.home.nest.com");  // avoid extra API call to get this detail by simple domain name replace
            tempDevice.online = (camera.streaming_state.includes("offline") ? false : true);
            tempDevice.audio_enabled = camera.audio_input_enabled;
            tempDevice.capabilities = camera.capabilities;
            tempDevice.properties = camera.properties;  // structure elements we added
            tempDevice.activity_zones = camera.activity_zones; // structure elements we added
            tempDevice.alerts = camera.alerts; // structure elements we added

            // Get device location name
            tempDevice.location = "";
            this.rawData.where[camera.structure_id].wheres.forEach(where => {
                if (camera.where_id == where.where_id) {
                    tempDevice.location = this.#makeValidHomeKitName(where.name);
                }
            });
            tempDevice.away = this.rawData.structure[camera.structure_id].away;    // away status
            tempDevice.vacation_mode = this.rawData.structure[camera.structure_id].vacation_mode;  // vacation mode
            tempDevice.home_name = this.#makeValidHomeKitName(this.rawData.structure[camera.structure_id].name);  // Home name
            tempDevice.structureID = camera.structure_id; // structure ID

            // Insert any extra options we've read in from configuration file for this device
            tempDevice.EveApp = config.EveApp;    // Global config option for EveHome App integration. Gets overriden below for specific doorbell/camera
            tempDevice.HKSV = config.HKSV;    // Global config option for HomeKit Secure Video. Gets overriden below for specific doorbell/camera
            tempDevice.H264EncoderRecord = config.H264EncoderRecord; // Global config option for using H264EncoderRecord. Gets overriden below for specific doorbell/camera
            tempDevice.H264EncoderLive = config.H264EncoderLive; // Global config option for using H264EncoderLive. Gets overriden below for specific doorbell/camera
            tempDevice.HKSVPreBuffer = config.HKSVPreBuffer;  // Global config option for HKSV pre buffering size. Gets overriden below for specific doorbell/camera
            tempDevice.doorbellCooldown = config.doorbellCooldown; // Global default for doorbell press cooldown. Gets overriden below for specific doorbell/camera
            tempDevice.motionCooldown = config.motionCooldown; // Global default for motion detected cooldown. Gets overriden below for specific doorbell/camera
            tempDevice.personCooldown = config.personCooldown; // Global default for person detected cooldown. Gets overriden below for specific doorbell/camera
            config.extraOptions[camera.serial_number] && Object.entries(config.extraOptions[camera.serial_number]).forEach(([key, value]) => {
                tempDevice[key] = value;
            });
            
            devices[camera.serial_number] = tempDevice;  // Store processed device
        });

        // Make up a virtual weather station data
        this.rawData.structure && Object.entries(this.rawData.structure).forEach(([deviceID, structure]) => {
            // Process structure
            var tempMACAddress = "18B430" + this.#crc24(deviceID).toUpperCase(); // Use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off structure for last 6 digits.
            var serial_number = tempMACAddress; // Serial number will be the mac address we've created
            tempMACAddress = tempMACAddress.substring(0,2) + ":" + tempMACAddress.substring(2,4) + ":" + tempMACAddress.substring(4,6) + ":" + tempMACAddress.substring(6,8) + ":" + tempMACAddress.substring(8,10) + ":" + tempMACAddress.substring(10,12);
            
            var tempDevice = {};
            tempDevice.excluded = (config.weather == false);   // Mark device as excluded or not
            tempDevice.device_type = NESTDEVICETYPE.WEATHER;
            tempDevice.mac_address = tempMACAddress;
            tempDevice.nest_device_structure = "structure." + deviceID;
            tempDevice.description = "";
            tempDevice.location = this.#makeValidHomeKitName(structure.location);
            tempDevice.serial_number = serial_number;
            tempDevice.software_version = "1.0.0";
            tempDevice.postal_code = structure.postal_code;
            tempDevice.country_code = structure.country_code;
            tempDevice.city = structure.city;
            tempDevice.state = structure.state;
            tempDevice.latitude = structure.latitude;
            tempDevice.longitude = structure.longitude;

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

            // Insert any extra options we've read in from configuration file for this device
            tempDevice.EveApp = config.EveApp;    // Global config option for EveHome App integration. Gets overriden below for weather
            config.extraOptions[serial_number] && Object.entries(config.extraOptions[serial_number]).forEach(([key, value]) => {
                tempDevice[key] = value;
            });

            devices[serial_number] = tempDevice;  // Store processed device
        });            

        return devices; // Return our processed data
    }

    async subscribe() {
        var subscribeAgainTimeout = 500;    // 500ms default before we subscribe again

        // Build subscripton object for data we want to track
        var subscribeData = {objects: []};
        var requiredObjects = ["structure", "where", "safety", "device", "shared", "track", "link", "rcs_settings", "schedule", "kryptonite", "topaz", "widget_track", "quartz"];
        Object.entries(this.rawData).forEach(([mainKey, subKey]) => {
            if (requiredObjects.includes(mainKey) == true) {
                Object.entries(this.rawData[mainKey]).forEach(([subKey]) => {
                    subscribeData.objects.push({"object_key" : mainKey + "." + subKey, "object_revision" : this.rawData[mainKey][subKey]["$version"], "object_timestamp": this.rawData[mainKey][subKey]["$timestamp"]});

                    if (mainKey == "quartz") {
                        // Need todo something special for cameras to get alerts and zone changes
                        // We'll setup polling loop here if not already running
                        if (this.subscribePollingTimers.findIndex( ({ nestDevice, type }) => (nestDevice === mainKey + "." + subKey && type === "alerts")) == -1) {
                            var tempTimer = setInterval(() => {
                                // Do doorbell/camera alerts
                                this.rawData.quartz[subKey] && axios.get(this.rawData.quartz[subKey].nexus_api_nest_domain_host + "/cuepoint/" + subKey + "/2?start_time=" + Math.floor((Date.now() / 1000) - 30), {headers: {"user-agent": USERAGENT, "Referer" : REFERER, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: CAMERAALERTPOLLING, retry: 3, retryDelay: 1000})
                                .then((response) => {
                                    if (response.status == 200) {
                                        // Filter out any alerts which occured before we started this accessory
                                        response.data = response.data.filter(alert => (Math.floor(alert.start_time / 1000) >= this.startTime));
                    
                                        // Fix up alert zone id's
                                        // Appears if no Nest Aware subscription, the zone_id in the associated alert is left blank
                                        // We'll assign the alert zone id to '0' ie: main zone in this case
                                        response.data.forEach(alert => {
                                            if (alert.zone_ids.length == 0) {
                                                alert.zone_ids = [0];   // Default zone ID ie: main zone
                                            }
                                        });
                            
                                        // Insert alerts into the Nest structure, then notify device
                                        this.rawData.quartz[subKey].alerts = response.data;
                                        
                                        this.events.emit("quartz." + subKey, MESSAGETYPE.UPDATE, {alerts: this.rawData.quartz[subKey].alerts});
                                    }
                                })
                                .catch(error => {
                                });
                            }, CAMERAALERTPOLLING);
                            this.subscribePollingTimers.push({nestDevice: "quartz." + subKey, type: "alerts", timer: tempTimer});
                        }

                        if (this.subscribePollingTimers.findIndex( ({ nestDevice, type }) => (nestDevice === mainKey + "." + subKey && type === "zones")) == -1) {
                            var tempTimer = setInterval(() => {
                                // Do doorbell/camera zones
                                this.rawData.quartz[subKey] && axios.get(this.rawData.quartz[subKey].nexus_api_nest_domain_host + "/cuepoint_category/" + subKey, {headers: {"user-agent": USERAGENT, "Referer" : REFERER, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: CAMERAZONEPOLLING, retry: 3, retryDelay: 1000})
                                .then((response) => {
                                    if (response.status == 200) {
                                        var tempZones = [];
                                        response.data.forEach(zone => {
                                            if (zone.hidden == false && (zone.type.toUpperCase() == "ACTIVITY" || zone.type.toUpperCase() == "REGION")) {
                                                tempZones.push({"id": zone.id, "name" : this.#makeValidHomeKitName(zone.label), "hidden" : zone.hidden, "uri" : zone.nexusapi_image_uri});
                                            }
                                        });

                                        // Insert activity zones into the Nest structure, then notify device
                                        this.rawData.quartz[subKey].activity_zones = tempZones;

                                        this.events.emit("quartz." + subKey, MESSAGETYPE.UPDATE, {activity_zones: this.rawData.quartz[subKey].activity_zones});
                                    }
                                })
                                .catch(error => {
                                });
                            }, CAMERAZONEPOLLING);
                            this.subscribePollingTimers.push({nestDevice: "quartz." + subKey, type: "zones", timer: tempTimer});
                        }
                    }

                    if (mainKey == "structure") {
                        if (this.subscribePollingTimers.findIndex( ({ nestDevice, type }) => (nestDevice === mainKey + "." + subKey && type === "weather")) == -1) {
                            var tempTimer = setInterval(() => {
                                if (typeof this.rawData.structure[subKey].weather != "object") this.rawData.structure[subKey].weather = {}; // Weather data will be here
                                axios.get(this.weather_url + this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude, {headers: {"user-agent": USERAGENT, timeout: 10000}})
                                .then(response => {
                                    if (response.status == 200) {
                                        this.rawData.structure[subKey].weather.current_temperature = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.temp_c;
                                        this.rawData.structure[subKey].weather.current_humidity = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.humidity;
                                        this.rawData.structure[subKey].weather.condition = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.condition;
                                        this.rawData.structure[subKey].weather.wind_direction = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.wind_dir;
                                        this.rawData.structure[subKey].weather.wind_speed = (response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.wind_mph * 1.609344);    // convert to km/h
                                        this.rawData.structure[subKey].weather.sunrise = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.sunrise;
                                        this.rawData.structure[subKey].weather.sunset = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].current.sunset;
                                        this.rawData.structure[subKey].weather.station = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].location.short_name;
                                        this.rawData.structure[subKey].weather.forecast = response.data[this.rawData.structure[subKey].latitude + "," + this.rawData.structure[subKey].longitude].forecast.daily[0].condition;

                                        this.events.emit("structure." + subKey, MESSAGETYPE.UPDATE, {weather: this.rawData.structure[subKey].weather});
                                    }
                                })
                                .catch(error => {
                                });
                            }, WEATHERPOLLING);
                            this.subscribePollingTimers.push({nestDevice: "structure." + subKey, type: "weather", timer: tempTimer});
                        }
                    }
                });
            }
        });

        // Do subscription for the data we need from the Nest structure.. Timeout after 2mins if no data received, and if timed-out, rinse and repeat :-) 
        var addRemoveDevices = [];
        axios({
            method: "post",
            url: this.transport_url + "/v6/subscribe",
            data: JSON.stringify(subscribeData), 
            headers: {"user-agent": USERAGENT, "Authorization": "Basic " + this.nestAPIToken}, 
            responseType: "json", 
            timeout: SUBSCRIBETIMEOUT,
            signal: this.abortController.signal
        })
        .then(async (response) => {
            if (response.status && response.status == 200) {
                // Got subscribed update, so merge and process them
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
                            await axios.get(CAMERAAPIHOST + "/api/cameras.get_with_properties?uuid=" + subKey, {headers: {"user-agent": USERAGENT, "Referer" : REFERER, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: NESTAPITIMEOUT})
                            .then((response) => {
                                if (response.status && response.status == 200) {
                                    this.rawData[mainKey][subKey].properties = response.data.items[0].properties;
                                }
                            })
                            .catch(error => {
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
                    var addRemoveIndex = addRemoveDevices.findIndex( ({ nestDevice }) => nestDevice === deviceData.nest_device_structure)
                    if (addRemoveIndex == -1) {
                        // Send current data to the HomeKit accessory for processing
                        // The accessory will determine if data has changed compared to what it has stored
                        this.events.emit(deviceData.nest_device_structure, MESSAGETYPE.UPDATE, deviceData);
                    } else if (addRemoveIndex != -1 && addRemoveDevices[addRemoveIndex].action == "add") {
                        // Device addition to process
                        config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Detected additional Nest deviced");
                        this.events.emit(NESTSYSTEMEVENT.NEWDEVICE, deviceData);    // new device, so process addition to HomeKit
                    }
                });

                // Process any device removals here
                addRemoveDevices.forEach(device => {
                    if (device.action == "remove") {
                        config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Detected removal of Nest device");

                        // Remove any polling timers that might have been associated with this device
                        this.subscribePollingTimers.forEach(pollingTimer => {
                            if (pollingTimer.nestDevice == device.nestDevice) {
                                clearInterval(pollingTimer.timer)
                            }
                        });

                        this.events.emit(device.nestDevice, MESSAGETYPE.REMOVE, {});    // this will handle removal without knowing previous data for device
                    }
                });
            }
            else {
                config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Nest subscription failed. HTTP status returned", response.status);
            }
        })
        .catch((error) => {
            if (axios.isCancel(error) == false && error.code !== "ECONNABORTED" && error.code !== "ETIMEDOUT") {
                if (error.response && error.response.status == 404) {
                    // URL not found
                    subscribeAgainTimeout = 5000;   // Since bad URL, try again after 5 seconds
                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Nest subscription failed. URL not found");
                } else if (error.response && error.response.status == 400) {
                    // bad subscribe
                    subscribeAgainTimeout = 5000;   // Since bad subscribe, try again after 5 seconds
                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Nest subscription failed. Bad subscription data");
                } else if (error.response && error.response.status == 502) {
                    // gateway error
                    subscribeAgainTimeout = 10000;  // Since bad gateway error, try again after 10 seconds
                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Nest subscription failed. Bad gateway");
                } else {
                    // Other unknown error  
                    subscribeAgainTimeout = 5000;   // Try again afer 5 seconds
                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Nest subscription failed with error", error);
                }
            }
        })
        .finally(() => {
            // subscribe again after delay :-)
            setTimeout(this.subscribe.bind(this), subscribeAgainTimeout);
        });
    }

    async #setElement(nestStructure, values) {
        var retValue = false;
        if (this.nestAPIToken != "" && this.transport_url != "") {
            if (nestStructure.split(".")[0].toUpperCase() == "PROPERTIES") {
                // request is to set a doorbell/camera property. Handle here
                await Promise.all(Object.entries(values).map(async ([key, value]) => {
                    await axios.post(CAMERAAPIHOST + "/api/dropcams.set_properties", [key] + "=" + value + "&uuid=" + nestStructure.split(".")[1], {headers: {"content-type": "application/x-www-form-urlencoded", "user-agent": USERAGENT, "Referer" : REFERER, [this.cameraAPI.key] : this.cameraAPI.value + this.cameraAPI.token}, responseType: "json", timeout: NESTAPITIMEOUT})
                    .then((response) => {
                        if (response.status == 200 && response.data.status == 0) {
                            retValue = true;    // successfully set Nest camera value
                        }
                    })
                    .catch(error => {
                        config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Failed to set Nest Camera element with error", error.message);
                    });        
                }));
            }
            if (nestStructure.split(".")[0].toUpperCase() != "PROPERTIES") {
                // request is to set a Nest device structure element. Handle here
                var put = {objects: []};
                Object.entries(values).forEach(([key, value]) => {
                    put.objects.push({"object_key" : nestStructure, "op" : "MERGE", "value": {[key]: value}});
                });
                await axios.post(this.transport_url + "/v5/put", JSON.stringify(put), {headers: {"user-agent": USERAGENT, "Authorization": "Basic " + this.nestAPIToken} })
                .then(response => {
                    if (response.status == 200) {
                        retValue = true;    // successfully set Nest structure value
                    }
                })
                .catch(error => {
                    config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Failed to set Nest structure element with error", error.message);
                });
            }
        }
        return retValue;
    }

    #makeValidHomeKitName(name) {
        // Strip invalid characters to conform to HomeKit requirements
        // Ensure only letters or numbers at beginning/end of string
        return name.replace(/[^A-Za-z0-9 ,.-]/g, "").replace(/^[^a-zA-Z0-9]*/g, "").replace(/[^a-zA-Z0-9]+$/g, "");
    }

    #crc24(value) {
        var hashTable = [
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
        var crc = 0xb704ce; // init crc24 hash;
        var buffer = Buffer.from(value);    // convert value into buffer for processing
        for (var index = 0; index < value.length; index++) {
            crc = (hashTable[((crc >> 16) ^ buffer[index]) & 0xff] ^ (crc << 8)) & 0xffffff;
        }
        return crc.toString(16);    // return crc24 as hex string
    }
}


// Configuration class
//
// Handles system configuration file
const CONFIGURATIONFILE = "Nest_config.json";           // Default configuration file name, located in current directory

// Available debugging ouput options
const Debugging = {
    NEST : "nest",
    NEXUS : "nexus",
    FFMPEG : "ffmpeg",
    HKSV : "hksv",
    EXTERNAL : "external",
    WEATHER : "weather",
    HISTORY : "history"
}

class Configuration {
    constructor(configFile) {
        this.loaded = false;                            // Have we loaded a configuration
        this.debug = "";                                // Enable debug output, off by default
        this.token = "";                                // Token to access Nest system. Can be either a session token or google cookie token
        this.tokenType = "";                            // Type of token we're using, either be "nest" or "google"
        this.weather = false;                           // Create a virtual weather station using Nest weather data
        this.HKSV = false;                              // Enable HKSV for all camera/doorbells, no by default
        this.HKSVPreBuffer = 15000;                     // Milliseconds seconds to hold in buffer. default is 15secs. using 0 disables pre-buffer
        this.doorbellCooldown = 60000;                  // Default cooldown period for doorbell button press (1min/60secs)
        this.motionCooldown = 60000;                    // Default cooldown period for motion detected (1min/60secs)
        this.personCooldown = 120000;                   // Default cooldown person for person detected (2mins/120secs)
        this.H264EncoderRecord = VideoCodecs.LIBX264;   // Default H264 Encoder for HKSV recording
        this.H264EncoderLive = VideoCodecs.COPY;        // Default H264 Encoder for HomeKit/HKSV live video
        this.mDNS = MDNSAdvertiser.BONJOUR;             // Default mDNS advertiser for HAP-NodeJS library
        this.EveApp = true;                             // Intergration with evehome app
        this.excludedDevices = [];                      // Array of excluded devices (by serial number)
        this.extraOptions = {};                         // Extra options per device to inject into Nest data structure

        // Load configuration
        if (fs.existsSync(configFile) == true) {
            try {
                var config = JSON.parse(fs.readFileSync(configFile));
                this.loaded = true; // Loaded
            } catch (error) {
                // Error loading JSON, means config invalid
                console.log("Error in JSON file '%s'", configFile);
            }

            config && Object.entries(config).forEach(([key, value]) => {
                // Process configuration items
                key = key.toUpperCase();    // Make key uppercase. Saves doing every time below
                if (key == "SESSIONTOKEN" && typeof value == "string") {
                    this.token = value;  // Nest accounts Session token to use for Nest calls
                    this.tokenType = "nest";
                }
                if (key == "REFRESHTOKEN" && typeof value == "string") {
                    // NO LONGER SUPPORTED BY GOOGLE";
                    console.log("Google account access via refreshToken method is no longer supported by Google. Please use the Google Cookie method");
                }
                if (key == "GOOGLETOKEN" && typeof value == "object") {
                    this.tokenType = "google";
                    this.token = {}; // Google cookies token to use for Nest calls
                    Object.entries(value).forEach(([key, value]) => {
                        if (key.toUpperCase() == "ISSUETOKEN") this.token["issuetoken"] = value;
                        if (key.toUpperCase() == "COOKIE") this.token["cookie"] = value;
                    });
                    if (this.token.hasOwnProperty("issuetoken") == false || this.token.hasOwnProperty("cookie") == false) {
                        this.token = "";    // Not a valid Google cookie token
                        this.tokenType = "";
                    }
                }
                if (key == "WEATHER" && typeof value == "boolean") this.weather = value;    // Virtual weather station
                if (key == "DEBUG" && typeof value == "boolean" && value == true) this.debug = "nest,nexus,hksv";  // Debugging output will Nest, HKSV and NEXUS
                if (key == "DEBUG" && typeof value == "string") {
                    // Comma delimited string for what we output in debugging
                    // nest, hksv, ffmpeg, nexus, external are valid options in the string
                    if (value.toUpperCase().includes("NEST") == true) this.debug += Debugging.NEST;
                    if (value.toUpperCase().includes("NEXUS") == true) this.debug += Debugging.NEXUS;
                    if (value.toUpperCase().includes("HKSV") == true) this.debug += Debugging.HKSV;
                    if (value.toUpperCase().includes("FFMPEG") == true) this.debug += Debugging.FFMPEG;
                    if (value.toUpperCase().includes("EXTERNAL") == true) this.debug += Debugging.EXTERNAL;
                    if (value.toUpperCase().includes("HISTORY") == true) this.debug += Debugging.HISTORY;
                    if (value.toUpperCase().includes("WEATHER") == true) this.debug += Debugging.WEATHER;
                }
                if (key == "HKSV" && typeof value == "boolean") this.HKSV = value;    // Global HomeKit Secure Video?
                if (key == "MDNS" && typeof value == "string") {
                    if (value.toUpperCase() == "CIAO") this.mDNS = MDNSAdvertiser.CIAO;    // Use ciao as the mDNS advertiser
                    if (value.toUpperCase() == "BONJOUR") this.mDNS = MDNSAdvertiser.BONJOUR;    // Use bonjour as the mDNS advertiser
                    if (value.toUpperCase() == "AVAHI") this.mDNS = MDNSAdvertiser.AVAHI;    // Use avahi as the mDNS advertiser
                }
                if (key == "H264ENCODER" && typeof value == "string") {
                    if (value.toUpperCase() == "LIBX264") {
                        this.H264EncoderRecord = VideoCodecs.LIBX264;  // Use libx264, software encoder
                        this.H264EncoderLive = VideoCodecs.LIBX264;  // Use libx264, software encoder
                    }
                    if (value.toUpperCase() == "H264_OMX") {
                        this.H264EncoderRecord = VideoCodecs.H264_OMX;  // Use the older RPI hardware h264 encoder
                        this.H264EncoderLive = VideoCodecs.H264_OMX;  // Use the older RPI hardware h264 encoder
                    }
                    if (value.toUpperCase() == "COPY") {
                        this.H264EncoderRecord = VideoCodecs.COPY;  // Copy the stream directly
                        this.H264EncoderLive = VideoCodecs.COPY;  // Copy the stream directly
                    }
                }
                if (key == "H264RECORDENCODER" && typeof value == "string") {
                    if (value.toUpperCase() == "LIBX264") this.H264EncoderRecord = VideoCodecs.LIBX264;  // Use libx264, software encoder
                    if (value.toUpperCase() == "H264_OMX") this.H264EncoderRecord = VideoCodecs.H264_OMX;  // Use the older RPI hardware h264 encoder
                    if (value.toUpperCase() == "COPY") this.H264EncoderRecord = VideoCodecs.COPY;  // Copy the stream directly
                }
                if (key == "H264STREAMENCODER" && typeof value == "string") {
                    if (value.toUpperCase() == "LIBX264") this.H264EncoderLive = VideoCodecs.LIBX264;  // Use libx264, software encoder
                    if (value.toUpperCase() == "H264_OMX") this.H264EncoderLive = VideoCodecs.H264_OMX;  // Use the older RPI hardware h264 encoder
                    if (value.toUpperCase() == "COPY") this.H264EncoderLive = VideoCodecs.COPY;  // Copy the stream directly
                }
                if (key == "HKSVPREBUFFER" && typeof value == "number") {
                    if (value < 1000) value = value * 1000;  // If less than 1000, assume seconds value passed in, so convert to milliseconds
                    this.HKSVPreBuffer = value;   // Global HKSV pre-buffer sizing
                }
                if (key == "DOORBELLCOOLDOWN" && typeof value == "number") {
                    if (value < 1000) value = value * 1000;  // If less than 1000, assume seconds value passed in, so convert to milliseconds
                    this.doorbellCooldown = value;   // Global doorbell press cooldown time
                }
                if (key == "EVEAPP" && typeof value == "boolean") this.EveApp = value;    // Evehome app integration 
                if (key == "MOTIONCOOLDOWN" && typeof value == "number") {
                    if (value < 1000) value = value * 1000;  // If less than 1000, assume seconds value passed in, so convert to milliseconds
                    this.motionCooldown = value;   // Global motion detected cooldown time
                }
                if (key == "PERSONCOOLDOWN" && typeof value == "number") {
                    if (value < 1000) value = value * 1000;  // If less than 1000, assume seconds value passed in, so convert to milliseconds
                    this.personCooldown = value;   // Global person detected cooldown time
                }
                if (typeof value == "object") {
                    // Assume since key value is an object, its a device configuration for matching serial number
                    this.extraOptions[key] = {};
                    Object.entries(value).forEach(([subKey, value]) => {
                        if (subKey.toUpperCase() == "EXCLUDE" && typeof value == "boolean" && value == true) this.excludedDevices.push(key);    // Push this devices serial number onto our list
                        if (subKey.toUpperCase() == "HKSV" && typeof value == "boolean") this.extraOptions[key]["HKSV"] = value;    // HomeKit Secure Video for this device?
                        if (subKey.toUpperCase() == "EVEAPP" && typeof value == "boolean") this.extraOptions[key]["EveApp"] = value;    // Evehome app integration
                        if (subKey.toUpperCase() == "H264ENCODER" && typeof value == "string") {
                            // Legacy option. Replaced by H264EncoderRecord and H264EncoderLive
                            if (value.toUpperCase() == "LIBX264") {
                                this.extraOptions[key]["H264EncoderRecord"] = VideoCodecs.LIBX264;  // Use libx264, software encoder
                                this.extraOptions[key]["H264EncoderLive"] = VideoCodecs.LIBX264;  // Use libx264, software encoder
                            }
                            if (value.toUpperCase() == "H264_OMX") {
                                this.extraOptions[key]["H264EncoderRecord"] = VideoCodecs.H264_OMX;  // Use the older RPI hardware h264 encoder
                                this.extraOptions[key]["H264EncoderLive"] = VideoCodecs.H264_OMX;  // Use the older RPI hardware h264 encoder
                            }
                        }
                        if (subKey.toUpperCase() == "H264RECORDENCODER" && typeof value == "string") {
                            if (value.toUpperCase() == "LIBX264") this.extraOptions[key]["H264EncoderRecord"] = VideoCodecs.LIBX264;  // Use libx264, software encoder
                            if (value.toUpperCase() == "H264_OMX") this.extraOptions[key]["H264EncoderRecord"] = VideoCodecs.H264_OMX;  // Use the older RPI hardware h264 encoder
                        }
                        if (subKey.toUpperCase() == "H264STREAMENCODER" && typeof value == "string") {
                            if (value.toUpperCase() == "LIBX264") this.extraOptions[key]["H264EncoderLive"] = VideoCodecs.LIBX264;  // Use libx264, software encoder
                            if (value.toUpperCase() == "H264_OMX") this.extraOptions[key]["H264EncoderLive"] = VideoCodecs.H264_OMX;  // Use the older RPI hardware h264 encoder
                        }
                        if (subKey.toUpperCase() == "HKSVPREBUFFER" && typeof value == "number") {
                            if (value < 1000) value = value * 1000;  // If less than 1000, assume seconds value passed in, so convert to milliseconds
                            this.extraOptions[key]["HKSVPreBuffer"] = value;   // HKSV pre-buffer sizing for this device
                        }
                        if (subKey.toUpperCase() == "DOORBELLCOOLDOWN" && typeof value == "number") {
                            if (value < 1000) value = value * 1000;  // If less than 1000, assume seconds value passed in, so convert to milliseconds
                            this.extraOptions[key]["doorbellCooldown"] = value;   // Doorbell press cooldown time for this device
                        }              
                        if (subKey.toUpperCase() == "MOTIONCOOLDOWN" && typeof value == "number") {
                            if (value < 1000) value = value * 1000;  // If less than 1000, assume seconds value passed in, so convert to milliseconds
                            this.extraOptions[key]["motionCooldown"] = value;   // Motion detected cooldown time for this device
                        }
                        if (subKey.toUpperCase() == "PERSONCOOLDOWN" && typeof value == "number") {
                            if (value < 1000) value = value * 1000;  // If less than 1000, assume seconds value passed in, so convert to milliseconds
                            this.extraOptions[key]["personCooldown"] = value;   // Person detected cooldown time for this device
                        }
                        if (subKey.toUpperCase() == "HUMIDITYSENSOR" && typeof value == "boolean") this.extraOptions[key]["humiditySensor"] = value;    // Seperate humidity sensor for this device. Only valid for thermostats
                        if (subKey.toUpperCase() == "EXTERNALCOOL" && typeof value == "string") {
                            try {
                                if (value.indexOf("/") == -1) value = __dirname + "/" + value;  // Since no directory paths in the filename, pre-append the current path
                                this.extraOptions[key]["externalCool"] = require(value);  // Try to load external library for thermostat to perform cooling function
                            } catch (error) {
                                // do nothing
                            }
                        } 
                        if (subKey.toUpperCase() == "EXTERNALHEAT" && typeof value == "string") {
                            try {
                                if (value.indexOf("/") == -1) value = __dirname + "/" + value;  // Since no directory paths in the filename, pre-append the current path
                                this.extraOptions[key]["externalHeat"] = require(value);  // Try to load external library for thermostat to perform heating function
                            } catch (error) {
                                // do nothing
                            }
                        } 
                        if (subKey.toUpperCase() == "EXTERNALFAN" && typeof value == "string") {
                            try {
                                if (value.indexOf("/") == -1) value = __dirname + "/" + value;  // Since no directory paths in the filename, pre-append the current path
                                this.extraOptions[key]["externalFan"] = require(value);  // Try to load external library for thermostat to perform fan function
                            } catch (error) {
                                // do nothing
                            }
                        }
                        if (subKey.toUpperCase() == "EXTERNALDEHUMIDIFIER" && typeof value == "string") {
                            try {
                                if (value.indexOf("/") == -1) value = __dirname + "/" + value;  // Since no directory paths in the filename, pre-append the current path
                                this.extraOptions[key]["externalDehumidifier"] = require(value);  // Try to load external library for thermostat to perform dehumidifier function
                            } catch (error) {
                                // do nothing
                            }
                        } 
                        if (subKey.split(".")[0].toUpperCase() == "OPTION" && subKey.split(".")[1]) {
                            // device options we'll insert into the Nest data for non excluded devices
                            // also allows us to override existing Nest data for the device, such as MAC address etc
                            this.extraOptions[key][subKey.split(".")[1]] = value;
                        }
                    });

                    // Remove any extra options if the device is marked as excluded
                    if (this.excludedDevices.includes(key) == true) {
                        delete this.extraOptions[key];
                    }
                }
            });
        }
    }
}


// General functions  
function __scale(num, in_min, in_max, out_min, out_max) {
    // Scales a number between range 1, to range 2
    if (num > in_max) num = in_max;
    if (num < in_min) num = in_min;
    return ((num - in_min) * (out_max - out_min) / (in_max - in_min)) + out_min;
}

function __adjustTemperature(temp_in, unit_in, unit_out) {
    // Converts temperatures between C/F and vice-versa. 
    // Also rounds temperatures to 0.5 increments for C and 1.0 for F
    var adjustedTemperature = temp_in;

    if (unit_in != unit_out) {
        if ((unit_in == "C" || unit_in == "c" || unit_in == Characteristic.TemperatureDisplayUnits.CELSIUS) && (unit_out == "F" || unit_out == "f" || unit_out == Characteristic.TemperatureDisplayUnits.FAHRENHEIT)) {
            // convert from C to F
            adjustedTemperature = (temp_in * 9 / 5) + 32;
        }

        if ((unit_in == "F" || unit_in == "f" || unit_in == Characteristic.TemperatureDisplayUnits.FAHRENHEIT) && (unit_out == "C" || unit_out == "c" || unit_out == Characteristic.TemperatureDisplayUnits.CELSIUS)) {
            // convert from F to C
            adjustedTemperature = (temp_in - 32) * 5 / 9
        }
    }

    if (unit_out == "C" || unit_out == "c" || unit_out == Characteristic.TemperatureDisplayUnits.CELSIUS) adjustedTemperature = Math.round(adjustedTemperature * 2) / 2;   // round to neartest 0.5
    if (unit_out == "F" || unit_out == "f" || unit_out == Characteristic.TemperatureDisplayUnits.FAHRENHEIT) adjustedTemperature = Math.round(adjustedTemperature); // round to neartest 1

    return adjustedTemperature;
}

function processDeviceforHomeKit(deviceData) {
    // adding device into HomeKit based on Nest device types, ignoring excluded devices
    if (deviceData.excluded == false) {
        switch (deviceData.device_type) {
            case NESTDEVICETYPE.THERMOSTAT : {
                // Nest Thermostat
                var tempModel = "Thermostat";
                if (deviceData.serial_number.substring(0,2) == "15") tempModel = tempModel + " E";  // Nest Thermostat E
                if (deviceData.serial_number.substring(0,2) == "09") tempModel = tempModel + " 3rd Generation";  // Nest Thermostat 3rd Gen
                if (deviceData.serial_number.substring(0,2) == "02") tempModel = tempModel + " 2nd Generation";  // Nest Thermostat 2nd Gen
                if (deviceData.serial_number.substring(0,2) == "01") tempModel = tempModel + " 1st Generation";  // Nest Thermostat 1st Gen

                var tempDevice = new ThermostatClass(deviceData, eventEmitter);
                tempDevice.add("Nest Thermostat", tempModel, Accessory.Categories.THERMOSTAT, true);
                break;
            }

            case NESTDEVICETYPE.TEMPSENSOR : {
                // Nest Temperature Sensor
                var tempModel = "Temperature Sensor";
                if (deviceData.serial_number.substring(0,2) == "22") tempModel = tempModel + " 1st Generation";  // Nest Temperature Sensor 1st Gen

                var tempDevice = new TempSensorClass(deviceData, eventEmitter);
                tempDevice.add("Nest Temperature Sensor", tempModel, Accessory.Categories.SENSOR, true);
                break;
            }

            case NESTDEVICETYPE.SMOKESENSOR : {
                // Nest Protect
                var tempModel = "Protect";
                if (deviceData.serial_number.substring(0,2) == "06") tempModel = tempModel + " 2nd Generation";  // Nest Protect 2nd Gen
                if (deviceData.serial_number.substring(0,2) == "05") tempModel = tempModel + " 1st Generation";  // Nest Protect 1st Gen
                if (deviceData.wired_or_battery == 0) tempModel = tempModel + " (wired)";    // Mains powered
                if (deviceData.wired_or_battery == 1) tempModel = tempModel + " (battery)";    // Battery powered

                var tempDevice = new SmokeSensorClass(deviceData, eventEmitter);
                tempDevice.add("Nest Protect", tempModel, Accessory.Categories.SENSOR, true);
                break;
            }

            case NESTDEVICETYPE.CAMERA : 
            case NESTDEVICETYPE.DOORBELL : {
                // Nest Hello and Nest Cam(s)
                // Basically the same 
                var tempModel = deviceData.model.replace(/nest\s*/ig, "");    // We'll use doorbell/camera model description that Nest supplies

                var tempDevice = new CameraClass(deviceData, eventEmitter);
                tempDevice.add("Nest " + tempModel.replace(/\s*(?:\([^()]*\))/ig, ""), tempModel, (deviceData.device_type == NESTDEVICETYPE.DOORBELL ? Accessory.Categories.VIDEO_DOORBELL : Accessory.Categories.IP_CAMERA), true)
                break;
            }

            case NESTDEVICETYPE.WEATHER : {
                // "Virtual" weather station
                if (config.weather == true) {
                    var tempDevice = new WeatherClass(deviceData, eventEmitter);
                    tempDevice.add("Nest Weather", "Weather", Accessory.Categories.SENSOR, true);
                }
                break;
            }
        }  
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

function isFfmpegValid(validLibraries) {
    // Validates if the ffmpeg binary has been complied to support the required libraries
    var isValid = false;    // Not valid yet
    var output = spawnSync(ffmpegPath || "ffmpeg", ["-version"], { env: process.env });
    if (output.stdout != null) {
        var foundLibaries = 0;
        validLibraries.forEach((library) => {
            if (output.stdout.toString().includes(library) == true) {
                foundLibaries++;    // One more found library
            }
        });
        isValid = (foundLibaries == validLibraries.length);
    }
    return isValid;
}

function getTimestamp() {
    const pad = (n,s=2) => (`${new Array(s).fill(0)}${n}`).slice(-s);
    const d = new Date();
    
    return `${pad(d.getFullYear(),4)}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
  

// Startup code
// Check to see if a configuration file was passed into use
var configFile = __dirname + "/" + CONFIGURATIONFILE;
if (process.argv.slice(2).length == 1) {  // We only support/process one argument
    configFile = process.argv.slice(2)[0];   // Extract the file name from the argument passed in
    if (configFile.indexOf("/") == -1) configFile = __dirname + "/" + configFile;
}

console.log("Starting " +  __filename + " using HAP-NodeJS library v" + HAPNodeJS.HAPLibraryVersion());
console.log("Configuration will be read from '%s'", configFile);

// Create h264 frames for camera off/offline dynamically in video streams. Only required for non-HKSV video devices
var ffmpegCommand = "-hide_banner -loop 1 -i " + __dirname + "/" + CAMERAOFFLINEJPGFILE + " -vframes 1 -r " + EXPECTEDVIDEORATE + " -y -f h264 -profile:v main " + __dirname + "/" + CAMERAOFFLINEH264FILE;
spawnSync(ffmpegPath || "ffmpeg", ffmpegCommand.split(" "), { env: process.env });
var ffmpegCommand = "-hide_banner -loop 1 -i " + __dirname + "/" + CAMERAOFFJPGFILE + " -vframes 1 -r " + EXPECTEDVIDEORATE + " -y -f h264 -profile:v main " + __dirname + "/" + CAMERAOFFH264FILE;
spawnSync(ffmpegPath || "ffmpeg", ffmpegCommand.split(" "), { env: process.env });
var ffmpegCommand = "-hide_banner -loop 1 -i " + __dirname + "/" + CAMERACONNECTINGJPGFILE + " -vframes 1 -r " + EXPECTEDVIDEORATE + " -y -f h264 -profile:v main " + __dirname + "/" + CAMERACONNECTING264FILE;
spawnSync(ffmpegPath || "ffmpeg", ffmpegCommand.split(" "), { env: process.env });

// Need a global event emitter. Will be used for message between our classes we create below
var eventEmitter = new EventEmitter();

var config = new Configuration(configFile); // Load configuration details from specified file.
if (config.loaded == true && config.token != "") {
    var nest = new NestSystem(config.token, config.tokenType, eventEmitter);
    nest.connect()   // Initiate connection to Nest System APIs with either the specified session or refresh tokens
    .then(() => {
        if (nest.nestAPIToken != "") {
            config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Getting active devices from Nest");
            nest.getData()  // Get of devices we have in our Nest structure
            .then(() => {
                config.debug.includes(Debugging.NEST) && console.debug(getTimestamp() + " [NEST] Devices will be advertised to HomeKit using '%s' mDNS provider", config.mDNS);
                if (typeof nest.rawData.quartz != "object" || (typeof nest.rawData.quartz == "object" && isFfmpegValid(FFMPEGLIBARIES) == true)) {
                    // We don't have "quartz" object key, OR we have a "quartz" key AND a valid ffmpeg binary
                    // Means we've validated the ffmpeg binary being used supports the required libraries we need for streaming and/or record

                    // Process any discovered Nest devices into HomeKit
                    Object.entries(nest.processData()).forEach(([deviceID, deviceData]) => {
                        processDeviceforHomeKit(deviceData);  
                    });

                    nest.events.addListener(NESTSYSTEMEVENT.NEWDEVICE, processDeviceforHomeKit); // Notifications for any device additions in Nest structure
                    nest.subscribe();  // Start subscription
                } else {
                    // ffmpeg binary doesn't support the required libraries we require
                    console.log("The ffmpeg binary '%s' does not support the required libraries for doorbell and/or camera usage", (ffmpegPath || "ffmpeg"));
                    console.log("Required libraries in ffmpeg are", FFMPEGLIBARIES);
                }
            });
        }
    });
}


// Exit/cleanup code when/if process stopped
// Taken from HAP-NodeJS core.js/ts code
var signals = {"SIGINT" : 2, "SIGTERM" : 15 };
Object.keys(signals).forEach((signal) => {
    process.on(signal, () => {
        for (var index = 0; index < accessories.length; index++) {
            accessories[index].unpublish();
        }
      
        setTimeout(() => {
            process.exit(128 + signals[signal]);
        }, 1000);
    });
});