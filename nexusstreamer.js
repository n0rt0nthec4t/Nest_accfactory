// nexusstreamer device class
//
// Buffers a single audio/vidoe stream from Nests "nexus" systems. 
// Allows multiple HomeKit devices to connect to the single stream
//
// Mark Hulskamp
// 22/4/2024

"use strict";

// Define external lbrary requirements
var protoBuf = require("pbf");  // Proto buffer

// Define nodejs module requirements
var util = require("util");
var fs = require("fs");
var tls = require("tls");
var EventEmitter = require("events");
var child_process = require("child_process");

// Define constants
const DEFAULTBUFFERTIME = 15000;                                // Default time in milliseconds to hold in buffer
const PINGINTERVAL = 15000;                                     // 15 seconds between each ping to nexus server while stream active
const TIMERINTERVAL = 1000;                                     // 1 second
const CAMERAOFFLINEH264FILE = "Nest_camera_offline.h264";       // Camera offline H264 frame file
const CAMERAOFFH264FILE = "Nest_camera_off.h264";               // Camera off H264 frame file
const CAMERACONNECTING264FILE = "Nest_camera_connecting.h264";  // Camera connecting H264 frame file

const CodecType = {
    SPEEX : 0,
    PCM_S16_LE : 1,
    H264 : 2,
    AAC : 3,
    OPUS : 4,
    META : 5,
    DIRECTORS_CUT : 6,
};

const StreamProfile = {
    AVPROFILE_MOBILE_1 : 1,
    AVPROFILE_HD_MAIN_1 : 2,
    AUDIO_AAC : 3,
    AUDIO_SPEEX : 4,
    AUDIO_OPUS : 5,
    VIDEO_H264_50KBIT_L12 : 6,
    VIDEO_H264_530KBIT_L31 : 7,
    VIDEO_H264_100KBIT_L30 : 8,
    VIDEO_H264_2MBIT_L40 : 9,
    VIDEO_H264_50KBIT_L12_THUMBNAIL : 10,
    META : 11,
    DIRECTORS_CUT : 12,
    AUDIO_OPUS_LIVE : 13,
    VIDEO_H264_L31 : 14,
    VIDEO_H264_L40 : 15
};

const ErrorCode = {
    ERROR_CAMERA_NOT_CONNECTED : 1,
    ERROR_ILLEGAL_PACKET : 2,
    ERROR_AUTHORIZATION_FAILED : 3,
    ERROR_NO_TRANSCODER_AVAILABLE : 4,
    ERROR_TRANSCODE_PROXY_ERROR : 5,
    ERROR_INTERNAL : 6,
};

const Reason = {
    ERROR_TIME_NOT_AVAILABLE : 1,
    ERROR_PROFILE_NOT_AVAILABLE : 2,
    ERROR_TRANSCODE_NOT_AVAILABLE : 3,
    ERROR_UKNOWN1 : 4,  // Redirect???
    PLAY_END_SESSION_COMPLETE : 128,
};

const PacketType = {
    PING : 1,
    HELLO : 100,
    PING_CAMERA : 101,
    AUDIO_PAYLOAD : 102,
    START_PLAYBACK : 103,
    STOP_PLAYBACK : 104,
    CLOCK_SYNC_ECHO : 105,
    LATENCY_MEASURE : 106,
    TALKBACK_LATENCY : 107,
    METADATA_REQUEST : 108,
    OK : 200,
    ERROR : 201,
    PLAYBACK_BEGIN : 202,
    PLAYBACK_END : 203,
    PLAYBACK_PACKET : 204,
    LONG_PLAYBACK_PACKET : 205,
    CLOCK_SYNC : 206,
    REDIRECT : 207,
    TALKBACK_BEGIN : 208,
    TALKBACK_END : 209,
    METADATA : 210,
    METADATA_ERROR : 211,
    AUTHORIZE_REQUEST : 212,
};

const ProtocolVersion = {
    VERSION_1 : 1,
    VERSION_2 : 2,
    VERSION_3 : 3
};

const ClientType = {
    ANDROID : 1,
    IOS : 2,
    WEB : 3
};

const H264NALUnitType = {
    STAP_A : 0x18,
    FU_A : 0x1c,
    NON_IDR : 0x01,
    IDR : 0x05,
    SEI : 0x06,
    SPS : 0x07,
    PPS : 0x08,
    AUD : 0x09
};

const H264NALStartcode = Buffer.from([0x00, 0x00, 0x00, 0x01]);

// Blank audio in AAC format, mono channel @48000
const AACMONO48000BLANK = Buffer.from([
    0xFF, 0xF1, 0x4C, 0x40, 0x03, 0x9F, 0xFC, 0xDE, 0x02, 0x00, 0x4C, 0x61,
	0x76, 0x63, 0x35, 0x39, 0x2E, 0x31, 0x38, 0x2E, 0x31, 0x30, 0x30, 0x00,
	0x02, 0x30, 0x40, 0x0E, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01,
	0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18,
	0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20,
	0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07,
	0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF,
	0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1,
	0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C,
	0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40,
	0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01,
	0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F,
	0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC,
	0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01,
	0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18,
	0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20,
	0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07,
	0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF,
	0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1,
	0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C,
	0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40,
	0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01,
	0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F,
	0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC,
	0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01,
	0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18,
	0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20,
	0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07,
	0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF,
	0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1,
	0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C,
	0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40,
	0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01,
	0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F,
	0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC,
	0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01,
	0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18,
	0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20,
	0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07,
	0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF,
	0xF1, 0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1,
	0x4C, 0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C,
	0x40, 0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40,
	0x01, 0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01,
	0x7F, 0xFC, 0x01, 0x18, 0x20, 0x07, 0xFF, 0xF1, 0x4C, 0x40, 0x01, 0x7F,
	0xFC, 0x01, 0x18, 0x20, 0x07
]);


// NeuxsStreamer object
class NexusStreamer {
	constructor(HomeKitAccessoryUUID, cameraToken, tokenType, deviceData, enableDebugging) {
        this.camera = deviceData; // Current camera data

        this.buffer = {active: false, size: 0, image: [], buffer: [], streams: []};    // Buffer and stream details

        this.tcpSocket = null;
        this.host = null;   // No intial host to connect to
        this.pendingHost = null;
        this.nexusvideo = {channel_id: -1, start_time: 0, sample_rate: 0, packet_time: 0};
        this.nexusaudio = {channel_id: -1, start_time: 0, sample_rate: 0, packet_time: 0};
        this.pendingMessages = [];
        this.pendingBuffer = null;
        this.authorised = false;
        this.weDidClose = true; // Flag if we did teh socket close gracefully

        this.timer = null;  // Internal timer handle
        this.pingtimer = null;  // Ping timer handle
        this.sessionID = null;  // no session ID yet.. We'll assign a random one when we connect to the nexus stream
        this.HomeKitAccessoryUUID = HomeKitAccessoryUUID;   // HomeKit accessory UUID

        // Get access token and set token type
        this.cameraToken = cameraToken;
        this.tokenType = tokenType;

        this.playingBack = false;   // If we're playing back nexus data
        this.talking = false;   // If "talk" is happening

        this.enableDebugging = typeof enableDebugging == "boolean" ? enableDebugging : false; // debug status

        // buffer for camera offline image in .h264 frame
        this.camera_offline_h264_frame = null;
        if (fs.existsSync(__dirname + "/" + CAMERAOFFLINEH264FILE) == true) {
            this.camera_offline_h264_frame = fs.readFileSync(__dirname + "/" + CAMERAOFFLINEH264FILE);
            // remove any H264 NALU from beginning of any video data. We do this as they are added later when output by our ffmpeg router
            if (this.camera_offline_h264_frame.indexOf(H264NALStartcode) == 0) {
                this.camera_offline_h264_frame = this.camera_offline_h264_frame.slice(H264NALStartcode.length);
            }
        }

        // buffer for camera stream off image in .h264 frame
        this.camera_off_h264_frame = null;
        if (fs.existsSync(__dirname + "/" + CAMERAOFFH264FILE) == true) {
            this.camera_off_h264_frame = fs.readFileSync(__dirname + "/" + CAMERAOFFH264FILE);
            // remove any H264 NALU from beginning of any video data. We do this as they are added later when output by our ffmpeg router
            if (this.camera_off_h264_frame.indexOf(H264NALStartcode) == 0) {
                this.camera_off_h264_frame = this.camera_off_h264_frame.slice(H264NALStartcode.length);
            }
        }

        // buffer for camera stream connecting image in .h264 frame
        this.camera_connecting_h264_frame = null;
        if (fs.existsSync(__dirname + "/" + CAMERACONNECTING264FILE) == true) {
            this.camera_connecting_h264_frame  = fs.readFileSync(__dirname + "/" + CAMERACONNECTING264FILE);
            // remove any H264 NALU from beginning of any video data. We do this as they are added later when output by our ffmpeg router
            if (this.camera_connecting_h264_frame.indexOf(H264NALStartcode) == 0) {
                this.camera_connecting_h264_frame = this.camera_connecting_h264_frame.slice(H264NALStartcode.length);
            }
        }
    }


    // Class functions
    startBuffering(bufferingTimeMilliseconds) {
        // We only support one buffering stream per Nexus object ie: per camera
        if (typeof bufferingTimeMilliseconds == "undefined") {
            bufferingTimeMilliseconds = DEFAULTBUFFERTIME;    // Wasnt specified how much streaming time we hold in our buffer, so default to 15 seconds
        }
        this.buffer.maxTime = bufferingTimeMilliseconds;
        this.buffer.active = (bufferingTimeMilliseconds > 0 ? true : false); // Start the buffer if buffering size > 0
        this.buffer.buffer = [];   // empty buffer
        if (this.tcpSocket == null) {
            this.#connect(this.camera.direct_nexustalk_host);
        }
        this.#outputLogging("nexus", true, "Started buffering from '%s' with size of '%s'", (this.host == null ? this.camera.direct_nexustalk_host : this.host), bufferingTimeMilliseconds);
    }

    startLiveStream(sessionID, videoStream, audioStream, alignToSPSFrame) {
        // Setup error catching for video/audio streams
        videoStream && videoStream.on("error", (error) => {
            // EPIPE errors??
        });
        audioStream && audioStream.on("error", (error) => {
            // EPIPE errors??
        });

        if (this.buffer.active == false && this.tcpSocket == null) {
            // We are not doing any buffering and there isn't an active socket connection, so startup connection to nexus
            this.#connect(this.camera.direct_nexustalk_host);
        }
        
        // Add video/audio streams for our ffmpeg router to handle outputting to
        this.buffer.streams.push({type: "live", id: sessionID, video: videoStream, audio: audioStream, aligned: (typeof alignToSPSFrame == "undefined" || alignToSPSFrame == true ? false : true)});

        // finally, we've started live stream
        this.#outputLogging("nexus", true, "Started live stream from '%s'", (this.host == null ? this.camera.direct_nexustalk_host : this.host));
    }

    startRecordStream(sessionID, ffmpegRecord, videoStream, audioStream, alignToSPSFrame, fromTime) {
        // Setup error catching for video/audio streams
        videoStream && videoStream.on("error", (error) => {
            // EPIPE errors??
        });
        audioStream && audioStream.on("error", (error) => {
            // EPIPE errors??
        });

        if (this.buffer.active == false && this.tcpSocket == null) {
            // We not doing any buffering and/or there isn't an active socket connection, so startup connection to nexus
            this.#connect(this.camera.direct_nexustalk_host);
        }

        // Output from the requested time position in the buffer until one index before the end of buffer
        if (this.buffer.active == true) {
            var sentElements = 0;
            var doneAlign = (typeof alignToSPSFrame == "undefined" || alignToSPSFrame == true ? false : true);
            for (var bufferIndex = 0; bufferIndex < this.buffer.buffer.length; bufferIndex++) {
                if (fromTime == 0 || (fromTime != 0 && this.buffer.buffer[bufferIndex].synctime >= fromTime)) {
                    if (doneAlign == false && this.buffer.buffer[bufferIndex].type == "video" && (this.buffer.buffer[bufferIndex].data && this.buffer.buffer[bufferIndex].data[0] & 0x1f) == H264NALUnitType.SPS) {
                        doneAlign = true;
                    }
                    if (doneAlign == true) {
                        // This is a recording streaming stream, and we have been initally aligned to a h264 SPS frame, so send on data now
                        if (this.buffer.buffer[bufferIndex].type == "video" && videoStream != null) {
                            // H264 NAL Units "0001" are required to be added to beginning of any video data we output
                            videoStream.write(Buffer.concat([H264NALStartcode, this.buffer.buffer[bufferIndex].data]));
                        }
                        if (this.buffer.buffer[bufferIndex].type == "audio" && audioStream != null) { 
                            audioStream.write(this.buffer.buffer[bufferIndex].data);
                        }
                        sentElements++; // Increment the number of elements we output from the buffer
                    }
                }
            }
            this.#outputLogging("nexus", true, "Recording stream '%s' requested buffered data first. Sent '%s' buffered elements", sessionID, sentElements);
        }
    
        // Add video/audio streams for our ffmpeg router to handle outputting to
        this.buffer.streams.push({type: "record", id: sessionID, record: ffmpegRecord, video: videoStream, audio: audioStream, aligned: doneAlign});

        // Finally we've started the recording stream
        this.#outputLogging("nexus", true, "Started recording stream from '%s'", (this.host == null ? this.camera.direct_nexustalk_host : this.host));
    }

    startTalkStream(sessionID, talkbackStream) {
        // Setup talkback audio stream if configured
        if (talkbackStream == null) {
            return;
        }

        var index = this.buffer.streams.findIndex(({ id }) => id == sessionID);
        if (index != -1) {
            this.buffer.streams[index].audioTimeout = null;  // NO timeout

            talkbackStream.on("error", (error) => {
                // EPIPE errors??
            });

            talkbackStream.on("data", (data) => {
                // Received audio data to send onto nexus for output to doorbell/camera
                this.#AudioPayload(data);

                clearTimeout(this.buffer.streams[index].audioTimeout);   // Clear return audio timeout
                this.buffer.streams[index].audioTimeout = setTimeout(() => {
                    // no audio received in 500ms, so mark end of stream
                    this.#AudioPayload(Buffer.from([]));
                }, 500);
            });
        }
    }

    stopTalkStream(sessionID) {
        var index = this.buffer.streams.findIndex(({ type, id }) => id == sessionID);
        if (index != -1) {
            this.buffer.streams[index].audioTimeout && clearTimeout(this.buffer.streams[index].audioTimeout); // Clear any active return audio timer
        }
    }

    stopRecordStream(sessionID) {
        // Request to stop a recording stream
        var index = this.buffer.streams.findIndex(({ type, id }) => type == "record" && id == sessionID);
        if (index != -1) {
            this.#outputLogging("nexus", true, "Stopped recording stream from '%s'", (this.host == null ? this.camera.direct_nexustalk_host : this.host));
            this.buffer.streams.splice(index, 1);   // remove this object
        }

        // If we have no more streams active, we'll close the socket to nexus
        if (this.buffer.streams.length == 0 && this.buffer.active == false) {
            clearInterval(this.timer);
            this.#close(true);
        }
    }

    stopLiveStream(sessionID) {
        // Request to stop an active live stream
        var index = this.buffer.streams.findIndex(({ type, id }) => type == "live" && id == sessionID);
        if (index != -1) {
            this.#outputLogging("nexus", true, "Stopped live stream from '%s'", (this.host == null ? this.camera.direct_nexustalk_host : this.host));
            this.buffer.streams[index].audioTimeout && clearTimeout(this.buffer.streams[index].audioTimeout); // Clear any active return audio timer
            this.buffer.streams.splice(index, 1);   // remove this object
        }

        // If we have no more streams active, we'll close the socket to nexus
        if (this.buffer.streams.length == 0 && this.buffer.active == false) {
            clearInterval(this.timer);
            this.#close(true);
        }
    }

    stopBuffering() {
        if (this.buffer.active == true) {
            // we have a buffer session, so close it down
            this.#outputLogging("nexus", true, "Stopped buffering from '%s'", (this.host == null ? this.camera.direct_nexustalk_host : this.host));
            this.buffer.buffer = null;  // Clean up first
            this.buffer.active = false;    // No buffer running now
        }

        // If we have no more streams active, we'll close the socket to nexus
        if (this.buffer.streams.length == 0) {
            clearInterval(this.timer);
            this.#close(true); 
        }
    }

    update(cameraToken, tokenType, updatedDeviceData) {
        if (typeof updatedDeviceData != "object") {
            return;
        }
    
        if (cameraToken != this.cameraToken || tokenType != this.tokenType) {
            // access token has changed and/or token type has changed, so re-authorise
            this.tokenType = tokenType; // Update token type
            this.cameraToken = cameraToken; // Update token

            if (this.tcpSocket != null) {
                this.#Authenticate(true);    // Update authorisation only if connected
            }
        }

        if ((this.camera.online != updatedDeviceData.online) || (this.camera.streaming_enabled != updatedDeviceData.streaming_enabled)) {
            // Online status or streaming status has changed has changed
            this.camera.online = updatedDeviceData.online;
            this.camera.streaming_enabled = updatedDeviceData.streaming_enabled;
            this.camera.direct_nexustalk_host = updatedDeviceData.direct_nexustalk_host
            if (this.camera.online == false || this.camera.streaming_enabled == false) {
                this.#close(true); // as offline or streaming not enabled, close socket
            }
            if ((this.camera.online == true && this.camera.streaming_enabled == true) && (this.tcpSocket == null && (this.buffer.active == true || this.buffer.streams.length > 0))) {
                this.#connect(this.camera.direct_nexustalk_host);   // Connect to Nexus for stream
            }
        }

        if (this.camera.direct_nexustalk_host != updatedDeviceData.direct_nexustalk_host) {
            this.#outputLogging("nexus", true, "Updated Nexusstreamer host '%s'", updatedDeviceData.direct_nexustalk_host);
            this.pendingHost = updatedDeviceData.direct_nexustalk_host;
        }

        this.camera = updatedDeviceData;   // Update our internally stored copy of the camera details
    }

    #connect(host) {
        clearInterval(this.pingtimer);  // Clear ping timer if was running
        this.sessionID = null;  // No session ID yet

        if (this.camera.streaming_enabled == true && this.camera.online == true) {
            if (typeof host == "undefined" || host == null) {
                // No host parameter passed in, so we'll set this to our internally stored host 
                host = this.host;
            }

            if (this.pendingHost != null) {
                host = this.pendingHost;
                this.pendingHost = null;
            }

            this.#outputLogging("nexus", true, "Starting connection to '%s'", host);

            this.tcpSocket = tls.connect({host: host, port: 1443}, () => {
                // Opened connection to Nexus server, so now need to authenticate ourselves
                this.host = host;   // update internal host name since we've connected
                this.#outputLogging("nexus", true, "Connection established to '%s'", host);
                this.tcpSocket.setKeepAlive(true); // Keep socket connection alive
                this.#Authenticate(false);

                this.pingtimer = setInterval(() => {
                    // Periodically send PING message to keep stream alive
                    // Doesnt seem to work???
                    this.#sendMessage(PacketType.PING, Buffer.alloc(0));
                }, PINGINTERVAL);
            });

            this.tcpSocket.on("error", (error) => {
                // Catch any socket errors to avoid code quitting
                // Our "close" handler will try reconnecting if needed
                //this.#outputLogging("nexus", true, "Stocket error", error);
            });

            this.tcpSocket.on("end", () => {
                //this.#outputLogging("nexus", true, "Stocket ended", this.playingBack);
            });

            this.tcpSocket.on("data", (data) => {
                this.#handleNexusData(data);
            });

            this.tcpSocket.on("close", (hadError) => {
                var normalClose = this.weDidClose;  // Cache this, so can reset it below before we take action

                clearInterval(this.pingtimer);    // Clear ping timer
                this.playingBack = false;   // Playback ended as socket is closed
                this.authorised = false;    // Since connection close, we can't be authorised anymore
                this.tcpSocket = null; // Clear socket object 
                this.sessionID = null;  // Not an active session anymore
                this.weDidClose = false;    // Reset closed flag

                this.#outputLogging("nexus", true, "Connection closed to '%s'", host);

                if (normalClose == false && (this.buffer.active == true || this.buffer.streams.length > 0)) {
                    // We still have either active buffering occuring or output streams running
                    // so attempt to restart connection to existing host
                    this.#connect(host);
                }
            });
        }
        
        // Setup timer for when camera video is off or camera is offline, so loop our appropriate messages to the video stream
        clearInterval(this.timer);
        this.timer = setInterval(() => {
            if (this.camera_offline_h264_frame && this.camera.online == false) {
                // Camera is offline, so feed in our custom h264 frame for playback
                this.#ffmpegRouter("video", this.camera_offline_h264_frame);
                this.#ffmpegRouter("audio", AACMONO48000BLANK);
            }
            if (this.camera_off_h264_frame && this.camera.streaming_enabled == false && this.camera.online == true) {
                // Camera video is turned off so feed in our custom h264 frame for playback
                this.#ffmpegRouter("video", this.camera_off_h264_frame);
                this.#ffmpegRouter("audio", AACMONO48000BLANK);
            }
            if (this.camera_connecting_h264_frame && this.playingBack == false && this.camera.streaming_enabled == true && this.camera.online == true) {
                // Connecting to camera video so feed in our custom h264 frame for playback
                // Not sure worth enabling, but its here!
                //this.#ffmpegRouter("video", this.camera_connecting_h264_frame);
                //this.#ffmpegRouter("audio", AACMONO48000BLANK);
            }
            if (this.camera_offline_h264_frame && this.tcpSocket == null) {
                // Seems we cant access the video stream as we have an empty connection, so feed in our custom h264 frame for playback
                // We'll use the camera off h264 frame
                //this.#ffmpegRouter("video", this.camera_offline_h264_frame);
                //this.#ffmpegRouter("audio", AACMONO48000BLANK);
            }
        }, (TIMERINTERVAL / 30));   // output at 30 fps?
    }

    #close(sendStop) {
        // Close an authenicated socket stream gracefully
        if (this.tcpSocket != null) {
            if (sendStop == true) {
                // Send a notifcation to nexus we're finished playback
                this.#stopNexusData();
            }
            this.tcpSocket.destroy();
        }
        this.tcpSocket = null;
        this.sessionID = null;  // Not an active session anymore
        this.pendingMessages = []; // No more pending messages
        this.weDidClose = true; // Flag we did the socket close
    }

    #startNexusData() {
        if (this.camera.streaming_enabled == false || this.camera.online == false) {
            return;
        }

        // Attempt to use camera's streaming profile or use default
        var otherProfiles = [];
        this.camera.capabilities.forEach((element) => {
            if (element.startsWith("streaming.cameraprofile")) {
                var profile = element.replace("streaming.cameraprofile.", "");
                if (otherProfiles.indexOf(profile, 0) == -1 && StreamProfile.VIDEO_H264_2MBIT_L40 != StreamProfile[profile]) {
                    // Profile isn't the primary profile, and isn't in the others list, so add it
                    otherProfiles.push(StreamProfile[profile]);
                }
            }
        });

        if (this.camera.audio_enabled == true) {
            otherProfiles.push(StreamProfile.AUDIO_AAC); // Include AAC profile if audio is enabled on camera
        }

        var startBuffer = new protoBuf();
        startBuffer.writeVarintField(1, Math.floor(Math.random() * (100 - 1) + 1)); // Random session ID between 1 and 100);   // Session ID
        startBuffer.writeVarintField(2, StreamProfile.VIDEO_H264_2MBIT_L40);    // Default profile. ie: high quality
        otherProfiles.forEach((otherProfile) => {
            startBuffer.writeVarintField(6, otherProfile);  // Other supported profiles
        });

        this.#sendMessage(PacketType.START_PLAYBACK, startBuffer.finish());
    }

    #stopNexusData() {
        var stopBuffer = new protoBuf();
        stopBuffer.writeVarintField(1, this.sessionID);   // Session ID
        this.#sendMessage(PacketType.STOP_PLAYBACK, stopBuffer.finish());
    }

    #ffmpegRouter(type, data, time) {
        // Send out our nexus data to any streams we're managing, including performing any buffering as required
        if (typeof time == "undefined") time = Date.now();  // If we haven't passed in a timestamp, use the current time in milliseconds

        // Add the data to the buffer if its active first up
        if (this.buffer.active == true) {
            // Ensure we only have the specified milliseconds of data buffered also
            while (this.buffer.buffer.length > 0 && this.buffer.buffer[0].time < (Date.now() - this.buffer.maxTime)) {
                this.buffer.buffer.shift();    // Remove the element from the tail of the buffer
            }
            this.buffer.buffer.push({time: Date.now(), synctime: time, type: type, data: data});
        }

        // Output the current data to any streams running, either a "live" or "recording" stream
        for (var streamsIndex = 0; streamsIndex < this.buffer.streams.length; streamsIndex++) {
            // Now output the current data to the stream, either a "live" or "recording" stream
            if (this.buffer.streams[streamsIndex].aligned == false && type == "video" && (data && data[0] & 0x1f) == H264NALUnitType.SPS) this.buffer.streams[streamsIndex].aligned = true;
            if (this.buffer.streams[streamsIndex].aligned == true) {
                // We have been initally aligned to a h264 SPS frame, so send on data now
                if (type == "video" && this.buffer.streams[streamsIndex].video != null) {
                    // H264 NAL Units "0001" are required to be added to beginning of any video data we output
                    this.buffer.streams[streamsIndex].video.write(Buffer.concat([H264NALStartcode, data]));
                }
                if (type == "audio" && this.buffer.streams[streamsIndex].audio != null) { 
                    this.buffer.streams[streamsIndex].audio.write(data);
                }
            }
        }
    }

    #processMessages() {
        // Send any pending messages that might have accumulated while socket pending etc
        if (typeof this.pendingMessages != "object" || this.pendingMessages.length == 0) {
            return;
        }

        for (let pendingMessage = this.pendingMessages.shift(); pendingMessage; pendingMessage = this.pendingMessages.shift()) {
            this.#sendMessage(pendingMessage.messageType, pendingMessage.messageData);
        }
    }

    #sendMessage(messageType, messageData) {
        if (this.tcpSocket == null || this.tcpSocket.readyState != "open" || (messageType !== PacketType.HELLO && this.authorised == false)) { 
            this.pendingMessages.push({messageType, messageData});
            return;
        }

        if (messageType !== PacketType.LONG_PLAYBACK_PACKET) {
            var messageHeader = Buffer.alloc(3);
            messageHeader[0] = messageType;
            messageHeader.writeUInt16BE(messageData.length, 1);
        }
        if (messageType === PacketType.LONG_PLAYBACK_PACKET) {
            var messageHeader = Buffer.alloc(5);
            messageHeader[0] = messageType;
            messageHeader.writeUInt32BE(messageData.length, 1);
        }

        // write our composed message to the socket
        this.tcpSocket.write(Buffer.concat([messageHeader, Buffer.from(messageData)]), () => {
            // Message sent. Dont do anything?
        });
    }

    #Authenticate(reauthorise) {
        // Authenticate over created socket connection
        var tokenBuffer = new protoBuf();
        var helloBuffer = new protoBuf();

        this.authorised = false;    // We're nolonger authorised

        if (this.tokenType == "nest") {
            tokenBuffer.writeStringField(1, this.cameraToken);   // Tag 1, session token, Nest auth accounts
            helloBuffer.writeStringField(4, this.cameraToken);   // Tag 4, session token, Nest auth accounts
        }
        if (this.tokenType == "google") {
            tokenBuffer.writeStringField(4, this.cameraToken);   // Tag 4, olive token, Google auth accounts
            helloBuffer.writeBytesField(12, tokenBuffer.finish());    // Tag 12, olive token, Google auth accounts
        }
        if (typeof reauthorise == "boolean" && reauthorise == true) {
            // Request to re-authorise only
            this.#outputLogging("nexus", true, "Re-authentication requested to '%s'", this.host);
            this.#sendMessage(PacketType.AUTHORIZE_REQUEST, tokenBuffer.finish());
        } else {
            // This isn't a re-authorise request, so perform "Hello" packet
            this.#outputLogging("nexus", true, "Performing authentication to '%s'", this.host);
            helloBuffer.writeVarintField(1, ProtocolVersion.VERSION_3);
            helloBuffer.writeStringField(2, this.camera.uuid.split(".")[1]); // UUID should be "quartz.xxxxxx". We want the xxxxxx part
            helloBuffer.writeBooleanField(3, false);    // Doesnt required a connected camera
            helloBuffer.writeStringField(6, this.HomeKitAccessoryUUID); // UUID v4 device ID
            helloBuffer.writeStringField(7, "Nest/5.75.0 (iOScom.nestlabs.jasper.release) os=17.4.1");
            helloBuffer.writeVarintField(9, ClientType.IOS);
            //helloBuffer.writeStringField(7, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15");
            //helloBuffer.writeVarintField(9, ClientType.WEB);
            this.#sendMessage(PacketType.HELLO, helloBuffer.finish());
        }
    }

    #AudioPayload(payload) {
        // Encode audio packet for sending to camera
        var audioBuffer = new protoBuf();
        audioBuffer.writeBytesField(1, payload);    // audio data
        audioBuffer.writeVarintField(2, this.sessionID);    // session ID
        audioBuffer.writeVarintField(3, CodecType.SPEEX);   // codec
        audioBuffer.writeVarintField(4, 16000); // sample rate, 16k
        //audioBuffer.writeVarintField(5, ????);  // Latency measure tag. What does this do? 
        this.#sendMessage(PacketType.AUDIO_PAYLOAD, audioBuffer.finish());
    }

    #handleRedirect(payload) {     
        if (typeof payload == "object") {
            // Payload parameter is an object, we'll assume its a payload packet
            // Decode redirect packet to determine new host
            var packet = payload.readFields(function(tag, obj, protoBuf) {
                if (tag === 1) obj.new_host = protoBuf.readString();  // new host
                else if (tag === 2) obj.is_transcode = protoBuf.readBoolean();
            }, {new_host: "", is_transcode: false});

            var redirectToHost = packet.new_host;
        }
        if (typeof payload == "string") {
            // Payload parameter is a string, we'll assume this is a direct hostname
            var redirectToHost = payload;
        }

        if (typeof redirectToHost != "string" || redirectToHost == "") {
            return;
        }

        this.#outputLogging("nexus", true, "Redirect requested from '%s' to '%s'", this.host, redirectToHost);

        // Setup listener for socket close event. Once socket is closed, we'll perform the redirect
        this.tcpSocket && this.tcpSocket.on("close", (hasError) => {
            this.#connect(redirectToHost);   // Connect to new host
        });
        this.#close(true);     // Close existing socket    
    }

    #handlePlaybackBegin(payload) {
        // Decode playback begin packet
        var packet = payload.readFields(function(tag, obj, protoBuf) {
            if (tag === 1) obj.session_id = protoBuf.readVarint();
            else if (tag === 2) obj.channels.push(protoBuf.readFields(function(tag, obj, protoBuf) {
                if (tag === 1) obj.channel_id = protoBuf.readVarint();
                else if (tag === 2) obj.codec_type = protoBuf.readVarint();
                else if (tag === 3) obj.sample_rate = protoBuf.readVarint();
                else if (tag === 4) obj.private_data.push(protoBuf.readBytes());
                else if (tag === 5) obj.start_time = protoBuf.readDouble();
                else if (tag === 6) obj.udp_ssrc = protoBuf.readVarint();
                else if (tag === 7) obj.rtp_start_time = protoBuf.readVarint();
                else if (tag === 8) obj.profile = protoBuf.readVarint();
            }, {channel_id: 0, codec_type: 0, sample_rate: 0, private_data: [], start_time: 0, udp_ssrc: 0, rtp_start_time: 0, profile: 3}, protoBuf.readVarint() + protoBuf.pos));
            else if (tag === 3) obj.srtp_master_key = protoBuf.readBytes();
            else if (tag === 4) obj.srtp_master_salt = protoBuf.readBytes();
            else if (tag === 5) obj.fec_k_val = protoBuf.readVarint();
            else if (tag === 6) obj.fec_n_val = protoBuf.readVarint();
        }, {session_id: 0, channels: [], srtp_master_key: null, srtp_master_salt: null, fec_k_val: 0, fec_n_val: 0});

        packet.channels && packet.channels.forEach((stream) => {
            // Find which channels match our video and audio streams
            if (stream.codec_type == CodecType.H264) {
                this.nexusvideo = {channel_id: stream.channel_id, start_time: (stream.start_time * 1000), sample_rate: stream.sample_rate, packet_time: (stream.start_time * 1000)};
            }
            if (stream.codec_type == CodecType.AAC) {
                this.nexusaudio = {channel_id: stream.channel_id, start_time: (stream.start_time * 1000), sample_rate: stream.sample_rate, packet_time: (stream.start_time * 1000)};
            }
        });

        // Since this is the beginning of playback, clear any active buffers contents
        this.buffer.buffer = [];
        this.playingBack = true;
        this.sessionID = packet.session_id;
        this.#outputLogging("nexus", true, "Playback started from '%s' with session ID '%s'", this.host, this.sessionID);
    }

    #handlePlaybackPacket(payload) {
        // Decode playback packet
        var packet = payload.readFields(function(tag, obj, protoBuf) {
            if (tag === 1) obj.session_id = protoBuf.readVarint();
            else if (tag === 2) obj.channel_id = protoBuf.readVarint();
            else if (tag === 3) obj.timestamp_delta = protoBuf.readSVarint();
            else if (tag === 4) obj.payload = protoBuf.readBytes();
            else if (tag === 5) obj.latency_rtp_sequence = protoBuf.readVarint();
            else if (tag === 6) obj.latency_rtp_ssrc = protoBuf.readVarint();
            else if (tag === 7) obj.directors_cut_regions.push(protoBuf.readFields(function(tag, obj, protoBuf) {
                if (tag === 1) obj.id = protoBuf.readVarint();
                else if (tag === 2) obj.left = protoBuf.readVarint();
                else if (tag === 3) obj.right = protoBuf.readVarint();
                else if (tag === 4) obj.top = protoBuf.readVarint();
                else if (tag === 5) obj.bottom = protoBuf.readVarint();
            }, { id: 0, left: 0, right: 0, top: 0, bottom: 0 }, protoBuf.readVarint() + protoBuf.pos));
        }, {session_id: 0, channel_id: 0, timestamp_delta: 0, payload: null, latency_rtp_sequence: 0, latency_rtp_ssrc: 0, directors_cut_regions: []});

        // Handle video packet
        if (packet.channel_id === this.nexusvideo.channel_id) {
            this.nexusvideo.packet_time = (this.nexusvideo.start_time + (Date.now() - this.nexusvideo.start_time));
            this.#ffmpegRouter("video", Buffer.from(packet.payload), this.nexusvideo.packet_time);
        }

        // Handle audio packet
        if (packet.channel_id === this.nexusaudio.channel_id) {
            this.nexusaudio.packet_time = (this.nexusaudio.start_time + (Date.now() - this.nexusaudio.start_time));
            this.#ffmpegRouter("audio", Buffer.from(packet.payload), this.nexusaudio.packet_time);
        }
    }

    #handlePlaybackEnd(payload) {
        // Decode playpack ended packet
        var packet = payload.readFields(function(tag, obj, protoBuf) {
            if (tag === 1) obj.session_id = protoBuf.readVarint();
            else if (tag === 2) obj.reason = protoBuf.readVarint();
        }, {session_id: 0, reason: 0});

        if (this.playingBack == true && packet.reason == 0) {
            // Normal playback ended ie: when we stopped playback
            this.#outputLogging("nexus", true, "Playback ended on '%s'", this.host);
        }
        
        if (packet.reason != 0) {
            // Error during playback, so we'll attempt to restart by reconnection to host
            this.#outputLogging("nexus", true, "Playback ended on '%s' with error '%s'. Attempting reconnection", this.host, packet.reason);

            // Setup listener for socket close event. Once socket is closed, we'll perform the re-connection
            this.tcpSocket && this.tcpSocket.on("close", (hasError) => {
                this.#connect(this.host);    // try reconnection to existing host
            });
            this.#close(false);     // Close existing socket    
        }

        this.playingBack = false;   // Playback ended
    }

    #handleNexusError(payload) {
        // Decode error packet
        var packet = payload.readFields(function(tag, obj, protoBuf) {
            if (tag === 1) obj.code = protoBuf.readVarint();
            else if (tag === 2) obj.message = protoBuf.readString();
        }, {code: 1, message: ""});
    
        if (packet.code === ErrorCode.ERROR_AUTHORIZATION_FAILED) {
            // NexusStreamer Updating authentication
            this.#Authenticate(true);    // Update authorisation only
        } else {
            // NexusStreamer Error, packet.message contains the message
            this.#outputLogging("nexus", true, "Error", packet.message);
        }
    }

    #handleTalkbackBegin(payload) {
        // Decode talk begin packet
        var packet = payload.readFields(function(tag, obj, protoBuf) {
            if (tag === 1) obj.user_id = protoBuf.readString();
            else if (tag === 2) obj.session_id = protoBuf.readVarint();
            else if (tag === 3) obj.quick_action_id = protoBuf.readVarint();
            else if (tag === 4) obj.device_id = protoBuf.readString();
        }, {user_id: "", session_id: 0, quick_action_id: 0, device_id: ""});

        this.#outputLogging("nexus", true, "Talkback started on '%s'", packet.device_id);
        this.talking = true;    // Talk back has started
    }

    #handleTalkbackEnd(payload) {
        // Decode talk end packet
        var packet = payload.readFields(function(tag, obj, protoBuf) {
            if (tag === 1) obj.user_id = protoBuf.readString();
            else if (tag === 2) obj.session_id = protoBuf.readVarint();
            else if (tag === 3) obj.quick_action_id = protoBuf.readVarint();
            else if (tag === 4) obj.device_id = protoBuf.readString();
        }, {user_id: "", session_id: 0, quick_action_id: 0, device_id: ""});

        this.#outputLogging("nexus", true, "Talkback ended on '%s'", packet.device_id);
        this.talking = false;    // Talk back has stopped
    }

    #handleNexusData(data) {
        // Process the rawdata from our socket connection and convert into nexus packets to take action against
        this.pendingBuffer = (this.pendingBuffer == null ? data : Buffer.concat([this.pendingBuffer, data]));
        if (this.pendingBuffer.length < 3) {
            // Ensure we have a minimun length in the buffer to read header details
            return;
        }

        var packetType = this.pendingBuffer.readUInt8();

        var headerSizeInBytes = 3;
        var dataSizeInBytes = this.pendingBuffer.readUInt16BE(1);

        if (packetType == PacketType.LONG_PLAYBACK_PACKET) {
            headerSizeInBytes = 5;
            dataSizeInBytes = this.pendingBuffer.readUInt32BE(1);
        }

        var protoBufPayloadSize = headerSizeInBytes + dataSizeInBytes;
        if (this.pendingBuffer.length < protoBufPayloadSize) {
            return;
        }

        var protoBufPayload = new protoBuf(this.pendingBuffer.slice(headerSizeInBytes, protoBufPayloadSize));
        if (packetType == PacketType.OK) {
            this.authorised = true; // OK message, means we're connected and authorised to Nexus
            this.#processMessages();    // process any pending messages
            this.#startNexusData();   // start processing data
        }
    
        if (packetType == PacketType.ERROR) {
            this.#handleNexusError(protoBufPayload);
        }
    
        if (packetType == PacketType.PLAYBACK_BEGIN) {
            this.#handlePlaybackBegin(protoBufPayload);
        }

        if (packetType == PacketType.PLAYBACK_END) {
            this.#handlePlaybackEnd(protoBufPayload);
        }

        if (packetType == PacketType.PLAYBACK_PACKET || packetType == PacketType.LONG_PLAYBACK_PACKET) {
            this.#handlePlaybackPacket(protoBufPayload);
        }

        if (packetType == PacketType.REDIRECT) {
            this.#handleRedirect(protoBufPayload);
        }

        if (packetType == PacketType.TALKBACK_BEGIN) {
            this.#handleTalkbackBegin(protoBufPayload);
        }

        if (packetType == PacketType.TALKBACK_END) {
            this.#handleTalkbackEnd(protoBufPayload);
        }

        if (packetType == PacketType.PING) {
        }

        var remainingData = this.pendingBuffer.slice(protoBufPayloadSize);
        this.pendingBuffer = null;
        if (remainingData.length > 0) {
            this.#handleNexusData(remainingData);  // Maybe not do this recursive???
        }
    }

    #outputLogging(accessoryName, useConsoleDebug, ...outputMessage) {
        if (this.enableDebugging == false) {
            return;
        }

        var timeStamp = String(new Date().getFullYear()).padStart(4, "0") + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0") + " " + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + ":" + String(new Date().getSeconds()).padStart(2, "0");
        if (useConsoleDebug == false) {
            console.log(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
        }
        if (useConsoleDebug == true) {
            console.debug(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
        }
    }
}

module.exports = NexusStreamer;