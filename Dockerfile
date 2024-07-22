# version of required ffmpeg binary is specified in FFMPEG_VERSION
ARG FFMPEG_VERSION=7.0.1

# version of node docker we will use. 
# Pegged at node v18.x as bug in docker builds on armv7/armv6 when using later versions
#ARG NODE_VERSION=18-alpine3.20
ARG NODE_VERSION=22-alpine3.20

# version of our project. pass in via build, formatted as vx.x.x
ARG NEST_ACCFACTORY_VERSION

# first up, we want to build our ffmpeg binary to be included in the final image
FROM node:${NODE_VERSION} as builder
ARG TARGETARCH
ARG FFMPEG_VERSION
ARG FFMPEG_EXTRA_OPTIONS

RUN apk update \
    && apk upgrade \
    && apk add build-base \
    && apk add bash \
    && apk add nasm \
    && apk add zlib-dev \
    && apk add speex-dev \
    && apk add fdk-aac-dev 

# get x264 source and build for ffmpeg build below
# we do this as the alpine linux repo has an older x264-lib package 
WORKDIR /build
ADD https://code.videolan.org/videolan/x264/-/archive/master/x264-master.tar.bz2 x264-master.tar.bz2
RUN tar -vxf x264-master.tar.bz2
WORKDIR /build/x264-master
RUN ./configure --enable-static --enable-pic \
    && make -j 4 \
    && make install-lib-static

# get ffmpeg source and build
# this is a paired back binary suitable for just what we need
WORKDIR /build
ADD https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2 ffmpeg-${FFMPEG_VERSION}.tar.bz2
RUN tar -vxf ffmpeg-${FFMPEG_VERSION}.tar.bz2
WORKDIR /build/ffmpeg-${FFMPEG_VERSION}
RUN ./configure \
    --pkgconfigdir="/usr/lib/pkgconfig" \
    --pkg-config-flags="--static" \
    --extra-cflags="-I/include" \
    --extra-ldflags="-L/lib" \
    --extra-libs="-lpthread -lm" \
    --disable-debug \
    --disable-ffplay \
    --disable-doc \
    --disable-demuxers \
    --disable-muxers \
    --disable-outdevs \
    --disable-indevs \
    --disable-decoders \
    --disable-encoders \
    --disable-protocols \
    --enable-gpl \
    --enable-version3 \
    --enable-nonfree \
    --enable-pthreads \
    --enable-runtime-cpudetect \
    --enable-avfilter \
    --enable-filters \
    --enable-network \
    --enable-protocol=tcp \
    --enable-protocol=udp \
    --enable-protocol=rtp \
    --enable-protocol=file \
    --enable-protocol=srtp \
    --enable-protocol=pipe \
    --enable-libspeex \
    --enable-libx264 \
    --enable-libfdk-aac \
    --enable-demuxer=sdp \
    --enable-demuxer=rtp \
    --enable-demuxer=h264 \
    --enable-demuxer=aac \
    --enable-demuxer=image2 \
    --enable-muxer=image2pipe \
    --enable-muxer=h264 \
    --enable-muxer=mp4 \
    --enable-muxer=rtp \
    --enable-muxer=data \
    --enable-decoder=mjpeg \
    --enable-decoder=h264 \
    --enable-decoder=mpeg4 \
    --enable-decoder=aac \
    --enable-decoder=libfdk_aac \
    --enable-decoder=speex \
    --enable-encoder=mpeg4 \
    --enable-encoder=aac \
    --enable-encoder=libfdk_aac \
    --enable-encoder=libx264 \
    --enable-encoder=libspeex \
    --enable-encoder=mjpeg \
    --enable-hardcoded-tables \
    ${FFMPEG_EXTRA_OPTIONS} \
    && make -j 4 \
    && make install

# build our nodejs app container now
FROM node:${NODE_VERSION} as app
ARG FFMPEG_VERSION
ARG NEST_ACCFACTORY_VERSION

# Add extra libraries we'll need for timezone support and our compiled ffmpeg binary
# Pass TZ env from docker run to set timezone
RUN apk update \
    && apk upgrade \
    && apk add tzdata \
    && apk add fdk-aac \
    && apk add speex \
    && apk add nano

# working directory inside the container
WORKDIR /opt/Nest_accfactory

# copy require files into container image folder
COPY package.json ./
COPY Nest_accfactory.js ./
COPY Nest_camera_*.jpg ./
COPY Nest_camera_*.h264 ./
COPY HomeKitHistory.js ./
COPY HomeKitDevice.js ./
COPY nexusstreamer.js ./
COPY protobuf/ ./protobuf/
COPY --from=builder /build/ffmpeg-${FFMPEG_VERSION}/ffmpeg ./

# perform installation based on details in package.json
RUN npm update -g \
    && npm install

# tidy up install by removing sample accessories from hap-nodejs
RUN rm -rf ./node_modules/hap-nodejs/dist/accessories
RUN mkdir ./node_modules/hap-nodejs/dist/accessories
RUN cp ./node_modules/hap-nodejs/dist/types.* ./node_modules/hap-nodejs/dist/accessories/

# fixup file ownership to match non-root user, "node"
RUN chown -R node:node /opt/Nest_accfactory

# run the accessory, using non-root user, "node"
USER node
ENTRYPOINT ["node", "/opt/Nest_accfactory/Nest_accfactory.js", "/opt/Nest_accfactory/conf/Nest_config.json"]

# labels for the container
LABEL org.opencontainers.image.title="Nest_accfactory"
LABEL org.opencontainers.image.description="HomeKit integration for Nest devices based on HAP-NodeJS library"
LABEL org.opencontainers.image.url="https://github.com/n0rt0nthec4t/Nest_accfactory"
LABEL org.opencontainers.image.authors="n0rt0nthec4t@outlook.com"
LABEL org.opencontainers.image.version=${NEST_ACCFACTORY_VERSION}