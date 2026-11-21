#!/bin/sh
# Builds bin/hey-claude for Apple Silicon and Intel Macs (macOS 13 or later), with
# Info.plist embedded (macOS needs it for the microphone and speech prompts).
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos13" listener/main.swift -o "$tmp/$arch" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker listener/Info.plist
done
lipo -create "$tmp/arm64" "$tmp/x86_64" -output bin/hey-claude
rm -rf "$tmp"
codesign --force --sign - bin/hey-claude
bin/hey-claude --selftest
