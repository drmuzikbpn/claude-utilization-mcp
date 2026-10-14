#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
# pre-push (lefthook): MARKETING_VERSION must be the App Store version that is waiting for a build.
# Blocks only on a real mismatch. Without 1Password, openssl or a network it says so
# and lets the push through: a hook that cannot check must not stop work.
cd "$(dirname "$0")/.." || exit 0
skip() { echo "version check skipped: $1"; exit 0; }
command -v op >/dev/null 2>&1 || skip "the 1Password CLI (op) is not installed"
command -v openssl >/dev/null 2>&1 || skip "openssl is not installed"
# ci/asc.env.tmpl holds only the three App Store Connect references; the distribution
# certificate in .env.tmpl is never loaded here.
op run --env-file ci/asc.env.tmpl -- python3 ci/asc.py version
case $? in
  0) exit 0 ;;
  3) exit 1 ;;
  *) skip "could not ask App Store Connect" ;;
esac
