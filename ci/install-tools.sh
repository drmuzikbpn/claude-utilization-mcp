#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
#
# Installs the build tools CI uses at exact versions, each checked against a pinned SHA-256
# before anything is unpacked: XcodeGen, and (with "lint") SwiftLint and SwiftFormat.
#
#   ci/install-tools.sh <dir> [lint]     then put <dir>/bin on PATH
#
# To move a pin: change the version, download the archive, run `shasum -a 256` on it and paste
# the digest here. A mismatch stops the job.
set -eu

XCODEGEN_VERSION=2.46.0
XCODEGEN_SHA256=4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806
SWIFTLINT_VERSION=0.63.2
SWIFTLINT_SHA256=c59a405c85f95b92ced677a500804e081596a4cae4a6a485af76065557d6ed29
SWIFTFORMAT_VERSION=0.63.1
SWIFTFORMAT_SHA256=385ef1a263ba28685157b98c5536b9c9105e124518f28b7ef8a2bee4b167eaeb

dest="${1:?usage: ci/install-tools.sh <dir> [lint]}"
mkdir -p "$dest/bin" "$dest/dl"

fetch() { # name url sha256
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -o "$dest/dl/$1.zip" "$2"
  got="$(shasum -a 256 "$dest/dl/$1.zip" | cut -d ' ' -f 1)"
  if [ "$got" != "$3" ]; then
    echo "$1: SHA-256 mismatch (expected $3, got $got)" >&2
    exit 1
  fi
  rm -rf "$dest/dl/$1"
  unzip -q "$dest/dl/$1.zip" -d "$dest/dl/$1"
}

fetch xcodegen "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip" "$XCODEGEN_SHA256"
# XcodeGen finds its setting presets in ../share next to its binary.
rm -rf "$dest/share"
cp -R "$dest/dl/xcodegen/xcodegen/share" "$dest/share"
cp "$dest/dl/xcodegen/xcodegen/bin/xcodegen" "$dest/bin/xcodegen"

if [ "${2:-}" = "lint" ]; then
  fetch swiftlint "https://github.com/realm/SwiftLint/releases/download/$SWIFTLINT_VERSION/portable_swiftlint.zip" "$SWIFTLINT_SHA256"
  cp "$dest/dl/swiftlint/swiftlint" "$dest/bin/swiftlint"
  fetch swiftformat "https://github.com/nicklockwood/SwiftFormat/releases/download/$SWIFTFORMAT_VERSION/swiftformat.zip" "$SWIFTFORMAT_SHA256"
  cp "$dest/dl/swiftformat/swiftformat" "$dest/bin/swiftformat"
fi
chmod +x "$dest/bin/"*
rm -rf "$dest/dl"
