#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Even Seal Productions
"""ES256 JSON Web Tokens with nothing but the standard library and the system's openssl.

App Store Connect wants a JWT signed with an EC P-256 key. Rather than install a crypto package
in CI (an unpinned dependency next to the signing key), the signature comes from `openssl dgst`,
which every macOS runner has, and the two formats are converted here.

The private key is handed to openssl on its standard input; it is never written to disk and
never appears in an argument list.

  python3 ci/es256.py --self-test     sign with a throwaway key and verify the result
"""

import base64
import json
import os
import subprocess
import sys
import tempfile


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def der_to_raw(der: bytes) -> bytes:
    """An ASN.1 ECDSA signature (SEQUENCE of two INTEGERs) as the 64-byte r||s that JWS uses."""

    def length(at: int) -> tuple[int, int]:
        first = der[at]
        if first < 0x80:
            return first, at + 1
        count = first & 0x7F
        return int.from_bytes(der[at + 1 : at + 1 + count], "big"), at + 1 + count

    def integer(at: int) -> tuple[int, int]:
        if der[at] != 0x02:
            raise ValueError("not an ECDSA signature")
        size, at = length(at + 1)
        return int.from_bytes(der[at : at + size], "big"), at + size

    if not der or der[0] != 0x30:
        raise ValueError("not an ECDSA signature")
    _, at = length(1)
    r, at = integer(at)
    s, at = integer(at)
    if at != len(der):
        raise ValueError("trailing bytes after the signature")
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def sign(message: bytes, private_key_pem: str) -> bytes:
    """ECDSA P-256 / SHA-256 over `message`, as raw r||s."""
    with tempfile.NamedTemporaryFile(prefix="es256-", suffix=".msg") as data:
        data.write(message)
        data.flush()
        result = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", "/dev/stdin", data.name],
            input=private_key_pem.strip().encode() + b"\n",
            capture_output=True,
            check=False,
        )
    if result.returncode != 0:
        # openssl's own message can quote what it was given; say only that it failed.
        raise RuntimeError("openssl could not sign with the given key")
    return der_to_raw(result.stdout)


def jwt(claims: dict, key_id: str, private_key_pem: str) -> str:
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    signing_input = f"{b64url(json.dumps(header).encode())}.{b64url(json.dumps(claims).encode())}"
    return signing_input + "." + b64url(sign(signing_input.encode(), private_key_pem))


def self_test() -> None:
    def run(*args: str, **kwargs) -> bytes:
        return subprocess.run(args, capture_output=True, check=True, **kwargs).stdout

    # A known DER signature with a leading-zero r and a short s.
    r = bytes([0x80]) + bytes(31)
    s = bytes([0x01])
    der = bytes([0x30, 38, 0x02, 33, 0x00]) + r + bytes([0x02, 1]) + s
    assert der_to_raw(der) == r + bytes(31) + s, "DER to raw"

    with tempfile.TemporaryDirectory() as folder:
        ec = os.path.join(folder, "ec.pem")
        run("openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", ec)
        pem = run("openssl", "pkcs8", "-topk8", "-nocrypt", "-in", ec).decode()
        pub = os.path.join(folder, "pub.pem")
        run("openssl", "ec", "-in", ec, "-pubout", "-out", pub)

        token = jwt({"iss": "issuer", "aud": "appstoreconnect-v1"}, "KEYID12345", pem)
        head, body, signature = token.split(".")
        assert json.loads(base64.urlsafe_b64decode(head + "==")) == {"alg": "ES256", "kid": "KEYID12345", "typ": "JWT"}
        raw = base64.urlsafe_b64decode(signature + "==")
        assert len(raw) == 64, "signature is r||s"

        def der_int(value: bytes) -> bytes:
            value = value.lstrip(b"\x00") or b"\x00"
            if value[0] & 0x80:
                value = b"\x00" + value
            return bytes([0x02, len(value)]) + value

        sequence = der_int(raw[:32]) + der_int(raw[32:])
        sig = os.path.join(folder, "sig.der")
        with open(sig, "wb") as f:
            f.write(bytes([0x30, len(sequence)]) + sequence)
        msg = os.path.join(folder, "msg")
        with open(msg, "wb") as f:
            f.write(f"{head}.{body}".encode())
        verified = subprocess.run(
            ["openssl", "dgst", "-sha256", "-verify", pub, "-signature", sig, msg], capture_output=True, check=False
        )
        assert verified.returncode == 0, "openssl does not verify the token's signature"

        try:
            sign(b"x", "not a key")
        except RuntimeError as error:
            assert "not a key" not in str(error)
        else:
            raise AssertionError("a bad key signed")
    print("es256 self-test: ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        sys.exit(__doc__)
