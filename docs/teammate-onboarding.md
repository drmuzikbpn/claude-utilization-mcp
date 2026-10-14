# Getting your Mac onto the deck

Five minutes on your Mac. The deck is a phone on a shelf that shows everyone's Claude Code
utilisation; adding yourself means running the `claude-usage` daemon and showing the phone a QR.

## 1. Join the tailnet

Install Tailscale and log in with the work account, then ask for your node to be approved in the
tailnet admin.

```bash
tailscale status     # your machine should be listed and have a 100.x address
```

You do **not** need an exit node, and you should not enable one — the deck polls GitHub directly.

## 2. Install the daemon

There is no npm package yet, so install from a checkout:

```bash
git clone https://github.com/drmuzikbpn/claude-utilization-mcp.git
cd claude-utilization-mcp
claude-usage install
```

## 3. Bind it to the tailnet

The daemon must listen on the tailnet interface, not just loopback. In its config:

```json
{ "bind": "tailscale" }
```

Without `"tailscale"` in `config.bind` **every request from the phone gets a 421** and your
machine will sit on the deck as permanently unreachable.

Check it came up. Plain HTTP is served on loopback only, and every request needs the token:

```bash
curl -H "Authorization: Bearer $(claude-usage configure show-token)" "http://127.0.0.1:47291/health"
```

The phone never uses that port: it talks to the daemon's HTTPS port, pinned to the certificate
the pairing QR names.

## 4. Pair the phone

```bash
claude-usage pair
```

That prints a QR. On the deck: **Projects → Pairing → Scan QR**, and hold the phone up to your
screen. The QR holds a one-time code (valid five minutes, usable once) plus your daemon's
certificate pin; the deck trades the code for the token over HTTPS pinned to that certificate,
so the QR itself is worthless once used. If the deck says the code is invalid or expired, run
`claude-usage pair` again.

There is no other way to pair. An older deck could also scan the QR from
`claude-usage configure pairing`, which carried the token itself; that pairing has been removed
from the daemon and the deck. If your Mac was paired that way, the deck shows it as an amber
"needs to be paired again" card: run `claude-usage pair` and tap **Re-pair**.

If the phone is ever lost or stolen, run `claude-usage configure rotate-token` on your Mac and
pair the replacement.

## 5. What the deck can do to your sessions

Anyone standing at the phone can:

- **tap** a session's pause button — a *soft* pause: Claude Code stops at the next tool boundary
  and can be resumed with another tap;
- **hold** it for 600 ms — a *hard* freeze: whatever tool is running is `SIGSTOP`ped and the next
  tool call is held. On daemon 0.1.66 or newer your `claude` process itself keeps running, so your
  terminal never shows "suspended" and you never need `fg` (older daemons stop the TUI too; type
  `fg` if you see "suspended (signal)"). Resuming sends `SIGCONT` and the session carries on.

A soft pause escalates to a freeze after 90 seconds by default, so a pause you forget about ends
up as a freeze rather than silently expiring.

Two things to know:

- A freeze longer than your session's tool timeout (Claude Code's default is 2 minutes) ends the
  tool call that was running: the timeout keeps counting while the process is stopped, and the
  kill lands when it wakes. The session continues and sees a timeout error. Short freezes resume
  cleanly.
- A session that restarts (`claude --resume`) while a freeze rule still stands is frozen again on
  arrival; the row on the phone reads **frozen again ×2**. Resume from the phone first.

If you would rather your machine not be pausable from the deck, do not pair it — there is no
per-machine read-only mode yet.

## Troubleshooting

| What you see on the deck | What it usually means |
| --- | --- |
| Machine dot red, "has not checked in for 2 minutes" | Mac asleep, or the daemon stopped |
| A machine's numbers and its user are gone; its dot is red, "last heard 2d ago" | No check-in for a day, so the deck stopped showing what it last reported. It is still paired; the numbers return when it checks in |
| Amber "<name> needs to be paired again" card | The Mac was paired with the retired `claude-usage configure pairing`; run `claude-usage pair` on it and tap **Re-pair** |
| "That is an old `claude-usage configure pairing` code" while scanning | You scanned the retired QR; run `claude-usage pair` and scan the new one |
| "Replace <old> with <new>?" | The QR or pairing file would overwrite a machine that is already paired; check both names before you agree |
| Amber "<name> no longer accepts this deck" card | Token rotated or certificate changed; run `claude-usage pair` on that Mac and tap **Re-pair** |
| "run `claude-usage pair` again" while pairing | The one-time code expired (five minutes) or was already used |
| "This machine's certificate changed" | The daemon made a new TLS certificate; re-run `claude-usage pair` |
| Machine unreachable but wifi is fine | `config.bind` is missing `"tailscale"`, the node is not approved, or the Mac's firewall blocks the daemon's HTTPS port |
| "Secure storage is unavailable" instead of the dashboard | The phone's keystore could not open the deck's encrypted store; restart it, and see `docs/device-setup.md` if it persists |
| All machines unreachable at once | Tailscale on the phone is down — the deck offers a button to open it |
