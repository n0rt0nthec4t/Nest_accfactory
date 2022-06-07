This is a HAP-NodeJS accessory I have developed to allow Nest devices to be used with HomeKit. 

HomeKit Secure Video is supported on doorbells and camera devices [^note]

## Supported Devices

The following Nest devices are supported

* Nest Thermostats (Gen 1, Gen 2, Gen 3, E)
* Nest Protects (Gen 1, Gen 2)
* Nest Temp Sensors
* Nest Cameras (Cam Indoor, IQ Indoor, Outdoor, IQ Outdoor)
* Nest Hello (Wired Gen 1)

The accessory supports connection to Nest using a Nest account OR a Google (migrated Nest account) account.

## Configuration

Nest_config.json is the configuration file where various options can be. An example of a basic configuration is below

```
{
    "SessionToken" : "<nest session token>",
    "HKSV" : true,
    "H264Encoder" : "copy"
}
```

An advanced configuration example is below

```
{
    "SessionToken" : "<nest session token>",
    "HKSV" : false,
    "H264Encoder" : "copy",
    "SERIAL1" : {
        "Exclude" : true
    },
    "SERIAL2" : {
        "HKSV" : true,
        "MotionCoolDown" : 2
    },
}
```

The options available are within the configuration file are listed below. Some of these options can also be on specific devices only

| Option           | Values                  | Description                                                                               | Global/Local |
|------------------|-------------------------|-------------------------------------------------------------------------------------------|--------------|
| RefreshToken     |                         | Google account refresh token                                                              | global       |
| SessionToken     |                         | Nest session token. Obtain from home.nest.com/session                                     | global       |
| Debug            | true, false             | Turns debugging on or off. Default is off                                                 | global       |
| mDNS             | avahi, bonjour, ciao    | mDNS advertiser library to use. Default is ciao                                           | global       |
| HKSV             | true, false             | Turns HomeKit Secure Video on or off for doorbells and/cameras. Default is off.           | global/local |
| HKSVPreBuffer    | seconds or milliseconds | Amount of time the pre-buffer for HomeKit Secure Video holds data. Default is 15 seconds  | global/local |
| H264Encoder      | copy, libx264, h264_omx | H264 encoder ffmpeg used for streaming and recording. Default is copy                     | global       |
| MotionCooldown   | seconds or milliseconds | Ignore motion detection for this time once triggered. Default is 1 minute                 | global/local |
| PersonCooldown   | seconds or milliseconds | Ignore person detection for this time once triggered (Non HKSV only) Default is 2 minutes | global/local |
| DoorbellCooldown | seconds or milliseconds | Ignore doorbeel button pressed for this time once triggered Default is 1 minute           | global/local |
| Exclude          | true, false             | Exclude a device                                                                          | local        |

## Docker Image

If you would like to try this in a containerised verson, please check out the [docker hub repository](https://hub.docker.com/r/n0rt0nthec4t/nest_accfactory) for this project


[^note]: HomeKit Secure Video Support is disabled by default and needs to be explicitly enabled by the user
