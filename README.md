<span align="center">
  
# Nest_accfactory
  
  <a href="https://github.com/n0rt0nthec4t/Nest_accfactory/releases"><img title="version" src="https://img.shields.io/github/release/n0rt0nthec4t/Nest_accfactory.svg?include_prereleases" ></a>
    <a href="https://github.com/n0rt0nthec4t/Nest_accfactory/releases"><img title="date" src="https://img.shields.io/github/release-date/n0rt0nthec4t/Nest_accfactory" ></a>
  <a href="https://github.com/n0rt0nthec4t/Nest_accfactory/releases"><img title="nodejs version" src="https://img.shields.io/github/package-json/dependency-version/n0rt0nthec4t/Nest_accfactory/hap-nodejs"> </a>
  
</span>

This is a HAP-NodeJS accessory I have developed to allow Nest devices to be used with HomeKit including having support for HomeKit Secure Video on doorbells and camera devices

**HomeKit Secure Video Support is disabled by default and needs to be explicitly enabled by the user**

## Supported Devices

The following Nest devices are supported

* Nest Thermostats (Gen 1, Gen 2, Gen 3, E)
* Nest Protects (Gen 1, Gen 2)
* Nest Temp Sensors
* Nest Cameras (Cam Indoor, IQ Indoor, Outdoor, IQ Outdoor)
* Nest Hello (Wired Gen 1)

The accessory supports connection to Nest using a Nest account OR a Google (migrated Nest account) account.

## Configuration

### Obtaining a Session Token for a Nest Account

If you have a Nest account, you will need to obtain an access token from the Nest web app. Simply go to https://home.nest.com in your browser and log in. Once that's done, go to https://home.nest.com/session in your browser, and you will see a long string that looks like this:

{"2fa_state":"enrolled","access_token":"XXX", ...}

Simply set "SessionToken" in your Nest_config.json file to the value of "access_token" near the start of the string (the XXX), which will be a long sequence of letters, numbers and punctuation beginning with b. There may be other keys labelled access_token further along in the string - please ignore these.

**Do not log out of home.nest.com, as this will invalidate your credentials. Just close the browser tab**

### Obtaining a Google cookie token for a Google Account

Google Accounts are configured using the "GoogleToken" object in Nest_config.json, which contains two fields, "issuetoken" and "cookie", which looks like this:

```
      "GoogleToken": {
        "issuetoken": "https://accounts.google.com/o/oauth2/iframerpc?action=issueToken...",
        "cookie": "..."
      },
```
      
The values of "issueToken" and "cookies" are specific to your Google Account. To get them, follow these steps (only needs to be done once, as long as you stay logged into your Google Account).

1. Open a Chrome browser tab in Incognito Mode (or clear your cache).
2. Open Developer Tools (View/Developer/Developer Tools).
3. Click on 'Network' tab. Make sure 'Preserve Log' is checked.
4. In the 'Filter' box, enter issueToken
5. Go to home.nest.com, and click 'Sign in with Google'. Log into your account.
6. One network call (beginning with iframerpc) will appear in the Dev Tools window. Click on it.
7. In the Headers tab, under General, copy the entire Request URL (beginning with https://accounts.google.com). This is your "issuetoken" in config.json.
9. In the 'Filter' box, enter oauth2/iframe
10. Several network calls will appear in the Dev Tools window. Click on the last iframe call.
11. In the Headers tab, under Request Headers, copy the entire cookie (include the whole string which is several lines long and has many field/value pairs - do not include the cookie: name). This is your "cookie" in Nest_config.json.

**Do not log out of home.nest.com, as this will invalidate your credentials. Just close the browser tab**

#### Sample Nest_config.json

Nest_config.json is the configuration file where various options can be. An example of a basic configuration is below

```
{
    "SessionToken" : "<nest session token>",
    "HKSV" : true,
    "H264Encoder" : "copy"
}
```

or

```
{
    "GoogleToken" : {
        "issuetoken" : "<google issue token url>",
        "cookie" : "<google cookie>"
    },
    "HKSV" : true,
    "H264Encoder" : "copy"
}
```

An advanced configuration example is below

```
{
    "SessionToken" : "<nest session token>",
    "HKSV" : false,
    "SERIAL1" : {
        "Exclude" : true
    },
    "SERIAL2" : {
        "HKSV" : true,
        "H264EncoderLive" : "libx264",
        "H264EncoderRecord" : "libx264",
        "MotionCoolDown" : 2
    },
}
```

### Configuration Options

The options available are within the configuration file are listed below. Some of these options can also be on specific devices only

| Option                     | Values                  | Description                                                                               | Global/Local |
|----------------------------|-------------------------|-------------------------------------------------------------------------------------------|--------------|
| GoogleToken                |                         | Google cookie token object {"issuetoken": "xxx", "cookie": "xxx" }                        | global       |
| SessionToken               |                         | Nest session token. Obtain from home.nest.com/session                                     | global       |
| FieldTest                  | true, false             | Enables the use of FieldTest accounts                                                     | global       |             
| EveApp                     | true, false             | Integration with Evehome App. Default is true                                             | global/local |
| HomeKitCode                |                         | HomeKit pairing code in format of "xxx-xx-xxx". Default is 031-45-154                     | global/local |
| Weather                    | true, false             | Creates a "virtual" weather station using Nest weather data. Default is off               | global       |
| Debug                      | true, false             | Turns debugging on or off. Default is off                                                 | global       |
| mDNS                       | avahi, bonjour, ciao    | mDNS advertiser library to use. Default is bonjour                                        | global       |
| HKSV                       | true, false             | Turns HomeKit Secure Video on or off for doorbells and/cameras. Default is off.           | global/local |
| HKSVPreBuffer              | seconds or milliseconds | Amount of time the pre-buffer for HomeKit Secure Video holds data. Default is 15 seconds  | global/local |
| H264Encoder                | copy, libx264, h264_omx | H264 encoder ffmpeg used for both live video and HKSV recording                           | global/local |
| H264EncoderLive            | copy, libx264, h264_omx | H264 encoder ffmpeg used for live video. Default is copy                                  | global/local |
| H264EncoderRecord          | copy, libx264, h264_omx | H264 encoder ffmpeg used for HKSV recording. Default is libx264                           | global/local |
| MotionCooldown             | seconds or milliseconds | Ignore motion detection for this time once triggered. Default is 1 minute                 | global/local |
| PersonCooldown             | seconds or milliseconds | Ignore person detection for this time once triggered (Non HKSV only) Default is 2 minutes | global/local |
| DoorbellCooldown           | seconds or milliseconds | Ignore doorbell button pressed for this time once triggered Default is 1 minute           | global/local |
| Exclude                    | true, false             | Exclude a device or all devices by default if used as a globl option                      | global/local |
| Option.indoor_chime_switch | true, false             | Exposes a switch in HomeKIt to disable/enable indoor chime on Nest Hello. Default is false| local        |

## HomeKit Pairing
Once configured and running, any non-excluded devices can be paired in HomeKit using the default pairing code of **031-45-154**  This can be overidden via the configuration file as above

## Docker Image

If you would like to try this in a containerised version, please check out the [docker hub repository](https://hub.docker.com/r/n0rt0nthec4t/nest_accfactory) for this project

## Caveats

Nest_accfactory is a hobby project of mine, provided as-is, with no warranty whatsoever. I've been running it successfully at my home, but your mileage might vary.

## Changelog

| Version          | Changes                                                                                                                                      |
|------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| v0.1.5           | Support for Nest devices using protobuf protocols                                                                                            |
|                  | Added option to specifiy the HomeKit pairing code                                                                                            |
| v0.1.4           | Code updates and fixes                                                                                                                       |
| v0.1.3           | Code updates and fixes                                                                                                                       |
|                  | Added option to use Nest/Google field test accounts                                                                                          |
|                  | Removed package dependancy around using ffmpeg-for-homebridge. You'll need to provide your own ffmpeg binary or manually install             |
|                  | ffmpeg-for-homebridge v0.1.0 (v0.2.0 removes required libraries, specfically libspeex                                                        |
|                  | Docker hosted version includes required ffmpeg binary at ffmpeg 6.1                                                                          |
| v0.1.2           | Code updates and fixes                                                                                                                       |
|                  | Added option to enable HomeKit switch to silence Nest Hello indoor chiming                                                                   |
| v0.1.1           | Minor code fixes.                                                                                                                            |
| v0.1.0           | Removes Google refresh token method as nolonger supported. Switches to Google cookie method                                                  |
| v0.0.9           | Major code rewrite for Nest accessories                                                                                                      |
|                  | Live streaming for cameras hardcoded to use "copy" for H264 encoder                                                                          |
|                  | Fixes to maintain connection for HKSV streaming from Nest                                                                                    |
|                  | Known issue: Audio sync for HKSV recording maybe out due to Nest's use of adaptive framerates. Investigating work around                     |
| v0.0.8           | H264Encoder config option changes. Will use H264EncoderLive and H264EncoderRecord                                                            |
| v0.0.7           | Minor code fixes                                                                                                                             |
| v0.0.6           | H264Encoder option can also be specified for a specific doorbell/camera.                                                                     |
| v0.0.5           | New option to enabled/disable integration with Eve App in configuration                                                                      |
|                  | Timestamps in debugging logs                                                                                                                 |
|                  | Minor code fixes                                                                                                                             |
| v0.0.4           | Minor code fixes                                                                                                                             |
| v0.0.3           | Improvements to maintaining network connection for HKSV buffering                                                                            |
|                  | New option to have a "virtual" weather station using Nest weather data. Enabled in configuration                                             |
| v0.0.1           | Initial release to this repository                                                                                                           |

