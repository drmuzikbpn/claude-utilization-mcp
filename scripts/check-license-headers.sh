#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
#
# Every source file carries the licence header in its first lines. With file arguments it checks
# those (lefthook passes the staged ones); with none it checks every tracked source file (CI).
# Exits 1 and names each file that lacks the header.
cd "$(dirname "$0")/.." || exit 2

is_source() {
  case "$1" in
    *.swift | *.sh | *.py | *.yml | *.yaml) return 0 ;;
    *) return 1 ;;
  esac
}

missing=0
check() {
  is_source "$1" || return 0
  [ -f "$1" ] || return 0
  top="$(head -n 6 "$1")"
  case "$top" in
    *"SPDX-License-Identifier: MIT"*) ;;
    *) echo "missing licence header (SPDX line): $1"; missing=1; return 0 ;;
  esac
  case "$top" in
    *"Copyright (c) 2026 Even Seal Productions"*) ;;
    *) echo "missing licence header (copyright line): $1"; missing=1 ;;
  esac
}

if [ "$#" -gt 0 ]; then
  for f in "$@"; do check "$f"; done
else
  git ls-files > "${TMPDIR:-/tmp}/license-check.$$"
  while IFS= read -r f; do check "$f"; done < "${TMPDIR:-/tmp}/license-check.$$"
  rm -f "${TMPDIR:-/tmp}/license-check.$$"
fi
exit "$missing"
