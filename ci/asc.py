#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
"""App Store Connect helpers for CI. The key comes from the environment and is never printed.

  ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8   (the workflow's `release` environment; kept in 1Password)

Standard library only: the token is signed through the system's openssl (ci/es256.py).

usage:
  ci/asc.py profiles "UsageDeck AppStore" "UsageWidgets AppStore" ...   install App Store profiles by name
  ci/asc.py version                                                      MARKETING_VERSION matches the App Store version awaiting a build
"""

import base64
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import es256  # noqa: E402

API = "https://api.appstoreconnect.apple.com"
APP_ID = "6818383053"
# The states in which an App Store version still takes a build.
OPEN_STATES = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"}
# check_version's exit code for a real mismatch; anything else non-zero means "could not check".
MISMATCH = 3
PROFILE_DIRS = [
    os.path.expanduser("~/Library/Developer/Xcode/UserData/Provisioning Profiles"),
    os.path.expanduser("~/Library/MobileDevice/Provisioning Profiles"),
]


def token() -> str:
    now = int(time.time())
    claims = {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"}
    return es256.jwt(claims, os.environ["ASC_KEY_ID"], os.environ["ASC_KEY_P8"])


def get(path: str) -> dict:
    req = urllib.request.Request(API + path)
    req.add_header("Authorization", "Bearer " + token())
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def install_profiles(names: list[str]) -> None:
    for directory in PROFILE_DIRS:
        os.makedirs(directory, exist_ok=True)
    for name in names:
        query = urllib.parse.urlencode({"filter[name]": name, "filter[profileState]": "ACTIVE"})
        data = get(f"/v1/profiles?{query}")["data"]
        if not data:
            sys.exit(f"no active profile named {name!r}")
        attributes = data[0]["attributes"]
        content = base64.b64decode(attributes["profileContent"])
        for directory in PROFILE_DIRS:
            with open(os.path.join(directory, attributes["uuid"] + ".mobileprovision"), "wb") as f:
                f.write(content)
        print(f"installed {name} ({attributes['uuid']}, expires {attributes['expirationDate']})")


def marketing_version() -> str:
    spec = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "project.yml")
    with open(spec) as f:
        match = re.search(r'^\s*MARKETING_VERSION:\s*"?([^"\s]+)"?\s*$', f.read(), re.MULTILINE)
    if not match:
        sys.exit("no MARKETING_VERSION in project.yml")
    return match.group(1)


def check_version() -> None:
    """A build can only be attached to the App Store version whose number it carries."""
    local = marketing_version()
    query = urllib.parse.urlencode({"filter[platform]": "IOS", "fields[appStoreVersions]": "versionString,appStoreState"})
    versions = [v["attributes"] for v in get(f"/v1/apps/{APP_ID}/appStoreVersions?{query}")["data"]]
    waiting = [v["versionString"] for v in versions if v["appStoreState"] in OPEN_STATES]
    if not waiting:
        print(f"MARKETING_VERSION {local}: no App Store version is waiting for a build")
    elif local in waiting:
        print(f"MARKETING_VERSION {local} matches the App Store version awaiting a build")
    else:
        print(
            f"MARKETING_VERSION is {local} but App Store Connect is waiting for a build of {', '.join(waiting)}.\n"
            "Builds of any other version cannot be attached to it. Change MARKETING_VERSION in project.yml,\n"
            "or rename the version in App Store Connect."
        )
        sys.exit(MISMATCH)


if __name__ == "__main__":
    if sys.argv[1:] == ["version"]:
        check_version()
    elif len(sys.argv) >= 3 and sys.argv[1] == "profiles":
        install_profiles(sys.argv[2:])
    else:
        sys.exit(__doc__)
