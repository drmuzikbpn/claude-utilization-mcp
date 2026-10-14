#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
#
# public-check — refuse a commit that would publish something private.
#
# Reads the staged diff (added lines only) and exits 1 when it finds:
#
#   credential   private-key headers, vendor token prefixes, bearer-looking strings
#   email        an address that is not on the allowlist below
#   home-path    /Users/<name>/ or /home/<name>/ with a name that is not obviously fake
#   ipv4         an address outside loopback, the RFC 5737 documentation ranges and a
#                short allowlist of network bases
#   cgnat        anything inside the shared range 100.64/10 (what Tailscale hands out)
#   tailnet      a *.ts.net machine name
#   blocklist    a literal listed in the untracked .public-check.local
#   identity     an author or committer e-mail other than the project address
#
# Self-contained on purpose: bash 3.2, grep, sed, awk, tr, sort — nothing else — so the
# same file can be copied unchanged onto any branch. It contains generic patterns only;
# anything specific to one person belongs in .public-check.local, one literal per line
# (blank lines and # comments ignored), which is never committed.
#
# Usage:
#   scripts/public-check.sh                 check `git diff --cached` and the commit identity
#   scripts/public-check.sh --diff FILE     check a unified diff from FILE (- for stdin)
#
# Environment:
#   PUBLIC_CHECK_LOCAL   path of the private blocklist (default: .public-check.local in
#                        this worktree, else in the main worktree)
#   PUBLIC_CHECK_EMAIL   the only author/committer e-mail accepted
#   PUBLIC_CHECK_AUTHOR, PUBLIC_CHECK_COMMITTER
#                        override the identity read from git (used by the tests)
#
# One line can opt out of the email, home-path, ipv4, cgnat and tailnet rules by carrying
# the marker `public-check:allow`. The marker never excuses a credential or a blocklisted
# literal.

set -u
LC_ALL=C
export LC_ALL

PROJECT_EMAIL="${PUBLIC_CHECK_EMAIL:-support@evensealproductions.com}"
TAB="$(printf '\t')"
MARKER='public-check:allow'

# --- allowlists (generic by construction) ---------------------------------------------

# Whole-address patterns. Reserved example domains, vendor no-reply addresses, the
# project's own address, and the ssh remote spelling `git@host`.
EMAIL_ALLOW='(@example\.(test|com|org|net)$|@([a-z0-9-]+\.)*example\.(test|com|org|net)$|\.invalid$|^noreply@anthropic\.com$|^noreply@github\.com$|@users\.noreply\.github\.com$|^support@evensealproductions\.com$|^git@)'

# Names that can follow /Users/ or /home/ without naming anybody.
HOME_ALLOW='^(you|me|user|username|name|yourname|example|alice|bob|carol|dev|test|tester|someone|runner|Shared|shared|ubuntu|node|root|app|circleci|vagrant|linuxbrew)$'

# Loopback, RFC 5737, unspecified/broadcast/netmasks, and the base address of the ranges
# documentation has to be able to name (10/8, 172.16/12, 192.168/16, 100.64/10, …).
IPV4_ALLOW='^(127\.[0-9]+\.[0-9]+\.[0-9]+|192\.0\.2\.[0-9]+|198\.51\.100\.[0-9]+|203\.0\.113\.[0-9]+|0\.0\.0\.0|255\.255\.255\.255|255\.255\.255\.0|255\.255\.0\.0|255\.0\.0\.0|10\.0\.0\.0|172\.16\.0\.0|192\.168\.0\.0|100\.64\.0\.0|169\.254\.0\.0|224\.0\.0\.0|240\.0\.0\.0)$'
CGNAT='^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'

# The label directly in front of .ts.net when the name is a placeholder.
TAILNET_ALLOW='^(example|tailnet|your-tailnet|tailnet-name)\.ts\.net$'

# Paths where a long opaque string is expected: tests, lockfiles, checksum lists, vendored code.
OPAQUE_OK_PATH='(^|/)(test|tests|Tests|androidTest|__tests__|vendor|fixtures)/|[Tt]ests?\.(kt|kts|swift|java)$|\.(test|spec)\.[cm]?[jt]sx?$|(^|/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|gradle\.lockfile|Package\.resolved|SHA256SUMS)$|\.(svg|pbxproj|xcscheme|storyboard|xib)$'

# This script's own fixtures are deliberately full of offences.
SELF_FIXTURES='(^|/)fixtures/public-check/'

# --- input ---------------------------------------------------------------------------

mode=staged
diff_file=
while [ $# -gt 0 ]; do
  case "$1" in
    --diff)
      mode=file
      diff_file="${2:-}"
      shift
      ;;
    -h | --help)
      sed -n '4,36p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "public-check: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

work="$(mktemp -d "${TMPDIR:-/tmp}/public-check.XXXXXX")" || exit 2
trap 'rm -rf "$work"' EXIT HUP INT TERM

if [ "$mode" = file ]; then
  if [ -z "$diff_file" ]; then
    echo "public-check: --diff needs a file" >&2
    exit 2
  fi
  if [ "$diff_file" = - ]; then cat >"$work/diff"; else cat "$diff_file" >"$work/diff" || exit 2; fi
else
  git diff --cached --no-color --no-ext-diff -U0 --diff-filter=ACMR >"$work/diff" || exit 2
fi

# `path<TAB>added line`, one per added line. Header lines are told apart from content by
# position (between `diff --git` and the first `@@`), so content that itself starts with
# `++ ` is still content.
awk -v tab="$TAB" '
  /^diff --git / { hdr = 1; next }
  /^@@/ { hdr = 0; next }
  hdr && /^\+\+\+ / { f = $0; sub(/^\+\+\+ (b\/)?/, "", f); next }
  hdr { next }
  /^\+/ { print f tab substr($0, 2) }
' "$work/diff" >"$work/added"

failures=0
report() {
  # report <rule> <what> [<file list>]
  failures=$((failures + 1))
  if [ -n "${3:-}" ]; then
    echo "public-check: $1: $2  (in $3)" >&2
  else
    echo "public-check: $1: $2" >&2
  fi
}

files_with() {
  # files_with <view> <literal> — up to three paths that added the literal
  grep -F -- "$2" "$1" | cut -f1 | sort -u | head -3 | tr '\n' ' ' | sed 's/ $//'
}

redact() {
  printf '%s' "$1" | cut -c1-8 | sed 's/$/…/'
}

without_paths() {
  # without_paths <ERE> — drop the lines whose path column matches. The pattern travels
  # through the environment so awk does not re-interpret its backslashes.
  PUBLIC_CHECK_RE="$1" awk -F "$TAB" '$1 !~ ENVIRON["PUBLIC_CHECK_RE"]'
}

# Views: everything, minus our own fixtures, minus marker lines.
without_paths "$SELF_FIXTURES" <"$work/added" >"$work/checked"
grep -vF -- "$MARKER" "$work/checked" >"$work/unmarked" || true
cut -f2- "$work/checked" >"$work/checked.text"
cut -f2- "$work/unmarked" >"$work/unmarked.text"

# --- 1. private blocklist (applies everywhere, fixtures and marker lines included) -----

local_list="${PUBLIC_CHECK_LOCAL:-}"
if [ -z "$local_list" ] && [ "$mode" = staged ]; then
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  common="$(git rev-parse --git-common-dir 2>/dev/null || true)"
  if [ -n "$top" ] && [ -f "$top/.public-check.local" ]; then
    local_list="$top/.public-check.local"
  elif [ -n "$common" ] && [ -f "$common/../.public-check.local" ]; then
    local_list="$common/../.public-check.local"
  fi
fi
if [ -n "$local_list" ] && [ -f "$local_list" ]; then
  grep -vE '^[[:space:]]*(#|$)' "$local_list" >"$work/literals" || true
  if [ -s "$work/literals" ]; then
    n=0
    while IFS= read -r literal; do
      n=$((n + 1))
      if grep -qiF -- "$literal" "$work/added"; then
        # The literal is private: name its line in the list, never the word itself.
        report blocklist "entry $n of the private blocklist" "$(grep -iF -- "$literal" "$work/added" | cut -f1 | sort -u | head -3 | tr '\n' ' ' | sed 's/ $//')"
      fi
    done <"$work/literals"
  fi
fi

# --- 2. credentials --------------------------------------------------------------------

# Written so that none of these patterns matches its own source text.
if grep -qE -e '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----' "$work/checked.text"; then
  report credential 'a private-key header' "$(grep -E -e '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----' "$work/checked" | cut -f1 | sort -u | head -3 | tr '\n' ' ' | sed 's/ $//')"
fi

grep -oE '(sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})' "$work/checked.text" | sort -u >"$work/prefixed" || true
while IFS= read -r tok; do
  [ -n "$tok" ] || continue
  report credential "a vendor token ($(redact "$tok"))" "$(files_with "$work/checked" "$tok")"
done <"$work/prefixed"

# Bearer-looking strings: opaque 40+ character values handed to something named like a
# secret. Tests, lockfiles and checksum lists are full of such values by design.
without_paths "$OPAQUE_OK_PATH" <"$work/checked" >"$work/opaque"
cut -f2- "$work/opaque" >"$work/opaque.text"
grep -oiE "(bearer[ ]+|(token|secret|passw(or)?d|api[_-]?key)[a-z_]*[\"']?[ ]*[:=][ ]*[\"']?)[A-Za-z0-9._~+/=-]{40,}" "$work/opaque.text" | grep -E '[0-9]' | sort -u >"$work/bearer" || true
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  report credential "a bearer-looking value ($(redact "$hit"))" "$(files_with "$work/opaque" "$hit")"
done <"$work/bearer"

# Any other opaque 40+ run that mixes cases and digits. Pure hex is a digest or a commit
# id, not a bearer, and is left alone.
tr -c 'A-Za-z0-9_\n-' '\n' <"$work/opaque.text" | grep -E '^.{40,}$' | grep -vE '^[0-9a-fA-F]+$' | grep -E '[0-9]' | grep -E '[a-z]' | grep -E '[A-Z]' | sort -u >"$work/longtok" || true
while IFS= read -r tok; do
  [ -n "$tok" ] || continue
  report credential "a 40+ character opaque string ($(redact "$tok"))" "$(files_with "$work/opaque" "$tok")"
done <"$work/longtok"

# --- 3. e-mail addresses ---------------------------------------------------------------

# The domain must be lower-case: `this@Outer.member` in Kotlin is a label, not an address.
tr -c 'A-Za-z0-9._%+@\n-' '\n' <"$work/unmarked.text" | sed 's/^[^A-Za-z0-9]*//; s/[.]*$//' | grep -E '^[A-Za-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' | sort -u | grep -vE "$EMAIL_ALLOW" >"$work/emails" || true
while IFS= read -r addr; do
  [ -n "$addr" ] || continue
  report email "$addr" "$(files_with "$work/unmarked" "$addr")"
done <"$work/emails"

# --- 4. home-directory paths -----------------------------------------------------------

grep -oE '/(Users|home)/[A-Za-z0-9._-]+' "$work/unmarked.text" | sort -u >"$work/homes" || true
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  name="${hit##*/}"
  if ! printf '%s\n' "$name" | grep -qE "$HOME_ALLOW"; then
    report home-path "$hit/" "$(files_with "$work/unmarked" "$hit")"
  fi
done <"$work/homes"

# --- 5. IPv4 addresses -----------------------------------------------------------------

tr -c '0-9.\n' '\n' <"$work/unmarked.text" | sed 's/^[.]*//; s/[.]*$//' | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' | grep -vE '(^|\.)(25[6-9]|2[6-9][0-9]|[3-9][0-9][0-9])(\.|$)' | sort -u | grep -vE "$IPV4_ALLOW" >"$work/ips" || true
while IFS= read -r ip; do
  [ -n "$ip" ] || continue
  if printf '%s\n' "$ip" | grep -qE "$CGNAT"; then
    report cgnat "$ip is inside 100.64.0.0/10" "$(files_with "$work/unmarked" "$ip")"
  else
    report ipv4 "$ip" "$(files_with "$work/unmarked" "$ip")"
  fi
done <"$work/ips"

# --- 6. tailnet names ------------------------------------------------------------------

grep -oiE '[a-z0-9-]+\.ts\.net' "$work/unmarked.text" | sort -u | grep -viE "$TAILNET_ALLOW" >"$work/tsnet" || true
while IFS= read -r host; do
  [ -n "$host" ] || continue
  report tailnet "$host" "$(files_with "$work/unmarked" "$host")"
done <"$work/tsnet"

# --- 7. commit identity ----------------------------------------------------------------

ident_email() {
  # `Name <addr> 1700000000 +0000` → addr
  printf '%s\n' "$1" | sed -n 's/^.*<\([^>]*\)>.*$/\1/p'
}
author="${PUBLIC_CHECK_AUTHOR:-}"
committer="${PUBLIC_CHECK_COMMITTER:-}"
if [ "$mode" = staged ]; then
  [ -n "$author" ] || author="$(ident_email "$(git var GIT_AUTHOR_IDENT 2>/dev/null || true)")"
  [ -n "$committer" ] || committer="$(ident_email "$(git var GIT_COMMITTER_IDENT 2>/dev/null || true)")"
  [ -n "$author" ] || author='(unset)'
  [ -n "$committer" ] || committer='(unset)'
fi
if [ -n "$author" ] && [ "$author" != "$PROJECT_EMAIL" ]; then
  report identity "the author e-mail is not $PROJECT_EMAIL"
fi
if [ -n "$committer" ] && [ "$committer" != "$PROJECT_EMAIL" ]; then
  report identity "the committer e-mail is not $PROJECT_EMAIL"
fi

# --- 8. gitleaks, when it is installed -------------------------------------------------

if [ "$mode" = staged ] && command -v gitleaks >/dev/null 2>&1; then
  if ! gitleaks protect --staged --redact --no-banner >"$work/gitleaks" 2>&1; then
    failures=$((failures + 1))
    echo "public-check: credential: gitleaks found something in the staged changes" >&2
    sed 's/^/    /' "$work/gitleaks" >&2
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "public-check: $failures problem(s) — nothing was committed. See CONTRIBUTING.md, \"What may not be committed\"." >&2
  exit 1
fi
exit 0
