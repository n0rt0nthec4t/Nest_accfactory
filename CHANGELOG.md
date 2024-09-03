# Change Log

All notable changes to `Nest_accfactory` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).


## 0.1.6 (2023-09-03)

- Common code bases between my two projects, homebridge-nest-accfactory and Nest_accfactory
- Configuration file format has change, but for this version, we'll handle the existing one   
- Using coding styles by prettier/eslint

## 0.1.5 (2024-04-19)

- Support for Nest devices using protobuf protocols. Mainly Thermostat(s) and Temperature Sensors
- Added option to specifiy the HomeKit pairing code
- Docker hosted version includes required ffmpeg binary at ffmpeg 7.0
- Docker hosted version no longer runs using root. This may have side effects of permissions issues with mounted persist folder

## 0.1.4 ()

- Code updates and fixes    

## 0.1.3 (2023-12-07)

- Code updates and fixes
- Added option to use Nest/Google field test accounts
- Removed package dependancy around using ffmpeg-for-homebridge. You'll need to provide your own ffmpeg binary or manually install
- ffmpeg-for-homebridge v0.1.0 (v0.2.0 removes required libraries, specfically libspeex)
- Docker hosted version includes required ffmpeg binary at ffmpeg 6.1

## 0.1.2 (2023-07-14)

- Code updates and fixes
- Added option to enable HomeKit switch to silence Nest Hello indoor chiming

## 0.1.1 (2023-04-07)

- Minor code fixes

## 0.1.0 (2022-11-29)

- Removes Google refresh token method as nolonger supported. Switches to Google cookie method

## 0.0.9 (2022-10-02)

- Major code rewrite for Nest accessories
- Live streaming for cameras hardcoded to use "copy" for H264 encoder
- Fixes to maintain connection for HKSV streaming from Nest
- Known issue: Audio sync for HKSV recording maybe out due to Nest's use of adaptive framerates. Investigating work around

## 0.0.8 (2022-08-18)

- H264Encoder config option changes. Will use H264EncoderLive and H264EncoderRecord

## 0.0.7 (2022-07-29)

- Minor code fixes

## 0.0.6 (2022-06-28)

- H264Encoder option can also be specified for a specific doorbell/camera

## 0.0.5 (2022-06-22)

- New option to enabled/disable integration with Eve App in configuration
- Timestamps in debugging logs
- Minor code fixes

## 0.0.4 (2022-06-20)

- Minor code fixes

## 0.0.3 (2022-06-16)

- Improvements to maintaining network connection for HKSV buffering
- New option to have a "virtual" weather station using Nest weather data. Enabled in configuration

## 0.0.1 (2022-06-04)

- Initial release to this repository
