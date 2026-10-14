#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
#
# Commit-time check for a public repository: blocks a commit whose staged lines would publish a
# credential, a personal e-mail address, a home-directory path, a private or tailnet address, or
# that is authored under the wrong identity. Generic patterns only; nothing here names a real
# person, machine or address.
#
#   scripts/public-check.sh              check the staged diff and the commit identity (lefthook)
#   scripts/public-check.sh --self-test  prove each rule fires and each allowance holds
#
# Only added lines are checked, so text already in history is not re-litigated. A line that must
# stay (a documented false positive) can carry the marker  public-check:allow .
# An untracked .public-check.local at the repository root adds literal strings to block, one per
# line (blank lines and lines starting with # are ignored); matching is case-insensitive.
#
# POSIX sh + awk without regex intervals (macOS /bin/sh, bash 3.2 and BWK awk all run it).

IDENTITY="support@evensealproductions.com"

root="$(git rev-parse --show-toplevel 2>/dev/null)" || root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="${TMPDIR:-/tmp}/public-check.$$"
trap 'rm -f "$tmp" "$tmp.out" "$tmp.local"' EXIT INT TERM

# Staged added lines as "path<TAB>line<TAB>text".
staged_records() {
  git -c core.quotepath=off diff --cached --no-color --no-ext-diff -U0 --diff-filter=ACMR | awk '
    /^diff --git / { inhunk = 0; path = ""; next }
    !inhunk && /^\+\+\+ / { path = substr($0, 5); sub(/^b\//, "", path); next }
    /^@@ / { inhunk = 1; split($3, a, ","); line = substr(a[1], 2) + 0; next }
    inhunk && /^\+/ { if (path != "" && path != "/dev/null") printf "%s\t%d\t%s\n", path, line, substr($0, 2); line++ }
  '
}

# Reads records on stdin, prints one finding per line as "path:line: [rule] excerpt".
scan() {
  awk -F '\t' -v localfile="$1" '
    function report(rule, what) {
      printf "%s:%s: [%s] %s\n", $1, $2, rule, what
    }
    function endswith(s, t) {
      return length(s) >= length(t) && substr(s, length(s) - length(t) + 1) == t
    }
    function email_ok(e,    at, domain) {
      e = tolower(e)
      at = index(e, "@")
      domain = substr(e, at + 1)
      if (domain == "example.test" || endswith(domain, ".example.test")) return 1
      if (domain == "example.com" || endswith(domain, ".example.com")) return 1
      if (e == "noreply@anthropic.com" || e == "noreply@github.com" || e == "git@github.com") return 1
      if (endswith(e, "@users.noreply.github.com")) return 1
      if (e == "support@evensealproductions.com") return 1
      # icon@2x.png and friends are file names, not addresses.
      if (domain ~ /^[0-9]x\./) return 1
      return 0
    }
    function home_ok(name) {
      if (name ~ /^[$%{*]/) return 1
      return name == "Shared" || name == "runner" || name == "you" || name == "me" || name == "name" \
        || name == "user" || name == "username" || name == "yourname" || name == "example"
    }
    # 0 = fine, 1 = private or public address, 2 = carrier-grade NAT (tailnet) range.
    function ip_class(ip,    p, n, i) {
      n = split(ip, p, ".")
      if (n != 4) return 0
      for (i = 1; i <= 4; i++) if (length(p[i]) > 3 || p[i] + 0 > 255) return 0
      if (p[1] == 127) return 0
      if (p[1] == 192 && p[2] == 0 && p[3] == 2) return 0
      if (p[1] == 198 && p[2] == 51 && p[3] == 100) return 0
      if (p[1] == 203 && p[2] == 0 && p[3] == 113) return 0
      if (ip == "0.0.0.0" || ip == "255.255.255.255" || ip == "255.255.255.0" || ip == "1.2.3.4") return 0
      # The two sample devices the fixtures and the demo data already use.
      if (ip == "192.168.1.20" || ip == "192.168.1.31") return 0
      if (p[1] == 100 && p[2] + 0 >= 64 && p[2] + 0 <= 127) return 2
      return 1
    }
    function in_tests(path) {
      return path ~ /(^|\/)(Tests|Test|tests|test|Fixtures|fixtures|AppUITests|RenderTests)\//
    }
    BEGIN {
      nlocal = 0
      if (localfile != "") {
        while ((getline entry < localfile) > 0) {
          if (entry ~ /^[ \t]*$/ || entry ~ /^[ \t]*#/) continue
          locals[++nlocal] = tolower(entry)
        }
        close(localfile)
      }
    }
    {
      text = $3
      for (i = 4; i <= NF; i++) text = text "\t" $i
      if (index(text, "public-check:allow")) next

      # --- credentials ---
      if (text ~ /-----BEGIN [A-Z ]*PRIVATE KEY-----/) report("private-key", "a private key header")
      rest = text
      while (match(rest, /sk-ant-[A-Za-z0-9_-]+/)) {
        if (RLENGTH >= 24) report("credential", "an sk-ant- key")
        rest = substr(rest, RSTART + RLENGTH)
      }
      rest = text
      while (match(rest, /gh[pousr]_[A-Za-z0-9]+/)) {
        if (RLENGTH >= 30) report("credential", "a GitHub token")
        rest = substr(rest, RSTART + RLENGTH)
      }
      rest = text
      while (match(rest, /github_pat_[A-Za-z0-9_]+/)) {
        if (RLENGTH >= 40) report("credential", "a GitHub fine-grained token")
        rest = substr(rest, RSTART + RLENGTH)
      }
      if (!in_tests($1)) {
        rest = text
        while (match(rest, /[Bb]earer[ :=]+[A-Za-z0-9._~+\/=-]+/)) {
          value = substr(rest, RSTART, RLENGTH)
          sub(/^[Bb]earer[ :=]+/, "", value)
          if (length(value) >= 24) report("credential", "a bearer-looking value")
          rest = substr(rest, RSTART + RLENGTH)
        }
        rest = text
        while (match(rest, /([Tt]oken|[Ss]ecret|[Pp]assword|[Aa]pi[_-]?[Kk]ey)["\047 ]*[:=][ ]*["\047][A-Za-z0-9+\/_=-]+["\047]/)) {
          value = substr(rest, RSTART, RLENGTH)
          sub(/^[^:=]*[:=][ ]*["\047]/, "", value)
          if (length(value) >= 33) report("credential", "a long literal assigned to a secret-looking name")
          rest = substr(rest, RSTART + RLENGTH)
        }
      }

      # --- e-mail addresses ---
      rest = text
      while (match(rest, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z][A-Za-z]+/)) {
        found = substr(rest, RSTART, RLENGTH)
        if (!email_ok(found)) report("email", found)
        rest = substr(rest, RSTART + RLENGTH)
      }

      # --- home-directory paths ---
      rest = text
      while (match(rest, /\/(Users|home)\/[^\/ \t"\047<>()|,;:]+\//)) {
        found = substr(rest, RSTART, RLENGTH)
        name = found
        sub(/^\/(Users|home)\//, "", name)
        sub(/\/$/, "", name)
        if (!home_ok(name)) report("home-path", found)
        rest = substr(rest, RSTART + RLENGTH)
      }

      # --- IPv4 addresses ---
      rest = text
      before = ""
      while (match(rest, /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/)) {
        found = substr(rest, RSTART, RLENGTH)
        prev = RSTART > 1 ? substr(rest, RSTART - 1, 1) : before
        after = substr(rest, RSTART + RLENGTH, 2)
        # Part of a longer dotted number (a version, an OID): not an address.
        if (prev !~ /[0-9.]/ && after !~ /^\.[0-9]/) {
          class = ip_class(found)
          if (class == 1) report("ipv4", found " (use 192.0.2.x, 198.51.100.x or 203.0.113.x)")
          if (class == 2) report("tailnet-address", found " (carrier-grade NAT range, used by tailnets)")
        }
        before = substr(rest, RSTART + RLENGTH - 1, 1)
        rest = substr(rest, RSTART + RLENGTH)
      }

      # --- tailnet names ---
      rest = text
      while (match(rest, /[A-Za-z0-9-]+\.ts\.net/)) {
        report("tailnet-name", substr(rest, RSTART, RLENGTH))
        rest = substr(rest, RSTART + RLENGTH)
      }

      # --- extra literals from .public-check.local ---
      lowered = tolower($1 " " text)
      for (i = 1; i <= nlocal; i++) if (index(lowered, locals[i])) report("local-blocklist", "a string listed in .public-check.local")
    }
  '
}

identity_findings() {
  for which in AUTHOR COMMITTER; do
    ident="$(git var "GIT_${which}_IDENT" 2>/dev/null)" || continue
    email="$(printf '%s\n' "$ident" | sed -n 's/^.*<\([^>]*\)>.*$/\1/p')"
    if [ "$email" != "$IDENTITY" ]; then
      lower="$(printf '%s' "$which" | tr 'A-Z' 'a-z')"
      echo "identity: [$lower-email] this commit's $lower e-mail is not $IDENTITY"
    fi
  done
}

self_test() {
  failures=0
  expect() { # $1 description, $2 expected rule ("" = clean), $3 path, $4 text
    printf '%s\t1\t%s\n' "$3" "$4" > "$tmp"
    got="$(scan "${5:-}" < "$tmp")"
    if [ -z "$2" ]; then
      [ -z "$got" ] || { echo "self-test FAILED (expected clean): $1 -> $got"; failures=$((failures + 1)); }
    else
      case "$got" in
        *"[$2]"*) ;;
        *) echo "self-test FAILED (expected $2): $1 -> ${got:-nothing}"; failures=$((failures + 1)) ;;
      esac
    fi
  }
  # Offending samples are assembled here so this file never contains one.
  fill="AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd"
  dash="-----"
  at="@"
  users="/Us""ers/"
  homes="/ho""me/"
  net=".ts"".net"

  expect "private key header" private-key src/a.txt "${dash}BEGIN EC PRIVATE KEY${dash}"
  expect "anthropic key" credential src/a.txt "key = sk-""ant-$fill"
  expect "github token" credential src/a.txt "gh""p_$fill"
  expect "github fine-grained token" credential src/a.txt "github""_pat_${fill}_$fill"
  expect "bearer value" credential src/a.swift "Authorization: Bear""er $fill"
  expect "bearer value in a test constant" "" Tests/a.swift "Authorization: Bear""er $fill"
  expect "bearer interpolation" "" src/a.swift 'request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")'
  expect "secret-looking literal" credential src/a.swift "let tok""en = \"$fill\""
  expect "personal e-mail" email docs/a.md "write to someone${at}mail.invalid.org"
  expect "example e-mail" "" docs/a.md "write to someone${at}example.test or a${at}example.com"
  expect "identity e-mail" "" docs/a.md "support${at}evensealproductions.com and noreply${at}anthropic.com"
  expect "github noreply" "" docs/a.md "1234+someone${at}users.noreply.github.com"
  expect "image scale suffix" "" a.json "\"filename\": \"icon${at}2x.png\""
  expect "mac home path" home-path docs/a.md "see ${users}somebody/code/x"
  expect "linux home path" home-path docs/a.md "see ${homes}somebody/code/x"
  expect "placeholder home path" "" docs/a.md "see ${users}you/code and ${homes}runner/work and ${users}<name>/x"
  expect "private address" ipv4 src/a.swift "addr: \"10"".1.2"".3\""
  expect "public address" ipv4 src/a.swift "addr: \"8"".8.4"".4\""
  expect "tailnet address" tailnet-address src/a.swift "addr: \"100"".100.1"".2\""
  expect "documentation and loopback addresses" "" src/a.swift "192.0"".2.10 198.51"".100.7 203.0"".113.9 127.0"".0.1"
  expect "a dotted version" "" src/a.swift "version 1.2"".3.4.5 and 10.20"".30.40.50"
  expect "tailnet name" tailnet-name docs/a.md "host box.tail0000${net}"
  expect "allow marker" "" docs/a.md "addr 10"".1.2"".3 public-check:allow"
  printf '# comment\n\nSecretProject\n' > "$tmp.local"
  expect "local blocklist" local-blocklist docs/a.md "about the secretproject launch" "$tmp.local"
  expect "local blocklist miss" "" docs/a.md "about nothing in particular" "$tmp.local"

  if [ "$failures" -gt 0 ]; then
    echo "public-check self-test: $failures failure(s)"
    exit 1
  fi
  echo "public-check self-test: ok"
  exit 0
}

[ "${1:-}" = "--self-test" ] && self_test

status=0
localfile=""
[ -f "$root/.public-check.local" ] && localfile="$root/.public-check.local"
staged_records > "$tmp"
{ scan "$localfile" < "$tmp"; identity_findings; } > "$tmp.out"
if [ -s "$tmp.out" ]; then
  echo "public-check: this commit would publish something it should not:"
  sed 's/^/  /' "$tmp.out"
  echo "Replace it with a made-up value (example.test, 192.0.2.x, /Users/you/), or mark a real"
  echo "false positive with  public-check:allow  on that line."
  status=1
fi
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks protect --staged --redact --no-banner >/dev/null 2>&1 || {
    echo "public-check: gitleaks found a credential in the staged changes (run: gitleaks protect --staged --redact)"
    status=1
  }
fi
exit "$status"
