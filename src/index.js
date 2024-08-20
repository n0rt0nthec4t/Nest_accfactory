// Homebridge platform allowing Nest devices to be used with HomeKit
// This is a port from my standalone project, Nest_accfactory to Homebridge
//
// This includes having support for HomeKit Secure Video (HKSV) on doorbells and cameras
//
// The following Nest devices are supported
//
// Nest Thermostats (Gen 1, Gen 2, Gen 3, E, Mirrored 2020)
// Nest Protects (Gen 1, Gen 2)
// Nest Temperature Sensors
// Nest Cameras (Cam Indoor, IQ Indoor, Outdoor, IQ Outdoor)
// Nest Hello (Wired Gen 1)
//
// The accessory supports authentication to Nest/Google using either a Nest account OR Google (migrated Nest account) account.
// 'preliminary' support for using FieldTest account types also.
//
// Supports both Nest REST and protobuf APIs for communication to Nest systems
//
// Code version 20/8/2024
// Mark Hulskamp
'use strict';

// Define Homebridge module requirements
import HAP from 'hap-nodejs';

// Define nodejs module requirements
import process from 'node:process';
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import our modules
import NestAccfactory from './system.js';

import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'Nest-accfactory';
HomeKitDevice.PLATFORM_NAME = 'NestAccfactory';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.HISTORY = HomeKitHistory;

import Logger from './logger.js';
const log = Logger.withPrefix(HomeKitDevice.PLATFORM_NAME);

const __filename = fileURLToPath(import.meta.url);                              // Make a defined for JS __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));                 // Make a defined for JS __dirname
const ACCESSORYPINCODE = '031-45-154';                                          // Default HomeKit pairing code
const CONFIGURATIONFILE = 'Nest_config.json';                                   // Default configuration file name
const FFMPEGLIBARIES = ['libspeex', 'libx264', 'libfdk-aac'];                   // Ffmpeg libraries we require for camera/doorbell(s)
const FFMPEGVERSION = '6.0';                                                    // Minimum version of ffmpeg we require

// General helper functions which don't need to be part of an object class
function loadConfiguration(filename) {
    if (typeof filename !== 'string' ||
        filename === '' ||
        fs.existsSync(filename) === false) {

        return;
    }

    let config = undefined;

    try {
        let loadedConfig = JSON.parse(fs.readFileSync(filename));

        config = {
            nest: {},
            google: {},
            options: {},
            devices: {},
        };

        Object.entries(loadedConfig).forEach(([key, value]) => {
            // Global options if not an object
            if (key === 'Connections' && typeof value === 'object') {
                // Array of 'connections' to different logins. Can be a combination of Nest, google and SDM
                Object.entries(value).forEach(([subKey, value]) => {
                    if (subKey === 'Nest' && typeof value === 'object' &&
                        typeof value?.access_token === 'string' && value.access_token !== '') {

                        // Nest accounts access_token to use for Nest API calls
                        config.nest = {
                            'access_token': value.access_token.trim(),
                            'fieldTest' : (typeof value?.FieldTest === 'boolean' ? value.FieldTest : false),
                        };
                    }
                    if (subKey === 'Google' && typeof value === 'object' &&
                        typeof value?.issuetoken === 'string' && value.issuetoken !== '' &&
                        typeof value?.cookie === 'string' && value.cookie !== '') {

                        // Google account issue token and cookie for Nest API calls
                        config.google = {
                            'issuetoken' : value.issuetoken.trim(),
                            'cookie' : value.cookie.trim(),
                            'fieldTest' : (typeof value?.FieldTest === 'boolean' ? value.FieldTest : false),
                        };
                    }
                });
            }
            if (key === 'SessionToken' && typeof value === 'string' && value !== '') {
                // Nest accounts Session token to use for Nest API calls
                // NOTE: Legacy option. Use Connections option(s)
                config.nest = {
                    'access_token': value.trim(),
                    'fieldTest' : (typeof loadedConfig?.FieldTest === 'boolean' ? loadedConfig.FieldTest : false),
                };
            }
            if (key === 'GoogleToken' && typeof value === 'object' &&
                typeof value?.issuetoken === 'string' && value.issuetoken !== '' &&
                typeof value?.cookie === 'string' && value.cookie !== '') {

                // Google account issue token and cookie for Nest API calls
                // NOTE: Legacy option. Use Connections option(s)
                config.google = {
                    'issuetoken' : value.issuetoken.trim(),
                    'cookie' : value.cookie.trim(),
                    'fieldTest' : (typeof value?.FieldTest === 'boolean' ? value.FieldTest : false),
                };
            }
            if (key === 'mDNS' && typeof value === 'string' & value !== '') {
                if (value.trim().toUpperCase() === 'CIAO') {
                    // Use ciao as the mDNS advertiser
                    config.options.mDNS = HAP.MDNSAdvertiser.CIAO;
                }
                if (value.trim().toUpperCase() === 'BONJOUR') {
                    // Use bonjour as the mDNS advertiser
                    config.options.mDNS = HAP.MDNSAdvertiser.BONJOUR;
                }
                if (value.trim().toUpperCase() === 'AVAHI') {
                    // Use avahi as the mDNS advertiser
                    config.options.mDNS = HAP.MDNSAdvertiser.AVAHI;
                }
            }
            if (key === 'EveApp' && typeof value === 'boolean') {
                // Global Evehome app integration
                config.options.eveApp = value;
            }
            if (key === 'Weather' && typeof value === 'boolean') {
                // Global weather device(s)
                config.options.weather = value;
            }
            if (key === 'HKSV' && typeof value === 'boolean') {
                // Global excluding for all device(s) by default
                config.options.hksv = value;
            }
            if (key === 'HomeKitCode' && typeof value === 'string' && value !== '') {
                // Global HomeKit paring code
                config.options.hkPairingCode = value;
            }
            if (key === 'DoorbellCooldown' && typeof value === 'number') {
                if (value >= 1000) {
                    // If greather than 1000, assume milliseconds value passed in, so convert to seconds
                    value = Math.floor(value / 1000);
                }
                config.options.doorbellCooldown = value;
            }
            if (key === 'MotionCooldown' && typeof value === 'number') {
                if (value >= 1000) {
                    // If greather than 1000, assume milliseconds value passed in, so convert to seconds
                    value = Math.floor(value / 1000);
                }
                config.options.motionCooldown = value;
            }
            if (key === 'PersonCooldown' && typeof value === 'number') {
                if (value >= 1000) {
                    // If greather than 1000, assume milliseconds value passed in, so convert to seconds
                    value = Math.floor(value / 1000);
                }
                config.options.personCooldown = value;
            }
            if (key !== 'Connections' && key !== 'GoogleToken' && typeof value === 'object') {
                // Since key value is an object, and not an object for a value we expect
                // Ssumme its a device configuration for matching serial number
                key = key.toUpperCase();
                config.devices[key] = {};
                Object.entries(value).forEach(([subKey, value]) => {
                    if (subKey === 'Exclude' && typeof value === 'boolean') {
                        // Per device excluding
                        config.devices[key]['exclude'] = value;
                    }
                    if (subKey === 'HumiditySensor' && typeof value === 'boolean') {
                        // Seperate humidity sensor for this device (Only valid for thermostats)
                        config.devices[key]['humiditySensor'] = value;
                    }
                    if (subKey === 'EveApp' && typeof value === 'boolean') {
                        // Per device Evehome app integration
                        config.devices[key]['eveApp'] = value;
                    }
                    if (subKey === 'HKSV' && typeof value === 'boolean') {
                        // Per device HomeKit Secure Video
                        config.devices[key]['hksv'] = value;
                    }
                    if (subKey === 'Option.indoor_chime_switch' && typeof value === 'boolean') {
                        // Per device HomeKit Secure Video
                        config.devices[key]['chimeSwitch'] = value;
                    }
                    if (subKey === 'Option.elevation' && typeof value === 'number') {
                        // Per device HomeKit Secure Video
                        config.devices[key]['elevation'] = value;
                    }
                    if (subKey === 'HomeKitCode' && typeof value === 'string' && value !== '') {
                        // Per device HomeKit paring code
                        config.devices[key]['hkPairingCode'] = value;
                    }
                    if (subKey === 'DoorbellCooldown' && typeof value === 'number') {
                        if (value >= 1000) {
                            // If greather than 1000, assume milliseconds value passed in, so convert to seconds
                            value = Math.floor(value / 1000);
                        }
                        config.devices[key]['doorbellCooldown'] = value;
                    }
                    if (subKey === 'MotionCooldown' && typeof value === 'number') {
                        if (value >= 1000) {
                            // If greather than 1000, assume milliseconds value passed in, so convert to seconds
                            value = Math.floor(value / 1000);
                        }
                        config.devices[key]['motionCooldown'] = value;
                    }
                    if (subKey === 'PersonCooldown' && typeof value === 'number') {
                        if (value >= 1000) {
                            // If greather than 1000, assume milliseconds value passed in, so convert to seconds
                            value = Math.floor(value / 1000);
                        }
                        config.devices[key]['personCooldown'] = value;
                    }
                    if (subKey.startsWith('External') === true && typeof value === 'string' && value !== '') {
                        config.devices[key]['external' + subKey.substring(6)] = value;
                    }
                });
            }
        });

        // If we do not have a default HomeKit pairing code, add one in
        if (config?.options?.hkPairingCode === undefined) {
            config.options.hkPairingCode = ACCESSORYPINCODE;
        }
    } catch (error) {
        // Empty
    }

    return config;
}

function validateFFMPEGBinary() {
    let valid = false;

    // Validates if the ffmpeg binary has been compiled to support the required libraries we need for camera/doorbell support
    // <---- TODO ensure also has the right codecs, protocols, muxers etc for what we need
    // <---- Break out into an FFmpeg object we can use
    let ffmpegProcess = child_process.spawnSync(__dirname + '/ffmpeg', ['-version'], { env: process.env });
    if (ffmpegProcess.stdout !== null) {
        // Determine ffmpeg version. Flatten version number into 0.xxxxxxx number for later comparision
        let ffmpegVersion = parseFloat('0.' + ffmpegProcess.stdout.toString().match(/(?:ffmpeg version:(\d+)\.)?(?:(\d+)\.)?(?:(\d+)\.\d+)(.*?)/gmi)[0].replace(/\./gi, ''));

        // Determine what libraries ffmpeg is compiled with
        let matchingLibraries = 0;
        FFMPEGLIBARIES.forEach((libraryName) => {
            if (ffmpegProcess.stdout.toString().includes('--enable-'+libraryName) === true) {
                matchingLibraries++;    // One more found library
            }
        });
        valid = (matchingLibraries === FFMPEGLIBARIES.length && ffmpegVersion >= parseFloat('0.' + FFMPEGVERSION.toString().replace(/\./gi, '')));
    }

    return valid;
}

// Startup code
log.info('Starting ' + __filename + ' using HAP-NodeJS library v' + HAP.HAPLibraryVersion());

// Validate ffmpeg if present and if so, does it include the required libraries to support doorbells/cameras
if (validateFFMPEGBinary() === false) {
    // ffmpeg binary doesn't support the required libraries we require
    log.warn('The FFmpeg binary in path "%s" does not meet the minimum version required AND/OR does not support the required libraries for doorbell and/or camera usage', (__dirname + '/ffmpeg'));
    log.warn('FFmpeg is required to be at minimum version of "%s"', FFMPEGVERSION);
    log.warn('FFmpeg needs to be compiled to include the following libraries:', FFMPEGLIBARIES);
}

// Check to see if a configuration file was passed into use and validate if present
let configurationFile = path.resolve(__dirname + '/' + CONFIGURATIONFILE);
if (process.argv.slice(2).length === 1) {  // We only support/process one argument
    configurationFile = process.argv.slice(2)[0];   // Extract the file name from the argument passed in
    if (configurationFile.indexOf('/') === -1) {
        configurationFile = path.resolve(__dirname + '/' + configurationFile);
    }
}
if (fs.existsSync(configurationFile) === false) {
    // Configuration file, either by default name or specified on commandline is missing
    log.error('Specified configuration "%s" cannot be found', configurationFile);
    log.error('Exiting.');
    process.exit(1);
}

// Have a configuration file, now load the configuration options
log.info('Configuration will be read from "%s"', configurationFile);
let config = loadConfiguration(configurationFile);
if (config === undefined) {
    log.info('Configuration file contains invalid JSON options');
    log.info('Exiting.');
    process.exit(1);
}
if (config?.nest === undefined || config?.google === undefined ) {
    log.info('No Nest and/or Google connection details have been specified in the configuration file');
    log.info('Exiting.');
    process.exit(1);
}

// For each connection specified in the configuration file
log.info('Devices will be advertised to HomeKit using "%s" mDNS provider', (typeof config?.options?.mDNS !== 'undefined' ? config.options?.mDNS : HAP.MDNSAdvertiser.CIAO));
let nest = new NestAccfactory(log, config, HAP);
nest.discoverDevices();    // Kick things off :-)