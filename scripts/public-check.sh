#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
#
# Commit-time guard for a public repository. Reads the lines a commit ADDS and refuses the commit
# when one of them looks like something that must not be published:
#
#   - a credential: private-key header, vendor token prefix, or a long bearer-looking string
#     (plus `gitleaks protect --staged` when gitleaks is installed)
#   - an e-mail address that is not on the allowlist below
#   - a home-directory path with a real-looking account name
#   - an IPv4 address outside loopback, the emulator's host alias and the documentation ranges
#   - a carrier-grade-NAT (tailnet) address, or a tailnet host name
#   - any literal listed in the untracked `.public-check.local` (one per line, `#` comments)
#
# and when the commit's author or committer e-mail is not the project's.
#
#   scripts/public-check.sh               check the staged diff (the pre-commit hook)
#   scripts/public-check.sh --diff A..B   check the lines added by a commit range
#   scripts/public-check.sh --self-test   run the built-in examples
#
# Generic patterns only: nothing here names a person, a machine or an address. Works with the
# bash 3.2 that macOS ships; needs only git, awk, grep and sed.
set -u

PROJECT_EMAIL='support@evensealproductions.com'

# Lines are "path:line:text". Paths that hold fixtures and tests may carry made-up bearer strings.
TEST_PATHS='(^|/)(src/(test|androidTest)/|fixtures/|[A-Za-z0-9_]+Test\.kt:)'

EMAIL_RE='[A-Za-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}'
EMAIL_OK='(@example\.(test|com|org|net)$|^noreply@anthropic\.com$|@users\.noreply\.github\.com$|^noreply@github\.com$|^git@github\.com$|^support@evensealproductions\.com$)'
# Not addresses: Kotlin labels (`this@Outer.x`) and density-suffixed file names (`icon@2x.png`).
EMAIL_NOT='(^(this|super|return|break|continue)@|@[0-9]x\.)'

HOME_RE='/(Users|home)/[A-Za-z0-9._-]+/'
HOME_OK='^/(Users|home)/(you|me|name|user|username|example|runner|Shared)/$'

IPV4_RE='(^|[^0-9.])[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}($|[^0-9.])'
# Loopback, unspecified, broadcast, the emulator's alias for its host, RFC 5737 documentation nets.
IPV4_OK='^(127\.[0-9]+\.[0-9]+\.[0-9]+|0\.0\.0\.0|255\.255\.255\.255|10\.0\.2\.2|192\.0\.2\.[0-9]+|198\.51\.100\.[0-9]+|203\.0\.113\.[0-9]+)$'
CGNAT_RE='^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'
# Generated checksum files hold dotted version numbers, never addresses.
IPV4_SKIP_PATHS='^gradle/verification-metadata\.xml:'

TAILNET_RE='[A-Za-z0-9-]+\.ts\.net'

failures=0

report() {
  # $1 rule, $2 offending token, $3 "path:line"
  printf 'public-check: %s: %s  (%s)\n' "$1" "$2" "$3" >&2
  failures=$((failures + 1))
}

# Prints "path:line:text" for every added line of a unified diff on stdin.
added_lines() {
  awk '
    /^\+\+\+ / { file = substr($0, 5); sub(/^b\//, "", file); next }
    /^--- / { next }
    /^@@ / {
      split($3, range, ",")
      line = substr(range[1], 2) + 0
      next
    }
    /^\+/ { print file ":" line ":" substr($0, 2); line++; next }
    /^ / { line++ }
  '
}

# Applies one extended regex to the added lines and reports every match the filter does not excuse.
#   $1 rule name   $2 regex   $3 allow regex applied to the match ("" = none)
#   $4 regex of matches that are not the thing at all ("" = none)   $5 regex of lines to skip ("" = none)
scan() {
  rule=$1
  regex=$2
  allow=$3
  not=$4
  skip=$5
  source_lines=$ADDED
  if [ -n "$skip" ]; then
    source_lines=$(printf '%s\n' "$ADDED" | grep -Ev -- "$skip")
  fi
  printf '%s\n' "$source_lines" | grep -E -- "$regex" | while IFS= read -r hit; do
    where=$(printf '%s' "$hit" | cut -d: -f1-2)
    text=$(printf '%s' "$hit" | cut -d: -f3-)
    printf '%s\n' "$text" | grep -Eo -- "$regex" | while IFS= read -r token; do
      if [ -n "$not" ] && printf '%s' "$token" | grep -Eq -- "$not"; then continue; fi
      if [ -n "$allow" ] && printf '%s' "$token" | grep -Eq -- "$allow"; then continue; fi
      printf '%s\t%s\t%s\n' "$rule" "$token" "$where"
    done
  done
}

check_lines() {
  findings=$(
    scan 'private key' '-----BEGIN [A-Z ]*PRIVATE KEY-----' '' '' ''
    scan 'vendor token' '(sk-ant-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})' '' '' ''
    scan 'bearer-looking string' '[Bb]earer[ :=]+[A-Za-z0-9._~+/-]{24,}' '' '' "$TEST_PATHS"
    scan 'e-mail address' "$EMAIL_RE" "$EMAIL_OK" "$EMAIL_NOT" ''
    scan 'home directory path' "$HOME_RE" "$HOME_OK" '' ''
    scan 'tailnet host name' "$TAILNET_RE" '' '' ''
  )
  ips=$(
    printf '%s\n' "$ADDED" | grep -Ev -- "$IPV4_SKIP_PATHS" | grep -E -- "$IPV4_RE" | while IFS= read -r hit; do
      where=$(printf '%s' "$hit" | cut -d: -f1-2)
      printf '%s\n' "$hit" | cut -d: -f3- | grep -Eo '[0-9]{1,3}(\.[0-9]{1,3})+' |
        grep -E '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$' | while IFS= read -r ip; do
        if printf '%s' "$ip" | grep -Eq -- "$CGNAT_RE"; then
          printf '%s\t%s\t%s\n' 'carrier-grade-NAT (tailnet) address' "$ip" "$where"
        elif ! printf '%s' "$ip" | grep -Eq -- "$IPV4_OK"; then
          printf '%s\t%s\t%s\n' 'IPv4 address' "$ip" "$where"
        fi
      done
    done
  )
  locals=''
  if [ -n "${LOCAL_LIST:-}" ] && [ -f "$LOCAL_LIST" ]; then
    locals=$(
      grep -v '^[[:space:]]*#' "$LOCAL_LIST" | grep -v '^[[:space:]]*$' | while IFS= read -r literal; do
        printf '%s\n' "$ADDED" | grep -Fi -- "$literal" | while IFS= read -r hit; do
          # The literal itself is not echoed: the list is private.
          printf '%s\t%s\t%s\n' 'locally blocked string' '(see .public-check.local)' \
            "$(printf '%s' "$hit" | cut -d: -f1-2)"
        done
      done
    )
  fi
  all=$(printf '%s\n%s\n%s\n' "$findings" "$ips" "$locals" | grep -v '^$')
  [ -z "$all" ] && return 0
  old_ifs=$IFS
  IFS='
'
  for row in $all; do
    report "$(printf '%s' "$row" | cut -f1)" "$(printf '%s' "$row" | cut -f2)" "$(printf '%s' "$row" | cut -f3)"
  done
  IFS=$old_ifs
}

check_identity() {
  for which in AUTHOR COMMITTER; do
    ident=$(git var "GIT_${which}_IDENT" 2>/dev/null) || continue
    email=$(printf '%s' "$ident" | sed -n 's/.*<\(.*\)>.*/\1/p')
    if [ "$email" != "$PROJECT_EMAIL" ]; then
      report "$(printf '%s' "$which" | tr '[:upper:]' '[:lower:]') e-mail is not $PROJECT_EMAIL" '(git identity)' 'git config user.email'
    fi
  done
}

self_test() {
  LOCAL_LIST=$(mktemp)
  printf '# comment\nzzlocalliteral\n' > "$LOCAL_LIST"
  status=0
  expect() {
    # $1 "block" or "pass", $2 path, $3 text
    ADDED="$2:1:$3"
    failures=0
    check_lines 2>/dev/null
    if { [ "$1" = block ] && [ "$failures" -eq 0 ]; } || { [ "$1" = pass ] && [ "$failures" -ne 0 ]; }; then
      printf 'self-test FAILED: expected %s for: %s\n' "$1" "$3" >&2
      status=1
    fi
  }
  # Offending samples are assembled here so this file never contains one.
  at='@'
  dash5='-----'
  expect block a.md "${dash5}BEGIN EC PRIVATE KEY${dash5}"
  expect block a.md "key = sk-""ant-abcdefgh12345678"
  expect block a.md "gh""p_abcdefghijklmnopqrstuvwxyz0123"
  expect block a.md "github""_pat_abcdefghijklmnopqrstuvwxyz"
  expect block a.kt "Authorization: Bear""er abcdefghijklmnopqrstuvwxyz012345"
  expect pass core/src/test/kotlin/XTest.kt "Authorization: Bear""er abcdefghijklmnopqrstuvwxyz012345"
  expect pass a.kt 'header("Authorization", "Bearer ${config.token}")'
  expect block a.md "write to someone${at}somewhere.io"
  expect pass a.md "write to dev${at}example.test and ${PROJECT_EMAIL}"
  expect pass a.md "Co-Authored-By: X <noreply${at}anthropic.com>"
  expect pass a.md "1234+octo${at}users.noreply.github.com"
  expect pass a.kt "val s = this${at}Outer.state"
  expect pass a.yml "uses: actions/checkout${at}0123456789abcdef0123456789abcdef01234567 # v4.2.2"
  expect block a.md "/Us""ers/jsmith/code"
  expect block a.md "/ho""me/jsmith/.config"
  expect pass a.md "/Us""ers/you/code and /ho""me/runner/work"
  expect pass a.md "/Users/<name>/code"
  expect block a.md "addr 192.168"".1.20"
  expect block a.md "addr 8.8"".8.8"
  expect block a.md "addr 100.64"".0.1"
  expect block a.md "addr 100.127"".255.1"
  expect pass a.md "127.0.0.1 10.0.2.2 192.0.2.7 198.51.100.7 203.0.113.7 0.0.0.0"
  expect pass a.md "gradle 8.10.2 and agp 8.7.3"
  expect pass gradle/verification-metadata.xml "version=\"1.2"".3.4\""
  expect block a.md "host mybox.tail0abc"".ts.net"
  expect block a.md "the ZZLocalLiteral value"
  expect pass a.md "nothing to see"
  rm -f "$LOCAL_LIST"
  if [ "$status" -eq 0 ]; then echo 'public-check self-test: ok'; fi
  return "$status"
}

case "${1:-}" in
  --self-test)
    self_test
    exit $?
    ;;
  --diff)
    [ -n "${2:-}" ] || { echo 'usage: public-check.sh --diff <range>' >&2; exit 2; }
    ADDED=$(git diff --no-color --no-ext-diff -U0 "$2" | added_lines)
    ;;
  '')
    ADDED=$(git diff --cached --no-color --no-ext-diff -U0 | added_lines)
    check_identity
    if command -v gitleaks >/dev/null 2>&1; then
      if ! gitleaks protect --staged --no-banner --redact >/dev/null 2>&1; then
        report 'gitleaks' 'run: gitleaks protect --staged --redact -v' 'staged diff'
      fi
    fi
    ;;
  *)
    echo 'usage: public-check.sh [--self-test | --diff <range>]' >&2
    exit 2
    ;;
esac

root=$(git rev-parse --show-toplevel 2>/dev/null) || root=.
LOCAL_LIST="$root/.public-check.local"
check_lines

if [ "$failures" -ne 0 ]; then
  printf 'public-check: %d finding(s). Nothing was committed.\n' "$failures" >&2
  exit 1
fi
exit 0
