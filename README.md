# Nest_accfactory

This is a HAP-NodeJS accessory I have developed to allow Nest devices to be used with HomeKit. 

## Supported Devices

The following pre-2019 Nest devices are support with this project

Nest Thermostats
    Gen 1
    Gen 2
    Gen 3
    E
Nest Protects
    Gen 1
    Gen 2
Nest Temp Sensors
Nest Cams
    Cam Indoor/IQ Indoor
    Cam Outdoor/IQ Outdoor
Nest Hello
    Wired Gen 1

The accessory supports connection to Nest using a Nest account OR a Google (migrated Nest account) account.

## Configuration

Nest_config.json is the configuration file where various options can be. An example of a basic configuration is below:

```
{
    "RefreshToken" : "<nest session token>",
    "HKSV" : true,
    "H264Encoder" : "copy"
}
```

The options available are within the configuration file are listed below

| Option           | Values                  | Description                                                            |
|------------------|-------------------------|------------------------------------------------------------------------|
| Refresh Token    |                         | Google account refresh token                                           |
| Session Token    |                         | Nest session token. Obtain from home.nest.com/session                  |
| Debug            | true, false             | Turns debugging on or off. Default is off                              |
| mDNS             | avahi, bonjour, ciao    | mDNS advertiser library to use. Default is ciao                        |
| HKSV             | true, false             | Turns HomeKit Secure Video on or off for doorbells and/cameras         |
| HKSVPreBuffer    | seconds or milliseconds | Amount of time the pre-buffer for HomeKit Secure Video holds data      |
| H264Encoder      | copy, libx264, h264_omx | H264 encoder ffmpeg uses fior streaming and recording. Default is copy |
| MotionCooldown   | seconds or milliseconds | Ignore motion detection for this time once triggered                   |
| PersonCooldown   | seconds or milliseconds | Ignore person detection for this time once triggered. Non HKSV only    |
| DoorbellCooldown | seconds or milliseconds | Ignore doorbeel button pressed for this time once triggered            |
