// HomeKitDevice class
//
// This is the base class for all HomeKit accessories we code to
//
// The deviceData structure should, at a minimum contain the following elements. These also need to be a "string" type
// uuid
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
// Code version 23/7/2024
// Mark Hulskamp

"use strict";

// Define HAP-NodeJS requirements
var HAP = require("hap-nodejs");

// Define nodejs module requirements
var util = require("util");
var path = require("path");
var fs = require("fs");

// Define our HomeKit device class
class HomeKitDevice {
    constructor(HomeKitAccessoryName, HomeKitPairingCode, HomeKitMDNSAdvertiser, initialDeviceData, eventEmitter) {
        this.eventEmitter = null;                               // Event emitter to use. Allow comms from other objects
        this.HomeKitAccessory = null;                           // HomeKit Accessory object
        this.HomeKitHistory = null;                             // History logging service
        this.HomeKitManufacturerName = HomeKitAccessoryName;    // HomeKit device manufacturer name. Used for logging output prefix also
        this.HomeKitPairingCode = HomeKitPairingCode;           // HomeKit pairing code
        this.mDNSAdvertiser = HomeKitMDNSAdvertiser;            // mDNS Provider to use for this device
        this.deviceData = initialDeviceData;                    // Make copy of current data and store in this object

        // Validate if eventEmitter object passed to us is an instance of EventEmitter
        if (eventEmitter instanceof require("events").EventEmitter == true) {
            this.eventEmitter = eventEmitter; // Store
        }
    }

    // Class functions
    add(mDNSAdvertiseName, HAPAccessoryCategory, useHistoryService) {
        if (typeof this.deviceData != "object" || 
            typeof HAP.Categories[HAPAccessoryCategory] == "undefined" ||
            typeof useHistoryService != "boolean" ||
            typeof mDNSAdvertiseName != "string" || mDNSAdvertiseName == "" ||
            this.HomeKitAccessory instanceof require("hap-nodejs").Accessory == true ||
            this.deviceData.hasOwnProperty("uuid") == false || typeof this.deviceData.uuid != "string" || this.deviceData.uuid == "" || 
            this.deviceData.hasOwnProperty("mac_address") == false || typeof this.deviceData.mac_address != "string" || this.#validMACAddress(this.deviceData.mac_address) == false || 
            this.deviceData.hasOwnProperty("serial_number") == false || typeof this.deviceData.serial_number != "string" || this.deviceData.serial_number == "" ||
            this.deviceData.hasOwnProperty("software_version") == false || typeof this.deviceData.software_version != "string" || this.deviceData.software_version == "" ||
            this.deviceData.hasOwnProperty("description") == false || typeof this.deviceData.description != "string" && this.deviceData.description == "" ||
            this.deviceData.hasOwnProperty("model") == false || typeof this.deviceData.model != "string" || this.deviceData.model == "" ||
            this.deviceData.hasOwnProperty("manufacturer") == false || typeof this.deviceData.manufacturer != "string" || this.deviceData.manufacturer == "") {

            return;
        }

        // Setup event listener to process "messages" to/from our device
        if (this.eventEmitter instanceof require("events").EventEmitter == true) {
            this.eventEmitter.addListener(this.deviceData.uuid, this.#message.bind(this));
        }

        // Create the HomeKit accessory and set accessory information
        this.HomeKitAccessory = new HAP.Accessory(mDNSAdvertiseName, HAP.uuid.generate("hap-nodejs:accessories:" + this.deviceData.manufacturer.toLowerCase() + "_" + this.deviceData.serial_number));
        this.HomeKitAccessory.username = this.deviceData.mac_address;
        this.HomeKitAccessory.pincode = this.HomeKitPairingCode;
        this.HomeKitAccessory.category = HAPAccessoryCategory;
        this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.Manufacturer, this.deviceData.manufacturer);
        this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.Model, this.deviceData.model);
        this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.SerialNumber, this.deviceData.serial_number);
        this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.FirmwareRevision, this.deviceData.software_version);

        if (useHistoryService == true && typeof HomeKitDevice.HOMEKITHISTORY == "function" && this.HomeKitHistory == null) {
            // Setup logging service as requsted
            this.HomeKitHistory = new HomeKitDevice.HOMEKITHISTORY(this.HomeKitAccessory, {});
        }

        try {
            var postSetupDetails = this.addHomeKitServices(this.deviceData.description);
        } catch (error) {
            this.#outputLogging("addHomeKitServices call for device '%s' failed. Error was", this.deviceData.description, error);
        }

        // perform an initial update using current data
        this.update(this.deviceData, true);

        // Check permissions for HAP-NodeJS to access required storage for this device
        var storagePath = path.normalize(process.cwd() + "/" + HAP.HAPStorage.storage().options.dir);
        var fileAccessIssues = [];
        fs.readdirSync(storagePath).filter((file) => file.includes(this.HomeKitAccessory.username.replace(/:/g, "").toUpperCase())).forEach((file) => {
            try {
                fs.accessSync(storagePath + "/" + file, fs.constants.R_OK | fs.constants.W_OK);
            } catch (error) {
               // Access permission error to file
               fileAccessIssues.push(storagePath + "/" + file);
            }
        });

        if (fileAccessIssues.length == 0) {
            // Publish accessory on local network and push onto export array for HAP-NodeJS "accessory factory"
            this.HomeKitAccessory.publish({username: this.HomeKitAccessory.username, pincode: this.HomeKitAccessory.pincode, category: this.HomeKitAccessory.category, advertiser: this.mDNSAdvertiser});
            this.#outputLogging("Setup %s %s as '%s'", this.deviceData.manufacturer, this.deviceData.model, this.deviceData.description);
            this.#outputLogging("  += Advertising as '%s'", this.HomeKitAccessory.displayName);
            this.#outputLogging("  += Pairing code is '%s'", this.HomeKitPairingCode);
            this.HomeKitHistory.EveHome && this.#outputLogging("  += EveHome support as '%s'", this.HomeKitHistory.EveHome.evetype);
            if (typeof postSetupDetails == "object") {
                postSetupDetails.forEach((output) => {
                    this.#outputLogging("  += %s", output);
                });
            }
        }

        if (fileAccessIssues.length != 0) {
            // Detected file permission/access issues with HAP-NodeJS file storage, so we'll be unable to publish this accessory on the local network for HomeKit
            this.#outputLogging("Permission/access issues to required storage used by HAP-NodeJS. This will prevent accessory from operating correctly in HomeKit until corrected");
            fileAccessIssues.forEach((file) => {
                this.#outputLogging("  += '%s'", file);
            });
        }
    }

    remove() {
        this.#outputLogging("Device '%s' has been removed", this.deviceData.description);

        if (this.eventEmitter instanceof require("events").EventEmitter == true && 
            this.deviceData.hasOwnProperty("uuid") == true && 
            typeof this.deviceData.uuid == "string" && 
            this.deviceData.uuid != "") {
            
            // Remove listener for "messages"
            this.eventEmitter.removeAllListeners(this.deviceData.uuid);
        }

        try {
            this.removeHomeKitServices(); 
        } catch (error) {
            this.#outputLogging("removeHomeKitServices call for device '%s' failed. Error was", this.deviceData.description, error);
        }
 
        if (this.HomeKitAccessory instanceof require("hap-nodejs").Accessory == true) {
            // Unpublish the accessory from the local network
            this.HomeKitAccessory.unpublish();
        }
        
        this.deviceData = null;
        this.HomeKitAccessory = null;
        this.eventEmitter = null;
        this.HomeKitHistory = null;

        // Do we destroy this object??
        // this = null;
        // delete this;
    }

    update(updatedDeviceData, forceHomeKitUpdate) {
        if (typeof updatedDeviceData != "object" || 
            typeof forceHomeKitUpdate != "boolean") {

            return;
        }

        // Updated data may only contain selected fields, so we'll handle that here by taking our internally stored data
        // and merge with the updates to ensure we have a complete data object
        Object.entries(this.deviceData).forEach(([key, value]) => {
            if (updatedDeviceData.hasOwnProperty(key) == false) {
                // Updated data doesn't have this key, so add it to our internally stored data
                updatedDeviceData[key] = value;
            }
        });

        // Check updated device data with our internally stored data. Flag if changes between the two
        var changedData = false;
        Object.entries(updatedDeviceData).forEach(([key, value]) => {
            if (JSON.stringify(updatedDeviceData[key]) !== JSON.stringify(this.deviceData[key])) {
                changedData = true;
            }
        }); 

        // If we have any changed data OR we've been requested to force an update, do so here
        if (changedData == true || forceHomeKitUpdate == true) {
            if (this.HomeKitAccessory instanceof require("hap-nodejs").Accessory == true &&
                updatedDeviceData.hasOwnProperty("software_version") == true && 
                updatedDeviceData.software_version != this.deviceData.software_version) {

                // Update software version on the HomeKit accessory
                this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.FirmwareRevision, updatedDeviceData.software_version);
            }

            if (this.HomeKitAccessory instanceof require("hap-nodejs").Accessory == true &&
                updatedDeviceData.hasOwnProperty("serial_number") == true && 
                updatedDeviceData.serial_number != this.deviceData.serial_number) {

                // Update serial number on the HomeKit accessory
                this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.SerialNumber, updatedDeviceData.serial_number);
            }

            if (updatedDeviceData.hasOwnProperty("online") == true && 
                updatedDeviceData.online != this.deviceData.online) {

                // Output device online/offline status
                this.#outputLogging("Device '%s' is %s", this.deviceData.description, (updatedDeviceData.online == true ? "online" : "offline"));
            }

            try {
                this.updateHomeKitServices(updatedDeviceData);  // Pass updated data on for accessory to process as it needs
            } catch (error) {
                this.#outputLogging("updateHomeKitServices call for device '%s' failed. Error was", this.deviceData.description, error);
            }
            this.deviceData = updatedDeviceData;    // Finally, update our internally stored data with the new data
        }
    }

    set(valuesToSet) {
        if (typeof valuesToSet != "object" || 
            this.eventEmitter instanceof require("events").EventEmitter == false || 
            this.deviceData.hasOwnProperty("uuid") == false ||
            typeof this.deviceData.uuid != "string" || 
            this.deviceData.uuid == "") {
            
            return;
        }
        
        // Send event with data to set
        this.eventEmitter.emit(HomeKitDevice.SET, this.deviceData.uuid, valuesToSet);
    }

    get(valuesToGet) {
        if (typeof valuesToGet != "object" ||
            this.eventEmitter instanceof require("events").EventEmitter == false || 
            this.deviceData.hasOwnProperty("uuid") == false ||
            typeof this.deviceData.uuid != "string" || 
            this.deviceData.uuid == "") {
            
            return;
        }

        // <---- TODO
        // Send event with data to get. Once get has completed, callback will be called with the requested data
        //this.eventEmitter.emit(HomeKitDevice.GET, this.deviceData.uuid, valuesToGet);
        //
        // await ....
        // return gottenValues;
        // <---- TODO
        // Probable need some sort of await event 
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

    #validMACAddress(mac_address) {
        var regex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
        return regex.test(mac_address); // true or false
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

