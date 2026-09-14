# Device setup — Nexus 5X kiosk

This is the procedure that was actually run on the deck phone, written out so it can be repeated
on a second one. Everything here is done once, over USB, from the Mac.

**Read the two hard preconditions before you start:**

- **Never set a screen lock on this device.** `setKeyguardDisabled` silently no-ops once a secure
  keyguard exists, and you will not be able to undo it without a factory reset.
- **Tailscale is point-to-point only, never an exit node.** GitHub update polling must not depend
  on tailnet health.

---

## 1. Unlock the bootloader

Enable *Developer options* → *OEM unlocking* and *USB debugging* on stock Android first.

```bash
adb reboot bootloader
fastboot flashing unlock      # confirm on the device; this wipes it
```

## 2. Flash LineageOS 17.1 (bullhead)

LineageOS dropped official bullhead builds long ago. The build in use is the unofficial
2021-01-31 one by **linckandrea**:

- Source: <https://archive.org/download/lineage-17.1-20210131-UNOFFICIAL-bullhead/>
- `lineage-17.1-20210131-UNOFFICIAL-bullhead.zip`
  sha256 `980d791c1b14a170581400181b9081503630f08cdabe89bfd21f7d55a117add2`
- `twrp-3.7.0_9-0-bullhead-f2fs.img`
  sha256 `395303a9d3d22efe5d22dfbe01b087b1bd86c7ed6c4452d11b26d312420cafa7`

Verify both before flashing:

```bash
shasum -a 256 lineage-17.1-20210131-UNOFFICIAL-bullhead.zip twrp-3.7.0_9-0-bullhead-f2fs.img
```

**No GApps.** Skip account setup entirely.

```bash
fastboot flash recovery twrp-3.7.0_9-0-bullhead-f2fs.img
fastboot boot twrp-3.7.0_9-0-bullhead-f2fs.img

adb shell twrp wipe data
adb shell twrp wipe cache
adb shell twrp wipe system

adb push lineage-17.1-20210131-UNOFFICIAL-bullhead.zip /sdcard/lineage.zip
adb shell twrp install /sdcard/lineage.zip
```

## 3. Pin adb on, and set the timezone, before first boot

Still in TWRP, mount `/system` and append to `/system/system/build.prop`:

```properties
persist.sys.usb.config=adb
ro.adb.secure=0
persist.sys.timezone=America/New_York
```

Without these you have to re-authorise adb through a dialog you cannot easily reach on a phone
that is about to become a kiosk.

Reboot into Android.

## 4. Skip provisioning and keep the screen awake

```bash
adb shell settings put global device_provisioned 1
adb shell settings put secure user_setup_complete 1
adb shell settings put global stay_on_while_plugged_in 7
adb shell pm disable-user --user 0 org.lineageos.setupwizard
```

`device_provisioned`/`user_setup_complete` must be set **before** `dpm set-device-owner` runs, and
no account may exist on the device.

## 5. Set the clock

A 2021 system clock breaks the HTTPS connectivity probe, which breaks NTP, which leaves the clock
in 2021 — set it by hand to break the loop:

```bash
adb shell service call alarm 2 i64 "$(python3 -c 'import time; print(int(time.time()*1000))')"
```

Re-check with `adb shell date` and only then expect network time to hold.

## 6. Install Tailscale

Grab the APK from the GitHub releases of `tailscale/tailscale-android` (1.102.4 was used), or
from <https://pkgs.tailscale.com/stable/#android> / F-Droid.

```bash
adb install -r tailscale-1.102.4.apk
```

Log in on the device and approve the node in the tailnet admin. **Do not enable it as an exit
node, and do not route this device through one.**

## 7. Install Usage Deck and make it Device Owner

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell dpm set-device-owner com.evenseal.usagedeck/.kiosk.DeviceAdminReceiver
```

This must happen before any account exists on the device. If it fails with
`Not allowed to set the device owner`, something created an account or the provisioning flags in
step 4 were not set.

## 8. First launch

Open Usage Deck once. It will:

- whitelist `[com.evenseal.usagedeck, com.tailscale.ipn]` for lock task and start lock task,
- disable the keyguard, set stay-awake-on-power, hide the status and navigation bars,
- grant itself `ACCESS_FINE_LOCATION` and `CAMERA` — **required**, because Android 10 returns an
  empty wifi scan list rather than an error without location permission,
- make itself the persistent HOME activity, so a reboot comes straight back into the deck.

**A one-tap battery-optimisation dialog appears on this first launch and must be accepted on the
phone.** Device Owner cannot write the Doze whitelist itself on API 29, and without the exemption
the SSE stream dies when the screen goes off in battery mode. It is asked once; the Machine screen
shows whether it stuck.

## 9. Pair each machine

On the Mac, `claude-usage configure pairing` prints a QR. In the deck: *Projects → Pairing → Scan
QR*, held up to the Mac's screen.

The QR is a **live bearer token**. Scan it off the Mac's own screen — never off a photo or a
shared screen — and run `claude-usage configure rotate-token` if it was ever exposed.

Verify from the Mac that the daemon answers on the tailnet address the QR carried:

```bash
curl -H "Authorization: Bearer $TOKEN" http://100.x.y.z:47291/health
```

Each daemon's `config.bind` must include `"tailscale"`, or every request from the phone gets a
`421`.

## Maintenance exit

Long-press the top-left corner for 3 s → PIN → lock task stops for 10 minutes. An `AlarmManager`
alarm owned by the app re-pins afterwards regardless of which app is in front, and a reboot inside
the window boots locked.

Set the PIN in *Settings → Kiosk exit PIN* (six digits). Forgotten-PIN recovery is `adb shell`;
USB debugging stays enabled on this device on purpose.

## Charge cap and thermals

There is **no charge cap in v1**. Writing battery sysfs needs root, and Device Owner does not
grant it. The app dims to 30 % and slows sparkline redraws to every 10 s above 42 °C.

## Release signing (done by a human, once)

```bash
keytool -genkeypair -v -keystore /tmp/usage-deck-release.jks -alias usagedeck \
  -keyalg RSA -keysize 4096 -validity 10000
```

Generate both passwords with `openssl rand -base64 24`. Store the base64 of the keystore and the
passwords in **1Password vault `usagedeck`, item `usagedeck-ci`**, fields `SIGNING_KEYSTORE_B64`,
`SIGNING_KEY_ALIAS`, `SIGNING_STORE_PASSWORD`, `SIGNING_KEY_PASSWORD` — entered through the
desktop app, never as command arguments, which end up in shell history. Then delete
`/tmp/usage-deck-release.jks`.

The GitHub Actions secrets of the same four names are populated from that item.

## Daemon install on the Mac Studio

Install from a git checkout of `drmuzikbpn/claude-utilization-mcp` and run `claude-usage install`
from there, with `bind: tailscale` in the config.

**Run `install` from the Mac's own desktop session, not over ssh.** A LaunchAgent bootstrapped
from an ssh session never gets its spawns scheduled (`launchctl print` shows `runs = 0` and
`KeepAlive` never fires), so the daemon updates itself fine but does not come back from a crash or
a reboot. The daemon prints a warning when it detects this; if a machine drops off the deck and
stays off, this is the first thing to check.
