#!/bin/sh
# Builds packages/speech-mac/overlord-speech. The Info.plist is embedded in the
# binary: without the usage descriptions macOS kills a command-line tool the
# first time it touches the microphone or speech recognition.
set -e
cd "$(dirname "$0")"
swiftc -O main.swift -o overlord-speech \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign --force --sign - --identifier dev.overlord.speech overlord-speech
echo "built $(pwd)/overlord-speech"
