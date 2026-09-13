# Smoke test

The manual checklist from spec §14. Run it on the real phone after any release that touches the
kiosk, wifi, pairing or update paths — the automated suites cannot reach any of these.

Tick each line, or write down what happened instead.

## Kiosk

- [ ] `adb shell dumpsys device_policy | grep -i "device owner"` names
      `com.evenseal.usagedeck/.kiosk.DeviceAdminReceiver`.
- [ ] Lock task holds: pressing Home and Recents does nothing, and the status and navigation bars
      are gone.
- [ ] Rebooting the phone comes straight back into the deck with no launcher picker.
- [ ] Long-pressing the top-left corner for 3 s opens the PIN dialog; a wrong PIN counts down
      remaining attempts; the right one leaves lock task.
- [ ] Within 10 minutes of that exit the deck re-pins itself without being touched.
- [ ] Battery-optimisation exemption is still granted (Machine screen, or
      `adb shell dumpsys deviceidle whitelist | grep usagedeck`).

## Wifi

- [ ] The Wifi screen lists networks sorted strongest first, each with a security tag, and says
      how old the scan is.
- [ ] Rescan is disabled for 30 s after a scan, then works.
- [ ] Joining a **phone hotspot** with a WPA2 passphrase succeeds and the status chip updates.
- [ ] Joining an open network succeeds without a passphrase prompt.
- [ ] Forget removes a saved network.
- [ ] On a captive-portal network, *Open captive portal* loads the login page **inside lock task**
      and Done returns to the deck.

## Pairing

- [ ] *Pairing → Scan QR* reads the QR from `claude-usage configure pairing` and the machine
      appears.
- [ ] A QR from a daemon with a rotated token reports "Token rejected, re-run pairing on the Mac"
      and does not leave a broken machine behind.
- [ ] A machine that is merely asleep is saved and shown unreachable rather than rejected.
- [ ] Unpair asks for confirmation and removes the token.

## Live data

- [ ] Both users' 5 h and 7 d bars show, with reset captions.
- [ ] A teammate whose Mac is closed fades to 55 % within two minutes and their machine dot goes
      red.
- [ ] Rotating the phone switches Ledger ↔ Wide dock with no data loss.
- [ ] Session rows show tokens/min and a moving 30-minute sparkline.

## Pause

- [ ] Tap a live session's pause → the session soft-pauses on the Mac and the countdown starts.
- [ ] Tap it again → it resumes, and `claude-usage` on the Mac agrees.
- [ ] Let the countdown run out → the session hard-freezes and the row reads **frozen**.
- [ ] On the Mac, `ps -o stat= -p <pid>` shows `T` while frozen.
- [ ] Resume → `ps` shows `S`/`R` again, i.e. **SIGCONT actually landed**, and the session
      carries on rather than dying.
- [ ] Hold *Pause all* → every reachable machine freezes; a dead machine is skipped, not retried
      forever.
- [ ] A session discovered from its transcript (no trusted pid) refuses a hard pause with a clear
      message.

## Alerts

- [ ] Crossing the warn threshold buzzes once and shows the chip; crossing critical buzzes five
      times.
- [ ] In the dock, an alert takes the full screen for 8 s; on battery it arrives as a heads-up
      notification.
- [ ] Inside quiet hours the visual still appears and the phone stays silent.

## Update

- [ ] *Settings → Check for update now* reports the installed version against the latest release.
- [ ] Publishing a newer release causes the deck to download, verify and install it with **no
      prompt** (Device Owner), and the version footer changes afterwards.
- [ ] An update that arrives while a hold is in progress or an escalation is armed is deferred,
      and installs once the deck goes quiet.
- [ ] A release whose `SHA256SUMS` does not match is refused and the APK is deleted.
