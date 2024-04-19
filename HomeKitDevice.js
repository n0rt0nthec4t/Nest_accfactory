// HomeKitDevice class
//
// This is the base class for all HomeKit accessories we code to
//
// The deviceData structure should, at a minimum contain the following elements. These also need to be a "string" type
// mac_address
// serial_number
// software_version
// description
// manufacturer
// model
//
// Following constants should be overridden in the module loading this class file
//
// HomeKitDevice.HOMEKITHISTORY - HomeKit History module
//
// Code version 18/4/2024
// Mark Hulskamp

"use strict";

// Define HAP-NodeJS requirements
var HAP = require("hap-nodejs");

// Define nodejs module requirements
var util = require("util");


class HomeKitDevice {
    constructor(HomeKitAccessoryName, HomeKitPairingCode, HomeKitMDNSAdvertiser, uniqueUUIDForDevice, currentDeviceData, globalEventEmitter) {
        this.eventEmitter = null;                               // Event emitter to use. Allow comms from other objects
        
        this.deviceUUID = uniqueUUIDForDevice;                  // Unique UUID for this device. Used for event messaging to this device4
        this.deviceData = currentDeviceData;                    // Make copy of current data and store in this object
       
        this.HomeKitAccessory = null;                           // HomeKit Accessory object
        this.HomeKitManufacturerName = HomeKitAccessoryName;    // HomeKit device manufacturer name. Used for logging output prefix also
        this.HomeKitHistory = null;                             // History logging service
        this.HomeKitPairingCode = HomeKitPairingCode;           // HomeKit pairing code

        this.mDNSAdvertiser = HomeKitMDNSAdvertiser;            // MDNS Provider to use for this device

        // Validate if globalEventEmitter object passed to us is an instance of EventEmitter
        if (globalEventEmitter instanceof require("events").EventEmitter == true) {
            this.eventEmitter = globalEventEmitter; // Store

            // Setup event listener to process "messages" to/from our device
            this.eventEmitter.addListener(this.deviceUUID, this.#message.bind(this));
        }
    }

    // Class functions
    add(mDNSAdvertiseName, HomeKitAccessoryCategory, useHistoryService) {
        if (typeof this.deviceData != "object" || typeof HAP.Accessory.Categories[HomeKitAccessoryCategory] == "undefined" ||  typeof mDNSAdvertiseName != "string" || typeof useHistoryService != "boolean" ||
            (this.deviceData.hasOwnProperty("mac_address") == false && typeof this.deviceData.mac_address != "string" && this.deviceData.mac_address == "") || 
            (this.deviceData.hasOwnProperty("serial_number") == false && typeof this.deviceData.serial_number != "string" && this.deviceData.serial_number == "") ||
            (this.deviceData.hasOwnProperty("software_version") == false && typeof this.deviceData.software_version != "string" && this.deviceData.software_version == "") ||
            (this.deviceData.hasOwnProperty("description") == false && typeof this.deviceData.description != "string" && this.deviceData.description == "") ||
            (this.deviceData.hasOwnProperty("model") == false && typeof this.deviceData.model != "string" && this.deviceData.model == "") ||
            this.HomeKitAccessory != null ||
            mDNSAdvertiseName == "") {

            return;
        }

        this.HomeKitAccessory = exports.accessory = new HAP.Accessory(mDNSAdvertiseName, HAP.uuid.generate("hap-nodejs:accessories:" + this.deviceData.manufacturer.toLowerCase() + "_" + this.deviceData.serial_number));
        this.HomeKitAccessory.username = this.deviceData.mac_address;
        this.HomeKitAccessory.pincode = this.HomeKitPairingCode;
        this.HomeKitAccessory.category = HomeKitAccessoryCategory;
        this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.Manufacturer, this.deviceData.manufacturer);
        this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.Model, this.deviceData.model);
        this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.SerialNumber, this.deviceData.serial_number);
        this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.FirmwareRevision, this.deviceData.software_version);

        if (useHistoryService == true && typeof HomeKitDevice.HOMEKITHISTORY != "undefined" && this.HomeKitHistory == null) {
            // Setup logging service as requsted
            this.HomeKitHistory = new HomeKitDevice.HOMEKITHISTORY(this.HomeKitAccessory, {});
        }

        try {
            this.addHomeKitServices(this.deviceData.description);
        } catch (error) {
            this.#outputLogging("addHomeKitServices call for device '%s' failed. Error was", this.deviceData.description, error);
        }

        // perform an initial update using current data
        this.update(this.deviceData, true);

        // Publish accessory on local network and push onto export array for HAP-NodeJS "accessory factory"
        this.HomeKitAccessory.publish({username: this.HomeKitAccessory.username, pincode: this.HomeKitAccessory.pincode, category: this.HomeKitAccessory.category, advertiser: this.mDNSAdvertiser});
        this.#outputLogging("Advertising '%s' as '%s' to local network. HomeKit pairing code is '%s'", this.deviceData.description, this.HomeKitAccessory.displayName, this.HomeKitAccessory.pincode);
    }

    remove() {
        this.#outputLogging("Device '%s' has been removed", this.deviceData.description);

        if (this.eventEmitter != null) {
            // Remove listener for "messages"
            this.eventEmitter.removeAllListeners(this.deviceUUID);
        }

        try {
            this.removeHomeKitServices(); 
        } catch (error) {
            this.#outputLogging("removeHomeKitServices call for device '%s' failed. Error was", this.deviceData.description, error);
        }
 
        this.HomeKitAccessory.unpublish();
        this.deviceData = null;
        this.HomeKitAccessory = null;
        this.eventEmitter = null;
        this.HomeKitHistory = null;

        // Do we destroy this object??
        // this = null;
        // delete this;
    }

    update(updatedDeviceData, forceHomeKitUpdate) {
        if (typeof updatedDeviceData != "object" || typeof forceHomeKitUpdate != "boolean") {
            return;
        }

        // Updated data may only contain selected fields, so we'll handle that here by taking our internally stored data
        // and merge with the updates to ensure we have a complete data object
        Object.entries(this.deviceData).forEach(([key, value]) => {
            if (typeof updatedDeviceData[key] == "undefined") {
                // Updated data doesn't have this key, so add it to our internally stored data
                updatedDeviceData[key] = value;
            }
        });

        // Check to see what data elements have changed
        var changedObjectElements = {};
        Object.entries(updatedDeviceData).forEach(([key, value]) => {
            if (JSON.stringify(updatedDeviceData[key]) !== JSON.stringify(this.deviceData[key])) {
                changedObjectElements[key] = updatedDeviceData[key];
            }
        }); 

        // If we have any changed data elements OR we've been requested to force an update, do so
        if (Object.keys(changedObjectElements).length != 0 || forceHomeKitUpdate == true) {
            if (updatedDeviceData.hasOwnProperty("software_version") == true && updatedDeviceData.software_version != this.deviceData.software_version) {
                // Update software version
                this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.FirmwareRevision, updatedDeviceData.software_version);
            }

            if (updatedDeviceData.hasOwnProperty("serial_number") == true && updatedDeviceData.serial_number != this.deviceData.serial_number) {
                // Update serial number
                this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.SerialNumber, updatedDeviceData.serial_number);
            }

            if (updatedDeviceData.hasOwnProperty("online") == true && updatedDeviceData.online != this.deviceData.online) {
                // Update online/offline status
                this.#outputLogging("Device '%s' is %s", this.deviceData.description, (updatedDeviceData.online == true ? "online" : "offline"));
            }

            try {
                this.updateHomeKitServices(updatedDeviceData);  // Pass updated data on for accessory to process as it needs
            } catch (error) {
                this.#outputLogging("updateHomeKitServices call for device '%s' failed. Error was", this.deviceData.description, error);
            }
            this.deviceData = updatedDeviceData;    // Finally, update our internally stored data about the device
        }
    }

    set(keyValues) {
        if (typeof keyValues != "object" || this.eventEmitter == null) {
            return;
        }
        
        // Send event with data to set
        this.eventEmitter.emit(HomeKitDevice.SET, this.deviceUUID, keyValues);
    }

    get() {
        // <---- To Implement
    }

    addHomeKitServices(serviceName) {
        // <---- override in class which extends this class
    }

    removeHomeKitServices() {
        // <---- override in class which extends this class
    }

    updateHomeKitServices(updatedDeviceData) {
        // <---- override in class which extends this class 
    }

    messageHomeKitServices(messageType, messageData) {
        // <---- override in class which extends this class 
    }

    #message(messageType, messageData) {
        switch (messageType) {
            case HomeKitDevice.UPDATE : {
               this.update(messageData, false);    // Got some device data, so process any updates
               break;
            }

            case HomeKitDevice.REMOVE : {
                this.remove();  // Got message for device removal
                break
            }

            default : {
                // This is not a message we know about, so pass onto accessory for it to perform any processing
                try {
                    this.messageHomeKitServices(messageType, messageData);
                } catch (error) {
                    this.#outputLogging("messageHomeKitServices call for device '%s' failed. Error was", this.deviceData.description, error);
                }
                break;
            }
        }
    }

    #outputLogging(...outputMessage) {
        var timeStamp = String(new Date().getFullYear()).padStart(4, "0") + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0") + " " + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + ":" + String(new Date().getSeconds()).padStart(2, "0");
        console.log(timeStamp + " [" + this.HomeKitManufacturerName + "] " + util.format(...outputMessage)); 
    }
}

// Export defines for this module
HomeKitDevice.UPDATE = "HomeKitDevice.update";          // Device update message
HomeKitDevice.REMOVE = "HomeKitDevice.remove";          // Device remove message
HomeKitDevice.SET = "HomeKitDevice.set";                // Device set property message
HomeKitDevice.GET = "HomeKitDevice.get";                // Device get property message
HomeKitDevice.UNPUBLISH = "HomeKitDevice.unpublish";    // Device unpublish message
HomeKitDevice.HOMEKITHISTORY = undefined;               // HomeKit History module
module.exports = HomeKitDevice;

