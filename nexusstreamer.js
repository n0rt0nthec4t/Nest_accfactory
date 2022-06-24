// Code taken from https://github.com/Brandawg93/homebridge-nest-cam 
// all credit for this due there
//
// Converted back from typescript and combined into single file
// Cleaned up/recoded
//
// Mark Hulskamp
// 15/6/2022
//
// done
// -- switching camera stream on/off - going from off to on doesn't restart stream from Nest
// -- buffering of stream ie: const streaming from nexus
// -- routing of data to multiple connected ffmpeg processing streams. Allows single connection to nexus for the source stream
// -- restart connection when dropped if buffering
// -- support both Nest and Google accounts
// -- Modification to sending buffer before recording starts. Should result in cleaner ffmpeg process output and more reliable HKSV recordings
// -- further fixes for restarting streams
// -- fixed switching camera off/offline image frames to streams
// -- get snapshot image from buffer if active
// -- fixes in buffering code. Will now correctly output requested buffer to multiple streams
// 
// todo
// -- When camera goes offline, we don't get notified straight away and video stream stops. Perhaps timer to go to camera off image if no data receieve in past 15 seconds?
// -- When first called after starting, get a green screen for about 1 second. Everything is fine after that <- not seen in ages
//    **Think know what this issue is. When outputting a new stream, need to align to H264 SPS frame
// -- audio echo with return audio
// -- speed up live image stream starting when have a buffer active. Should almost start straight away
// -- dynamic audio switching on/off from camera

"use strict";

// Define external lbrary requirements
var protoBuf = require("pbf");  // Proto buffer

// Define nodejs module requirements
var fs = require("fs");
var tls = require("tls");
var net = require("net");
var EventEmitter = require("events");
var {spawn} = require("child_process");

// Define constants
const USERAGENT = "Nest/5.67.0.6 (iOScom.nestlabs.jasper.release) os=15.4";
//const USERAGENT = "iPhone iOS 15.4 Dropcam/5.67.0.6 com.nestlabs.jasper.release Darwin";
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
    AUDIO_AAC : 3,
    AUDIO_SPEEX : 4,
    AUDIO_OPUS : 5,
    AUDIO_OPUS_LIVE : 13,
    VIDEO_H264_50KBIT_L12 : 6,
    VIDEO_H264_530KBIT_L31 : 7,
    VIDEO_H264_100KBIT_L30 : 8,
    VIDEO_H264_2MBIT_L40 : 9,
    VIDEO_H264_50KBIT_L12_THUMBNAIL : 10,
    META : 11,
    DIRECTORS_CUT : 12,
    VIDEO_H264_L31 : 14,
    VIDEO_H264_L40 : 15,
    AVPROFILE_MOBILE_1 : 1,
    AVPROFILE_HD_MAIN_1 : 2,
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

const H264FrameTypes = {
    STAP_A : 24,
    FU_A : 28,
    NON_IDR : 1,
    IDR : 5,
    SEI : 6,
    SPS : 7,
    PPS : 8,
    AUD : 9
};

const H264NALUnit = Buffer.from([0x00, 0x00, 0x00, 0x01]);

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

// General functions
function getTimestamp () {
    const pad = (n,s=2) => (`${new Array(s).fill(0)}${n}`).slice(-s);
    const d = new Date();
    
    return `${pad(d.getFullYear(),4)}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}


// NeuxsStreamer object
class NexusStreamer {
	constructor(nestToken, tokenType, cameraData, debug) {
        this.buffer = {active: false, size: 0, buffer: [], streams: []};    // Buffer and stream details

        this.socket = null;
        this.videoChannelID = -1;
        this.audioChannelID = -1;
        this.pendingMessages = [];
        this.pendingBuffer = null;
        this.authorised = false;
        this.streamQuality = StreamProfile.VIDEO_H264_2MBIT_L40;    // Default streaming quaility

        this.timer = null;  // Internal timer handle
        this.pingtimer = null;  // Ping timer handle
        this.sessionID = null;  // no session ID yet.. We'll assign a random one when we connect to the nexus stream
        this.deviceID = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".replace(/x/g, () => {
            return Math.floor(Math.random() * 16).toString(16).toUpperCase();
        }); // Random UUID v4 device ID. We do this once during creation of the object only

        this.host = cameraData.direct_nexustalk_host;  // Inital host to connect to

        // Get access token and set token type
        this.nestToken = nestToken;
        this.tokenType = tokenType;

        this.camera = cameraData; // Current camera data
        this.playingBack = false;   // If we're playing back nexus data
        this.talking = false;   // If "talk" is happening

        this.debug = typeof debug == "boolean" ? debug : false; // debug status

        // buffer for camera offline image in .h264 frame
        this.camera_offline_h264_frame = null;
        if (fs.existsSync(__dirname + "/" + CAMERAOFFLINEH264FILE)) {
            this.camera_offline_h264_frame = fs.readFileSync(__dirname + "/" + CAMERAOFFLINEH264FILE);
            // remove any H264 NALU from being of any video data. We do this as they are added later when output by our ffmpeg router
            if (this.camera_offline_h264_frame.indexOf(H264NALUnit) == 0) {
                this.camera_offline_h264_frame = this.camera_offline_h264_frame.slice(H264NALUnit.length);
            }
        }

        // buffer for camera stream off image in .h264 frame
        this.camera_off_h264_frame = null;
        if (fs.existsSync(__dirname + "/" + CAMERAOFFH264FILE)) {
            this.camera_off_h264_frame = fs.readFileSync(__dirname + "/" + CAMERAOFFH264FILE);
            // remove any H264 NALU from being of any video data. We do this as they are added later when output by our ffmpeg router
            if (this.camera_off_h264_frame.indexOf(H264NALUnit) == 0) {
                this.camera_off_h264_frame = this.camera_off_h264_frame.slice(H264NALUnit.length);
            }
        }

        // buffer for camera stream connecting image in .h264 frame
        this.camera_connecting_h264_frame = null;
        if (fs.existsSync(__dirname + "/" + CAMERACONNECTING264FILE)) {
            this.camera_connecting_h264_frame  = fs.readFileSync(__dirname + "/" + CAMERACONNECTING264FILE);
            // remove any H264 NALU from being of any video data. We do this as they are added later when output by our ffmpeg router
            if (this.camera_connecting_h264_frame.indexOf(H264NALUnit) == 0) {
                this.camera_connecting_h264_frame = this.camera_connecting_h264_frame.slice(H264NALUnit.length);
            }
        }
    }
}

NexusStreamer.prototype.startBuffering = function(milliseconds) {
    // We only support one buffering stream per Nexus object ie: per camera
    if (typeof milliseconds == "undefined") {
        milliseconds = 15000;    // Wasnt specified how much streaming time we hold in our buffer, so default to 15 seconds
    }
    this.buffer.size = milliseconds;
    this.buffer.active = (milliseconds > 0 ? true : false); // Start the buffer if buffering size > 0
    this.buffer.buffer = [];   // empty buffer
    if (this.socket == null) {
        this.__connect(this.camera.direct_nexustalk_host);
        this.__startNexusData();   // start processing data
    }
    this.debug && console.debug(getTimestamp() + " [NEXUS] Started buffering from '%s' with size of '%s'", this.host, milliseconds);
}

NexusStreamer.prototype.startLiveStream = function(sessionID, videoStream, audioStream, talkbackStream, alignToSPSFrame) {
    // Setup error catching for video/audio streams
    videoStream != null && videoStream.on("error", (error) => {
        // EPIPE errors??
    });
    audioStream != null && audioStream.on("error", (error) => {
        // EPIPE errors??
    });

    if (this.buffer.active == false && this.socket == null) {
        // We not doing any buffering and there isnt an active socket connection, so startup connection to nexus
        this.debug && console.debug(getTimestamp() + " [NEXUS] Starting connection to '%s'", this.camera.direct_nexustalk_host);
        this.__connect(this.camera.direct_nexustalk_host);
        this.__startNexusData();
    }
    
    // Should have an active connection here now, so can add video/audio/talkback stream handles for our ffmpeg router to handle
    var index = (this.buffer.streams.push({type: "live", id: sessionID, video: videoStream, audio: audioStream, talkback: talkbackStream, timeout: null, aligned: (typeof alignToSPSFrame == "undefined" || alignToSPSFrame == true ? false : true), time: Date.now()}) - 1);

    // Setup talkback audio stream if configured
    if (talkbackStream != null) {
        talkbackStream.on("error", (error) => {
            // EPIPE errors??
        });
        talkbackStream.on("data", (data) => {
            // Received audio data to send onto nexus for output to doorbell/camera
            this.__AudioPayload(data);

            clearTimeout(this.buffer.streams[index].timeout);   // Clear return audio timeout
            this.buffer.streams[index].timeout = setTimeout(() => {
                // no audio received in 500ms, so mark end of stream
                this.__AudioPayload(Buffer.from([]));
            }, 500);
        });
    }

    // finally, we've started live stream
    this.debug && console.debug(getTimestamp() + " [NEXUS] Started live stream from '%s'", this.host);
}

NexusStreamer.prototype.startRecordStream = function(sessionID, ffmpegRecord, videoStream, audioStream, alignToSPSFrame) {
    // Setup error catching for video/audio streams
    videoStream != null && videoStream.on("error", (error) => {
        // EPIPE errors??
    });
    audioStream != null && audioStream.on("error", (error) => {
        // EPIPE errors??
    });

    if (this.buffer.active == false && this.socket == null) {
        // We not doing any buffering and/or there isnt an active socket connection, so startup connection to nexus
        this.debug && console.debug(getTimestamp() + " [NEXUS] Starting connection to '%s''", this.camera.direct_nexustalk_host);
        this.__connect(this.camera.direct_nexustalk_host);
        this.__startNexusData();
    }
   
    // Should have an active connection here now, so can add video/audio streams for our ffmpeg router to handle
    // the ffmpeg router will also handle sending any buffered stream data before any new data
    this.buffer.streams.push({type: "record", id: sessionID, record: ffmpegRecord, video: videoStream, audio: audioStream, empty: true, aligned: (typeof alignToSPSFrame == "undefined" || alignToSPSFrame == true ? false : true), prebuffer: true});

    // Finally we've started the recording stream
    this.debug && console.debug(getTimestamp() + " [NEXUS] Started recording stream from '%s'", this.host);
}

NexusStreamer.prototype.stopRecordStream = function(sessionID) {
    // Request to stop a recording stream
    var index = this.buffer.streams.findIndex(({ type, id }) => type == "record" && id == sessionID);
    if (index != -1) {
        this.debug && console.debug(getTimestamp() + " [NEXUS] Stopped recording stream from '%s'", this.host);
        this.buffer.streams.splice(index, 1);   // remove this object
    }

    // If we have no more streams active, we'll close the socket to nexus
    if (this.buffer.streams.length == 0 && this.buffer.active == false) {
        clearInterval(this.timer);
        this.__close(true);
    }
}

NexusStreamer.prototype.stopLiveStream = function(sessionID) {
    // Request to stop an active live stream
    var index = this.buffer.streams.findIndex(({ type, id }) => type == "live" && id == sessionID);
    if (index != -1) {
        this.debug && console.debug(getTimestamp() + " [NEXUS] Stopped live stream from '%s'", this.host);
        this.buffer.streams[index].timeout && clearTimeout(this.buffer.streams[index].timeout); // Clear any active return audio timer
        this.buffer.streams.splice(index, 1);   // remove this object
    }

    // If we have no more streams active, we'll close the socket to nexus
    if (this.buffer.streams.length == 0 && this.buffer.active == false) {
        clearInterval(this.timer);
        this.__close(true);
    }
}

NexusStreamer.prototype.stopBuffering = function() {
    if (this.buffer.active == true) {
        // we have a buffer session, so close it down
        this.debug && console.debug(getTimestamp() + " [NEXUS] Stopped buffering from '%s'", this.host);
        this.buffer.buffer = null;  // Clean up first
        this.buffer.active = false;    // No buffer running now
    }

    // If we have no more streams active, we'll close the socket to nexus
    if (this.buffer.streams.length == 0) {
        clearInterval(this.timer);
        this.__close(true); 
    }
}

NexusStreamer.prototype.update = function(nestToken, tokenType, cameraData) {
    if (typeof cameraData == "object") {
        if (nestToken != this.nestToken || tokenType != this.tokenType) {
            // access token has changed and/or token type has changed, so re-authorise
            this.tokenType = tokenType; // Update token type
            this.nestToken = nestToken; // Update token
            this.__Authenticate(true);    // Update authorisation only
        }

        if (cameraData && cameraData.direct_nexustalk_host != this.camera.direct_nexustalk_host) {
            // host has changed, so treat as a re-direct if any video active
            this.camera.direct_nexustalk_host = cameraData.direct_nexustalk_host;
            if (this.socket != null && (this.buffer.active == true || this.buffer.streams.length > 0)) {
                this.__handleRedirect(cameraData.direct_nexustalk_host); // Do the redirect
            }
        }

        if ((this.camera.online != cameraData.online) || (this.camera.streaming_enabled != cameraData.streaming_enabled)) {
            // Online status or streaming status has changed has changed
            this.camera.online = cameraData.online;
            this.camera.streaming_enabled = cameraData.streaming_enabled;
            if ((this.camera.online == false || this.camera.streaming_enabled == false) && this.socket != null) {
                this.__close(true); // as offline or streaming not enabled, close socket
            }
            if ((this.camera.online == true && this.camera.streaming_enabled == true) && (this.socket == null && (this.buffer.active == true || this.buffer.streams.length > 0))) {
                this.__connect(this.camera.direct_nexustalk_host);   // Connect to Nexus for stream
                this.__startNexusData();    // Restart processing Nexus data
            }
        }

        if (this.camera.audio_enabled != cameraData.audio_enabled) {
            // Audio setting has changed
            this.camera.audio_enabled = cameraData.audio_enabled;
        }
    }
}

NexusStreamer.prototype.getBufferSnapshot = async function(ffmpegPath) {
    var image = Buffer.alloc(0);    // Empty buffer

    if (this.buffer.active == true) {
        // Setup our ffmpeg process for conversion of h264 image frame to jpg image
        var ffmpegCommand = "-hide_banner -f h264 -i pipe:0 -vframes 1 -f image2pipe pipe:1";
        var ffmpeg = spawn(ffmpegPath || "ffmpeg", ffmpegCommand.split(" "), { env: process.env });

        ffmpeg.stdout.on("data", (data) => {
            image = Buffer.concat([image, data]);   // Append image data to return buffer
        });

        var done = false;
        for (var index = this.buffer.buffer.length - 1; index >= 0 && done == false; index--) {
            if (this.buffer.buffer[index].type == "video" && this.buffer.buffer[index].data[0] && ((this.buffer.buffer[index].data[0] & 0x1f) == H264FrameTypes.SPS) == true) {
                // Found last H264 SPS frame from end of buffer
                // The buffer should now have a buffer sequence of SPS, PPS and IDR
                // Maybe need to refine to search from this position for the PPS and then from there, to the IDR?
                if (index <= this.buffer.buffer.length - 3) {
                    ffmpeg.stdin.write(Buffer.concat([H264NALUnit, this.buffer.buffer[index].data])); // SPS
                    ffmpeg.stdin.write(Buffer.concat([H264NALUnit, this.buffer.buffer[index + 1].data])); // PPS assuming
                    ffmpeg.stdin.write(Buffer.concat([H264NALUnit, this.buffer.buffer[index + 2].data])); // IDR assuming
                    done = true;    // finished outputting to ffmpeg process
                }
            }
        }

        ffmpeg.stdin.end(); // No more output from our search loop, so mark end to ffmpeg
        await EventEmitter.once(ffmpeg, "exit");  // Wait until childprocess (ffmpeg) has issued exit event
    }
    return image;
}

NexusStreamer.prototype.__connect = function(host) {
    clearInterval(this.pingtimer);  // Clear ping timer if was running

    if (this.sessionID == null) this.sessionID = Math.floor(Math.random() * 100); // Random session ID
    if (this.camera.streaming_enabled == true && this.camera.online == true) {

        if (typeof host == "undefined") {
            // No host parameter passed in, so we'll set this to our internally stored host 
            host = this.host;
        }

        this.socket = tls.connect({host: host, port: 1443}, () => {
            // Opened connection to Nexus server, so now need to authenticate ourselves
            this.host = host;   // update internal host name since we've connected
            this.debug && console.debug(getTimestamp() + " [NEXUS] Connection establised to '%s' with session ID '%s'", host, this.sessionID);
            this.socket.setKeepAlive(true); // Keep socket connection alive
            this.__Authenticate(false);

            this.pingtimer = setInterval(() => {
                  // Periodically send PING message to keep stream alive
                  // Doesnt seem to work???
                this.__sendMessage(PacketType.PING, Buffer.alloc(0));
            }, PINGINTERVAL);
        });

        this.socket.on("error", () => {
            // Catch any socket errors to avoid code quitting
            // Our "close" handler will try reconnecting if needed
        });

        this.socket.on("data", (data) => {
            this.__handleNexusData(data);
        });

        this.socket.on("close", (hadError) => {
            var reconnect = false;
            clearInterval(this.pingtimer);    // Clear ping timer
            if (hadError == true && (this.buffer.active == true || this.buffer.streams.length > 0)) {
                // We had a socket error, but still have either active buffering occuring or output streams running
                // so attempt to restart connection to existing host
                this.debug && console.debug(getTimestamp() + " [NEXUS] Connection closed to '%s' with error. Attempting reconnection", host);
                reconnect = true;
            }
            if (hadError == false && this.playingBack == false) {
                // Socket appears to have closed normally ie: we've probably done that
                this.debug && console.debug(getTimestamp() + " [NEXUS] Connection closed to '%s'", host);
            }
            if (hadError == false && this.playingBack == true && (this.buffer.active == true || this.buffer.streams.length > 0)) {
                // No error, but the conenction closed without gracefully ending playback.
                // We still have either active buffering occuring or output streams running
                // so attempt to restart connection to existing host
                this.debug && console.debug(getTimestamp() + " [NEXUS] Connection closed to '%s'. Attempting reconnection", host);
                reconnect = true;
            }

            this.playingBack = false;   // Playback ended as socket is closed
            this.socket = null; // Clear socket object 
            this.sessionID = null;  // Not an active session anymore

            if (reconnect == true) {
                // Restart connection
                this.__connect(host);
                this.__startNexusData();
            }
        });
    }
    
    // Setup timer for when camera video is off or camera is offline, so loop our appropriate messages to the video stream
    clearInterval(this.timer);
    this.timer = setInterval(() => {
        if (this.camera_offline_h264_frame && this.camera.online == false) {
            // Camera is offline, so feed in our custom h264 frame for playback
            this.__ffmpegRouter("video", this.camera_offline_h264_frame);
            this.__ffmpegRouter("audio", AACMONO48000BLANK);
        }
        if (this.camera_off_h264_frame && this.camera.streaming_enabled == false && this.camera.online == true) {
            // Camera video is turned off so feed in our custom h264 frame for playback
            this.__ffmpegRouter("video", this.camera_off_h264_frame);
            this.__ffmpegRouter("audio", AACMONO48000BLANK);
        }
        if (this.camera_connecting_h264_frame && this.playingBack == false && this.camera.streaming_enabled == true && this.camera.online == true) {
            // Connecting to camera video so feed in our custom h264 frame for playback
            // Not sure worth enabling, but its here!
            //this.__ffmpegRouter("video", this.camera_connecting_h264_frame);
            //this.__ffmpegRouter("audio", AACMONO48000BLANK);
        }
        if (this.camera_offline_h264_frame && this.socket == null) {
            // Seems we cant access the video stream as we have an empty connection, so feed in our custom h264 frame for playback
            // We'll use the camera off h264 frame
            this.__ffmpegRouter("video", this.camera_offline_h264_frame);
            this.__ffmpegRouter("audio", AACMONO48000BLANK);
        }
    }, (TIMERINTERVAL / 30));   // output at 30 fps?
}

NexusStreamer.prototype.__close = function(sendStop) {
    // Close an authenicated socket stream gracefully
    if (this.socket != null) {
        if (sendStop == true) {
            // Send a notifcation to nexus we're finished playback
            var stopBuffer = new protoBuf();
            stopBuffer.writeVarintField(1, this.sessionID); // session ID}
            this.__sendMessage(PacketType.STOP_PLAYBACK, stopBuffer.finish());
        }
        this.socket.end();
    }
    this.socket = null;
    this.sessionID = null;  // Not an active session anymore
    this.pendingMessages = []; // No more pending messages
}

NexusStreamer.prototype.__startNexusData = function() {
    if (this.camera.streaming_enabled == true && this.camera.online == true) {
        // Attempt to use camera's stream profile or use default
        var otherProfiles = [];
        this.camera.capabilities.forEach((element) => {
            if (element.startsWith("streaming.cameraprofile")) {
                var profile = element.replace("streaming.cameraprofile.", "");
                if (otherProfiles.indexOf(profile, 0) == -1 && this.streamQuality != StreamProfile[profile]) {
                    // Profile isn't the primary profile, and isn't in the others list, so add it
                    otherProfiles.push(StreamProfile[profile]);
                }
            }
        });

        if (this.camera.audio_enabled == true) otherProfiles.push(StreamProfile.AUDIO_AAC); // Include AAC if audio enabled on camera
        var startBuffer = new protoBuf();
        startBuffer.writeVarintField(1, this.sessionID);   // Session ID
        startBuffer.writeVarintField(2, this.streamQuality);    // Default profile. ie: high quality
        otherProfiles.forEach(otherProfile => {
            startBuffer.writeVarintField(6, otherProfile);  // Other supported profiles
        });
        this.__sendMessage(PacketType.START_PLAYBACK, startBuffer.finish());
    }
}

NexusStreamer.prototype.__stopNexusData = function() {
    var stopBuffer = new protoBuf();
    stopBuffer.writeVarintField(1, this.sessionID);   // Session ID
    this.__sendMessage(PacketType.STOP_PLAYBACK, stopBuffer.finish());
}

NexusStreamer.prototype.__ffmpegRouter = function(type, data) {
    // Send out our nexus data to any streams we're managing, including performing any buffering as required

    // Add the data to the buffer if its active first up
    if (this.buffer.active == true) {
        // Ensure we only have the specified milliseconds of data buffered also
        while (this.buffer.buffer.length > 0 && this.buffer.buffer[0].time < (Date.now() - this.buffer.size)) {
            this.buffer.buffer.shift();    // Remove the element from the tail of the buffer
        }
        this.buffer.buffer.push({time: Date.now(), type: type, data: data});
    }

    for (var streamsIndex = 0; streamsIndex < this.buffer.streams.length; streamsIndex++) {
        if (this.buffer.streams[streamsIndex].type == "record" && this.buffer.streams[streamsIndex].prebuffer == true && this.buffer.active == true) {
            // Specifically for a recording stream, output contents of current buffer first
            this.buffer.streams[streamsIndex].prebuffer = false; // Nothing to pre-buffer now for this stream as we handle this below

            // Output from the beginning of the buffer until one index before the end of buffer
            for (var bufferIndex = 0; bufferIndex < this.buffer.buffer.length - 1; bufferIndex++) {
                if (this.buffer.buffer[bufferIndex].type == "video" && this.buffer.streams[streamsIndex].aligned == false && (this.buffer.buffer[bufferIndex].data && this.buffer.buffer[bufferIndex].data[0] & 0x1f) == H264FrameTypes.SPS) this.buffer.streams[streamsIndex].aligned = true;
                if (this.buffer.streams[streamsIndex].aligned == true) {
                    // This is a live streaming stream, and we have been initally aligned to a h264 SPS frame, so send on data now
                    if (this.buffer.buffer[bufferIndex].type == "video" && this.buffer.streams[streamsIndex].video != null) {
                        // H264 NAL Units "0001" are required to be added to beginning of any video data we output
                        this.buffer.streams[streamsIndex].video.write(Buffer.concat([H264NALUnit, this.buffer.buffer[bufferIndex].data]));
                    }
                    if (this.buffer.buffer[bufferIndex].type == "audio" && this.buffer.streams[streamsIndex].audio != null) { 
                        this.buffer.streams[streamsIndex].audio.write(this.buffer.buffer[bufferIndex].data);
                    }
                }
            }
            this.debug && console.debug(getTimestamp() + " [NEXUS] Recording stream '%s' requested buffered data first. Sent '%s' buffered elements", this.buffer.streams[streamsIndex].id, bufferIndex);
        }

        // Now output the current data to the stream, either a "live" or "recording" stream
        if (type == "video" && this.buffer.streams[streamsIndex].aligned == false && (data && data[0] & 0x1f) == H264FrameTypes.SPS) this.buffer.streams[streamsIndex].aligned = true;
        if (this.buffer.streams[streamsIndex].aligned == true) {
            // This is a live streaming stream, and we have been initally testaligned to a h264 SPS frame, so send on data now
            if (type == "video" && this.buffer.streams[streamsIndex].video != null) {
                // H264 NAL Units "0001" are required to be added to beginning of any video data we output
                this.buffer.streams[streamsIndex].video.write(Buffer.concat([H264NALUnit, data]));
            }
            if (type == "audio" && this.buffer.streams[streamsIndex].audio != null) { 
                this.buffer.streams[streamsIndex].audio.write(data);
            }
        }
    }
}

NexusStreamer.prototype.__processMessages = function() {
    // Send any pending messages that might have accumulated while socket pending etc
    if (this.pendingMessages && this.pendingMessages.length > 0) {
        for (let message = this.pendingMessages.shift(); message; message = this.pendingMessages.shift()) {
            this.__sendMessage(message.type, message.buffer);
        }
    }
}

NexusStreamer.prototype.__sendMessage = function(type, buffer) {
    if (this.socket != null) {
        if ((this.socket.connecting == true || this.socket.encrypted == false) || (type !== PacketType.HELLO && this.authorised == false)) { 
            this.pendingMessages.push({type, buffer});
            return;
        }

        var requestBuffer;
        if (type === 0xcd) {
            // Long packet
            requestBuffer = Buffer.alloc(5);
            requestBuffer[0] = type;
            requestBuffer.writeUInt32BE(buffer.length, 1);
        } else {
            requestBuffer = Buffer.alloc(3);
            requestBuffer[0] = type;
            requestBuffer.writeUInt16BE(buffer.length, 1);
        }
        requestBuffer = Buffer.concat([requestBuffer, Buffer.from(buffer)]);
        // write our composed message to the socket
        this.socket.write(requestBuffer, () => {
            // Message sent. Dont do anything?
        });
    }
}

NexusStreamer.prototype.__Authenticate = function(reauthorise) {
    // Authenticate over created socket connection
    var tokenBuffer = new protoBuf();
    var helloBuffer = new protoBuf();

    this.authorised = false;    // We're nolonger authorised

    if (this.tokenType == "nest") {
        tokenBuffer.writeStringField(1, this.nestToken);   // Tag 1, session token, Nest auth accounts
        helloBuffer.writeStringField(4, this.nestToken);   // session token, Nest auth accounts
    }
    if (this.tokenType == "google") {
        tokenBuffer.writeStringField(4, this.nestToken);   // Tag 4, olive token, Google auth accounts
        helloBuffer.writeBytesField(12, tokenBuffer.finish());    // olive token, Google auth accounts
    }
    if (typeof reauthorise == "boolean" && reauthorise == true) {
        // Request to re-authorise only
        this.debug && console.debug(getTimestamp() + " [NEXUS] Re-authentication requested to '%s'", this.host);
        this.__sendMessage(PacketType.AUTHORIZE_REQUEST, tokenBuffer.finish());
    } else {
        // This isnt a re-authorise request, so perform "Hello" packet
        this.debug && console.debug(getTimestamp() + " [NEXUS] Performing authentication to '%s'", this.host);
        helloBuffer.writeVarintField(1, ProtocolVersion.VERSION_3);
        helloBuffer.writeStringField(2, this.camera.camera_uuid);
        helloBuffer.writeBooleanField(3, false);    // Doesnt required a connect camera
        helloBuffer.writeStringField(6, this.deviceID); // Random UUID v4 device ID
        helloBuffer.writeStringField(7, USERAGENT);
        helloBuffer.writeVarintField(9, ClientType.IOS);
        this.__sendMessage(PacketType.HELLO, helloBuffer.finish());
    }
}

NexusStreamer.prototype.__AudioPayload = function(payload) {
    // Encode audio packet for sending to camera
    var audioBuffer = new protoBuf();
    audioBuffer.writeBytesField(1, payload);    // audio data
    audioBuffer.writeVarintField(2, this.sessionID);    // session ID
    audioBuffer.writeVarintField(3, CodecType.SPEEX);   // codec
    audioBuffer.writeVarintField(4, 16000); // sample rate, 16k
    //audioBuffer.writeVarintField(5, ????);  // Latency measure tag. What does this do? 
    this.__sendMessage(PacketType.AUDIO_PAYLOAD, audioBuffer.finish());
}

NexusStreamer.prototype.__handleRedirect = function(payload) {
    var redirectToHost = "";
    
    if (typeof payload == "object") {
        // Payload parameter is an object, we'll assume its a payload packet
        // Decode redirect packet to determine new host
        var packet = payload.readFields(function(tag, obj, protoBuf) {
            if (tag === 1) obj.new_host = protoBuf.readString();  // new host
            else if (tag === 2) obj.is_transcode = protoBuf.readBoolean();
        }, {new_host: "", is_transcode: false});

        redirectToHost = packet.new_host;
    }
    if (typeof payload == "string") {
        // Payload parameter is a string, we'll assume this is a direct hostname
        redirectToHost = payload;
    }

    if (redirectToHost != "") {
        this.debug && console.debug(getTimestamp() + " [NEXUS] Redirect requested from '%s' to '%s'", this.host, redirectToHost);

        // Setup listener for socket close event. Once socket is closed, we'll perform the redirect
        this.socket && this.socket.on("close", (hasError) => {
            this.__connect(redirectToHost);   // Connect to new host
            this.__startNexusData();    // Restart processing Nexus data
        });
        this.__close(true);     // Close existing socket    
    }
}

NexusStreamer.prototype.__handlePlaybackBegin = function(payload) {
    // Decode playback begin packet
    this.debug && console.debug(getTimestamp() + " [NEXUS] Playback started from '%s'", this.host);
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

    if (packet.session_id == this.sessionID) {
        // Ensure Packet session ID matches our session
        packet.channels && packet.channels.forEach(stream => {
            // Find which channels match our video and audio streams
            if (stream.codec_type == CodecType.H264) {
                this.videoChannelID = stream.channel_id;
            }
            if (stream.codec_type == CodecType.AAC) {
                this.audioChannelID = stream.channel_id;
            }
        });

        // Since this is the beginning of playback, clear any active buffers contents
        this.buffer.buffer = [];
        this.playingBack = true;
    }
}

NexusStreamer.prototype.__handlePlaybackPacket = function(payload) {
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
    if (packet.channel_id === this.videoChannelID) {
        this.__ffmpegRouter("video", Buffer.from(packet.payload));
    }

    // Handle audio packet
    if (packet.channel_id === this.audioChannelID) {
        this.__ffmpegRouter("audio", Buffer.from(packet.payload));
    }
}

NexusStreamer.prototype.__handlePlaybackEnd = function(payload) {
    // Decode playpack ended packet
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.session_id = protoBuf.readVarint();
        else if (tag === 2) obj.reason = protoBuf.readVarint();
    }, {session_id: 0, reason: 0});

    switch (packet.reason) {
        case 0 : {
            // Normal playback ended ie: when we stop playback
            this.debug && console.debug(getTimestamp() + " [NEXUS] Playback ended on '%s'", this.host);
            break;
        }

        case Reason.ERROR_TRANSCODE_NOT_AVAILABLE : 
        case Reason.PLAY_END_SESSION_COMPLETE : {
            // Lets restart playback
            this.debug && console.debug(getTimestamp() + " [NEXUS] Playback ended on '%s'. We'll attempt to restart", this.host, packet.reason);
            this.__connect();   // Re-connect to existing host
            this.__startNexusData();    // Restart processing Nexus data
            break;
        }

        default : {
            // Another kind of error.
            this.debug && console.debug(getTimestamp() + " [NEXUS] Playback ended on with error '%s'", this.host, packet.reason);
            break;
        }
    }
    this.playingBack = false;   // Playback ended
}

NexusStreamer.prototype.__handleNexusError = function(payload) {
    // Decode error packet
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.code = protoBuf.readVarint();
        else if (tag === 2) obj.message = protoBuf.readString();
    }, {code: 1, message: ""});
   
    if (packet.code === ErrorCode.ERROR_AUTHORIZATION_FAILED) {
        // NexusStreamer Updating authentication
        this.__Authenticate(true);    // Update authorisation only
    } else {
        // NexusStreamer Error, packet.message contains the message
        this.debug && console.debug(getTimestamp() + " [NEXUS] Error", packet.message);
    }
}

NexusStreamer.prototype.__handleTalkbackBegin = function(payload) {
    // Decode talk begin packet
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.user_id = protoBuf.readString();
        else if (tag === 2) obj.session_id = protoBuf.readVarint();
        else if (tag === 3) obj.quick_action_id = protoBuf.readVarint();
        else if (tag === 4) obj.device_id = protoBuf.readString();
    }, {user_id: "", session_id: 0, quick_action_id: 0, device_id: ""});

    this.debug && console.debug(getTimestamp() + " [NEXUS] Talkback started on '%s'", packet.device_id);
    this.talking = true;    // Talk back has started
}

NexusStreamer.prototype.__handleTalkbackEnd = function(payload) {
    // Decode talk end packet
    var packet = payload.readFields(function(tag, obj, protoBuf) {
        if (tag === 1) obj.user_id = protoBuf.readString();
        else if (tag === 2) obj.session_id = protoBuf.readVarint();
        else if (tag === 3) obj.quick_action_id = protoBuf.readVarint();
        else if (tag === 4) obj.device_id = protoBuf.readString();
    }, {user_id: "", session_id: 0, quick_action_id: 0, device_id: ""});

    this.debug && console.debug(getTimestamp() + " [NEXUS] Talkback ended on '%s'", packet.device_id);
    this.talking = false;    // Talk back has stopped
}

NexusStreamer.prototype.__handleNexusData = function(data) {
    // Process the rawdata from our socket connection and convert into nexus packets to take action against
    this.pendingBuffer = (this.pendingBuffer == null ? data : Buffer.concat([this.pendingBuffer, data]));
    if (this.pendingBuffer.length >= 3) {
        // Ensure we have a minimun length in the buffer to read header details
        var type = this.pendingBuffer.readUInt8();
        var headerLength = 3;
        var length = this.pendingBuffer.readUInt16BE(1);

        if (type == PacketType.LONG_PLAYBACK_PACKET) {
            // Adjust header size and data length based upon packet type
            headerLength = 5;
            length = this.pendingBuffer.readUInt32BE(1);
        }

        var payloadEndPosition = length + headerLength;
        if (this.pendingBuffer.length >= payloadEndPosition) {
            var payload = new protoBuf(this.pendingBuffer.slice(headerLength, payloadEndPosition));
            switch (type) {
                case PacketType.OK : {
                    this.authorised = true; // OK message, means we're connected and authorised to Nexus
                    this.__processMessages();
                    break;
                }
        
                case PacketType.ERROR : {
                    this.__handleNexusError(payload);
                    break;
                }
        
                case PacketType.PLAYBACK_BEGIN : {
                    this.__handlePlaybackBegin(payload);
                    break;
                }
        
                case PacketType.PLAYBACK_END : {
                    this.__handlePlaybackEnd(payload);
                    break;
                }
        
                case PacketType.LONG_PLAYBACK_PACKET :
                case PacketType.PLAYBACK_PACKET : {
                    this.__handlePlaybackPacket(payload);
                    break;
                }

                case PacketType.REDIRECT : {
                    this.__handleRedirect(payload);
                    break;
                }

                case PacketType.TALKBACK_BEGIN : {
                    this.__handleTalkbackBegin(payload);
                    break;
                }

                case PacketType.TALKBACK_END : {
                    this.__handleTalkbackEnd(payload);
                    break;
                }

                default: {
                    // We didn't process this type of packet
                    break
                }
            }
            var remainingData = this.pendingBuffer.slice(payloadEndPosition);
            this.pendingBuffer = null;
            if (remainingData.length > 0) {
                this.__handleNexusData(remainingData);  // Maybe not do this recursive???
            }
        }
    }
}

module.exports = NexusStreamer;