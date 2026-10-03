#!/bin/sh
# pre-push (lefthook): MARKETING_VERSION must be the App Store version that is waiting for a build.
# Blocks only on a real mismatch. Without 1Password, the Python dependency or a network it says so
# and lets the push through: a hook that cannot check must not stop work.
cd "$(dirname "$0")/.." || exit 0
skip() { echo "version check skipped: $1"; exit 0; }
command -v op >/dev/null 2>&1 || skip "the 1Password CLI (op) is not installed"
python3 -c 'import cryptography' 2>/dev/null || skip "python3 has no 'cryptography' module"
op run --env-file .env.tmpl -- python3 ci/asc.py version
case $? in
  0) exit 0 ;;
  3) exit 1 ;;
  *) skip "could not ask App Store Connect" ;;
esac
