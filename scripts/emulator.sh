#!/usr/bin/env bash
# Create (if needed) and start the API 29 arm64 emulator used for androidTests. Nexus 5X-like: 1080x1920 @ 420dpi.
set -euo pipefail
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}
export ANDROID_HOME=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
AVD=deck29
if ! "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" list avd -c | grep -qx "$AVD"; then
  echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n "$AVD" -k "system-images;android-29;default;arm64-v8a" -d "Nexus 5X" --force
  cfg="$HOME/.android/avd/$AVD.avd/config.ini"
  { echo "hw.lcd.density=420"; echo "hw.lcd.width=1080"; echo "hw.lcd.height=1920"; echo "hw.keyboard=yes"; echo "disk.dataPartition.size=2G"; } >> "$cfg"
fi
if ! "$ANDROID_HOME/platform-tools/adb" devices | grep -q emulator; then
  nohup "$ANDROID_HOME/emulator/emulator" -avd "$AVD" -no-snapshot -no-boot-anim -no-audio -gpu swiftshader_indirect ${EMULATOR_ARGS:-} >/dev/null 2>&1 &
  "$ANDROID_HOME/platform-tools/adb" wait-for-device
  until [ "$("$ANDROID_HOME/platform-tools/adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
fi
echo "emulator $AVD ready"
