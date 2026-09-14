# Manual smoke test

CI runs lint, typecheck, tests and build on `ubuntu-latest` and `macos-latest`. It cannot
run launchd or systemd, cannot touch the Keychain, has no Tailscale peer, and cannot
usefully `SIGSTOP` a real Claude Code process tree. This is that list.

Run it before a release, and after any change to `src/install/**`, `src/service/**`,
`src/net/**` or `src/pause/**`.

**Setup for every section.** Work from a checkout, and keep the real config out of the way
by pointing XDG at a scratch directory where the step allows it:

```bash
npm ci && npm run build
export SMOKE=$(mktemp -d)
```

Steps that must exercise the real installer use your real `$HOME` — they are marked
**(real HOME)** and each one ends with an uninstall.

---

## 1. launchd install / uninstall (macOS) **(real HOME)**

```bash
node bin/claude-usage install --yes
```

Expect, in order: a preflight block, the plan, then the apply lines.

```
preflight
  [ok  ] node: Node v22.x.x
  [ok  ] platform: darwin
  [ok  ] credentials: Claude Code OAuth token is readable
…
config: /Users/you/.config/claude-usage/config.json (0600) — bearer token generated
package: /Users/you/.local/share/claude-usage/versions/0.1.0
current: /Users/you/.local/share/claude-usage/current -> /Users/you/.local/share/claude-usage/versions/0.1.0
service: launchd /Users/you/Library/LaunchAgents/com.github.drmuzikbpn.claude-usage.plist
hooks:   registered SessionStart, SessionEnd, UserPromptSubmit, PreToolUse
mcp:     registered via `claude mcp add`

installed
  service     launchd — running
  daemon      healthy on port 47291
  hooks       on
  mcp         on
  statusline  off
  config      /Users/you/.config/claude-usage
```

Verify each artefact:

```bash
launchctl print gui/$UID/com.github.drmuzikbpn.claude-usage | grep -E '^\s*(state|pid) '
#   state = running
#   pid = <n>

plutil -p ~/Library/LaunchAgents/com.github.drmuzikbpn.claude-usage.plist
#   ProgramArguments => [ <absolute node>, …/current/bin/claude-usage, "serve" ]
#   RunAtLoad => 1 ; KeepAlive => { SuccessfulExit => 0 }
#   StandardErrorPath => /Users/you/Library/Logs/claude-usage/daemon.err.log

stat -f '%Sp %N' ~/.config/claude-usage ~/.config/claude-usage/config.json
#   drwx------ … and -rw------- …

curl -s localhost:47291/health | head -c 120
#   {"ok":true,"name":"…","version":"…"

python3 -c "import json;d=json.load(open('$HOME/.claude/settings.json'));\
print({k:len(v) for k,v in d['hooks'].items()})"
#   every event we added has one more group than before; your own groups are still there

ls ~/.claude/settings.json.claude-usage.bak      # exists, written once
claude mcp list | grep claude-usage              # claude-usage: … mcp
```

Re-run `node bin/claude-usage install --yes` — it must be idempotent:
`hooks:   already registered`, `package: … (already installed)`, no second `.bak`, and
`git diff`-equivalent stability of `settings.json` (compare a copy you took before).

`KeepAlive { SuccessfulExit: false }` check — the daemon must come back after a crash but
**not** after a clean exit:

```bash
kill -9 $(cat ~/.config/claude-usage/daemon.json | python3 -c 'import sys,json;print(json.load(sys.stdin)["pid"])')
sleep 3 && curl -s localhost:47291/health >/dev/null && echo "relaunched ✓"
```

Uninstall and check the round-trip:

```bash
cp ~/.claude/settings.json /tmp/settings.before   # take this BEFORE the first install
node bin/claude-usage uninstall
diff /tmp/settings.before ~/.claude/settings.json && echo "byte-identical ✓"
launchctl print gui/$UID/com.github.drmuzikbpn.claude-usage   # "Could not find service"
ls ~/Library/LaunchAgents/com.github.drmuzikbpn.claude-usage.plist   # No such file
claude mcp list | grep claude-usage || echo "mcp entry gone ✓"
ls ~/.config/claude-usage                        # still there — config is kept
```

Then `node bin/claude-usage uninstall --purge` and confirm `~/.config/claude-usage`,
`~/.local/share/claude-usage` and `~/Library/Logs/claude-usage` are gone.

## 2. Keychain (macOS) **(real HOME)**

The first credential read raises a system prompt. It must be announced first, and denying
it must not be fatal.

1. Reset the ACL so the prompt reappears (Keychain Access → login → `Claude Code-credentials`
   → Access Control → remove `claude-usage`/node), or test on a machine that has never run
   it.
2. `node bin/claude-usage install --yes` and watch for this line **before** any prompt:

   > macOS will now ask for permission to read the "Claude Code-credentials" Keychain item
   > — claude-usage reads the OAuth token to call GET /api/oauth/usage, and never stores or
   > prints it.

3. **Deny** the prompt. Expect preflight to print a `[warn] credentials:` line, install to
   continue, and:

   ```bash
   curl -s localhost:47291/v1/limits | python3 -m json.tool | head -20
   #   "error": { "code": "no_credentials", … }, "limits": []
   curl -s localhost:47291/v1/tokens | head -c 80    # spend still works
   ```

4. Re-run and **Allow**. Within one poll interval `/v1/limits` must carry a populated
   `limits[]` and `error: null`.
5. Grep the logs for leakage — this must print nothing:

   ```bash
   grep -aiE 'sk-ant|accessToken|refreshToken|Bearer [A-Za-z0-9._-]{20,}' \
     ~/Library/Logs/claude-usage/daemon.*.log
   ```

## 3. systemd user unit (Linux) **(real HOME)**

```bash
node bin/claude-usage install --yes --linger
systemctl --user status claude-usage --no-pager
#   Loaded: loaded (~/.config/systemd/user/claude-usage.service; enabled; …)
#   Active: active (running)

cat ~/.config/systemd/user/claude-usage.service
#   ExecStart=<abs node> <…>/current/bin/claude-usage serve
#   Environment=PATH=…   Restart=on-failure   RestartSec=5
#   [Install] WantedBy=default.target

loginctl show-user "$USER" | grep Linger      # Linger=yes
curl -s localhost:47291/health | head -c 60
journalctl --user -u claude-usage -n 20 --no-pager
```

Linger really works only if the daemon survives logout:

```bash
# from a second machine / tty, after logging out of every desktop session:
ssh you@host 'curl -s localhost:47291/health >/dev/null && echo alive'
```

If `loginctl` is missing, `--linger` must **report** and not fail:
`loginctl not found — lingering not enabled (the daemon stops at logout)`.

Port change restarts the unit:

```bash
node bin/claude-usage configure port 47300
#   port 47300
#   service unit rewritten and restarted
curl -s localhost:47300/health >/dev/null && echo "new port ✓"
node bin/claude-usage configure port 47291
```

Then `node bin/claude-usage uninstall` and check `systemctl --user status claude-usage`
reports `Unit claude-usage.service could not be found`, the unit file is gone, and
**`loginctl show-user "$USER" | grep Linger` still says `Linger=yes`** — uninstall never
touches lingering.

## 4. Tailscale bind + pairing from a second device

Needs two devices on one tailnet.

```bash
node bin/claude-usage configure          # or install --tailscale
# ensure config.bind is ["127.0.0.1", "tailscale"], then restart the service
node bin/claude-usage serve --verbose
#   claude-usage <name> listening on http://127.0.0.1:47291
#   claude-usage <name> listening on http://100.x.y.z:47291
#   net: MagicDNS name <host>.<tailnet>.ts.net
```

```bash
node bin/claude-usage configure pairing
#   {"v":1,"name":"alans-mbp","addr":"100.101.102.103","port":47291,"token":"…"}
#   <QR block>
node bin/claude-usage configure pairing --json    # JSON only, no QR
```

From the **second device** (phone on the tailnet, or another laptop):

```bash
TOKEN=…  ADDR=100.101.102.103
curl -s -o /dev/null -w '%{http_code}\n' http://$ADDR:47291/health
#   401   ← non-loopback GET needs the token
curl -s -H "Authorization: Bearer $TOKEN" http://$ADDR:47291/health | head -c 80
#   {"ok":true,…
curl -s -H "Authorization: Bearer wrong" -o /dev/null -w '%{http_code}\n' http://$ADDR:47291/health
#   401
curl -s -H "Authorization: Bearer $TOKEN" -H 'Origin: http://x' \
     -o /dev/null -w '%{http_code}\n' http://$ADDR:47291/health
#   403
curl -s -H "Authorization: Bearer $TOKEN" --resolve evil.test:47291:$ADDR \
     -o /dev/null -w '%{http_code}\n' http://evil.test:47291/health
#   421   ← Host allowlist; `curl --resolve` is the way to set a bogus Host,
#            because fetch() refuses to override it (see test/helpers/raw-request.ts)
curl -s -H "Authorization: Bearer $TOKEN" http://<magicdns-name>:47291/health | head -c 40
#   200 — the MagicDNS name is in the allowlist
```

SSE from the second device:

```bash
curl -sN -H "Authorization: Bearer $TOKEN" http://$ADDR:47291/v1/events | head -20
#   retry: 3000
#   id: N / event: snapshot / data: {"name":…,"sessions":[…],"rules":[…],"rev":N}
#   … then a heartbeat within 15 s
```

`SIGHUP` re-resolution — bring Tailscale down and back while the daemon runs:

```bash
sudo tailscale down && kill -HUP $(pgrep -f 'claude-usage serve')
#   http: stopped listening on 100.x.y.z:47291
sudo tailscale up   && kill -HUP $(pgrep -f 'claude-usage serve')
#   http: now also listening on 100.x.y.z:47291
#   net: MagicDNS name is now <host>.<tailnet>.ts.net
```

Token rotation invalidates the old pairing:

```bash
node bin/claude-usage configure rotate-token     # "bearer token rotated — re-pair every device"
# restart the daemon, then from the second device with the OLD token:
#   401
```

## 5. Hard freeze / resume against a real session

Use a **real** Claude Code session (the pid must be a live `claude` process with children).

```bash
node bin/claude-usage sessions
#   note the session id and pid of a live session

node bin/claude-usage pause session:<id> --hard --reason "smoke test"
#   paused session:<id> (hard) — rule r_…
#   affected: <id>

ps -o pid=,stat=,command= -p <pid> $(pgrep -P <pid>)
#   every line's STAT starts with T  (stopped) — on Linux, T as well
node bin/claude-usage sessions
#   pause column reads hard(N)
```

The session's terminal must be completely unresponsive while frozen. Resume:

```bash
node bin/claude-usage resume session:<id>
#   removed 1 rule(s); resumed <id>
ps -o pid=,stat= -p <pid>      # S / R again, and the session continues
```

**SIGCONT on clean shutdown.** Freeze again, then stop the daemon and confirm nothing stays
stopped:

```bash
node bin/claude-usage pause session:<id> --hard
launchctl kill SIGTERM gui/$UID/com.github.drmuzikbpn.claude-usage    # or: systemctl --user stop claude-usage
ps -o pid=,stat= -p <pid>      # NOT T — shutdown SIGCONTed it
```

**The escape hatch — `resume --all` with the daemon killed.** This is the one that must
never regress:

```bash
node bin/claude-usage pause session:<id> --hard
ps -o stat= -p <pid>                                   # S/R — the `claude` process keeps running
ps -o stat= -p <tool-pid>                              # T — a tool subprocess below it is stopped
kill -9 $(python3 -c 'import json;print(json.load(open("'$HOME'/.config/claude-usage/daemon.json"))["pid"])')
curl -s localhost:47291/health || echo "daemon gone ✓"
node bin/claude-usage resume --all
#   daemon not answering — resumed offline: N process(es), 1 rule(s) cleared
ps -o pid=,stat= -p <pid>                              # S/R — unfrozen with no daemon
python3 -c "import json;print(json.load(open('$HOME/.config/claude-usage/pause.json'))['rules'])"
#   []
```

**Orphan sweep on restart.** With the daemon still down, hand-edit `sessions.json` so a
session has `frozenPids` for a tool pid that matches no rule, `SIGSTOP` that pid yourself, then
start the daemon: the pid must be SIGCONTed within startup, and `sessions.json` must show
`frozenPids: []`.

**Refusals.** Against a `discovered: "transcript"` session (one that started while the
daemon was down):

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"hard"}' localhost:47291/v1/sessions/<transcript-id>/pause
#   409 conflict — "…has no trusted pid" / hint: use mode "soft"
```

**Soft pause.** Pause `all` softly, then type a prompt in a live session: the session must
stall at the boundary (the hook is sleeping), the status line must show
`⏸ paused from dashboard · 5h …`, and `~/.config/claude-usage/paused/<sessionId>` must
exist. `claude-usage resume all` → the session continues within ~1 s and the marker file
disappears. Kill the daemon while a session is soft-paused: the session must **continue**
(fail open), not wedge.

## 6. Auto-update and deferral

**Landing in the next merge** — run this section once `claude-usage update` / `rollback`
exist. Until then, only the first check applies.

- `curl -s localhost:47291/health | python3 -c 'import sys,json;print(json.load(sys.stdin)["update"])'`
  → today: `{'channel': 'stable', 'current': '0.1.0', 'available': None, 'state':
  'disabled', 'deferredReason': None}`.
- Point `autoUpdate.repo` at a scratch fork with one newer release, wait one
  `intervalMs`, and confirm: `versions/<new>/` appears, `current` repoints, the daemon
  restarts under launchd/systemd, and `claude-usage --version` reports the new version.
- Corrupt the published `SHA256SUMS` and confirm `update.state: "error"`, the download is
  deleted, and `current` does **not** move.
- **Deferral:** hard-freeze a session, then make a newer release available. `/health.update`
  must report `state: "deferred"`, `deferredReason: "hard_frozen_sessions"`, and the daemon
  must not restart. `claude-usage resume --all`, wait 30 s, and the update must proceed.
  Repeat with a *soft* pause — that must **not** defer.
- `claude-usage rollback` repoints `current` to the previous version and the daemon comes
  back on it. Only the previous two versions are kept.
- `claude-usage configure autoupdate off` — no further release checks. Install from a bare
  `npm i -g` with no `current` symlink — the updater disables itself automatically.

## 7. End-to-end sanity, after any of the above

```bash
node bin/claude-usage status        # daemon line, limits table, today's tokens
node bin/claude-usage tokens --since 7d --by project
node bin/claude-usage sessions
echo '{}' | node bin/claude-usage statusline      # "5h 42% · 7d 61%", or nothing
echo '{}' | node bin/claude-usage hook; echo "exit=$?"   # exit=0, always
```

With the daemon stopped, every one of those must be quiet and harmless: `status` prints
the service state and the last 20 stderr lines and exits 1; `hook` and `statusline` print
nothing and exit 0.
