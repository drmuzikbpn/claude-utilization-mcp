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

Check it came up:

```bash
curl -H "Authorization: Bearer $(claude-usage configure show-token)" \
  "http://$(tailscale ip -4):47291/health"
```

## 4. Pair the phone

```bash
claude-usage configure pairing
```

That prints a QR. On the deck: **Projects → Pairing → Scan QR**, and hold the phone up to your
screen.

> The QR is a **live credential** — it carries a bearer token for your daemon. Show it from your
> own screen only. Never put it in a slide, a screenshot, or a shared doc. If it is ever exposed,
> run `claude-usage configure rotate-token` and pair again.

The deck immediately calls `/health` with the token: you will see either your machine appear, or
"Token rejected, re-run pairing on the Mac".

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
per-machine read-only mode in v1.

## Troubleshooting

| What you see on the deck | What it usually means |
| --- | --- |
| Machine dot red, "has not checked in for 2 minutes" | Mac asleep, or the daemon stopped |
| "Token rejected" | Token was rotated; re-run `claude-usage configure pairing` |
| Machine unreachable but wifi is fine | `config.bind` is missing `"tailscale"`, or the node is not approved |
| All machines unreachable at once | Tailscale on the phone is down — the deck offers a button to open it |
