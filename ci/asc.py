#!/usr/bin/env python3
"""App Store Connect helpers for CI. The key comes from the environment and is never printed.

  ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8   (GitHub secrets, sourced from 1Password usagedeck/usage-ios-ci)

usage:
  ci/asc.py profiles "UsageDeck AppStore" "UsageWidgets AppStore" ...   install App Store profiles by name
"""

import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

API = "https://api.appstoreconnect.apple.com"
PROFILE_DIRS = [
    os.path.expanduser("~/Library/Developer/Xcode/UserData/Provisioning Profiles"),
    os.path.expanduser("~/Library/MobileDevice/Provisioning Profiles"),
]


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def token() -> str:
    pem = os.environ["ASC_KEY_P8"].strip().encode() + b"\n"
    key = serialization.load_pem_private_key(pem, password=None)
    header = {"alg": "ES256", "kid": os.environ["ASC_KEY_ID"], "typ": "JWT"}
    now = int(time.time())
    claims = {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 600, "aud": "appstoreconnect-v1"}
    signing_input = f"{b64(json.dumps(header).encode())}.{b64(json.dumps(claims).encode())}".encode()
    r, s = decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
    return signing_input.decode() + "." + b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


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


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] != "profiles":
        sys.exit(__doc__)
    install_profiles(sys.argv[2:])
