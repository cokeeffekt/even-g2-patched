#!/usr/bin/env python3
"""
Replace the news feed base URL in libapp.so.

The original URL `https://api2.evenreal.co` (24 chars) is stored as a Dart
single-byte string in the AOT object pool, preceded by a one-byte length tag
(0xb0 = (24 << 1) | 0x80). To avoid shifting any subsequent pointers, the
replacement URL MUST be exactly 24 characters.

The app appends paths like `/v2/g/news_list`, `/v2/g/news_sources`, etc. to
this base, so your server only needs to implement those routes.

Target offset (v2.2.2 build 112): file offset 0x1cbf47 (the 'h' of 'https://').
"""
import argparse
from pathlib import Path
import sys

EXPECTED_URL = b"https://api2.evenreal.co"
URL_LEN      = len(EXPECTED_URL)  # 24
EXPECTED_OFF = 0x1cbf47           # the 'h' of 'https://'
LEN_BYTE_OFF = EXPECTED_OFF - 1   # the Dart string length tag
EXPECTED_LEN_BYTE = (URL_LEN << 1) | 0x80  # 0xb0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input",  required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--url",    required=True,
                    help=f"Replacement URL. Must be exactly {URL_LEN} chars (e.g. 'https://news.example.com').")
    args = ap.parse_args()

    new_url = args.url.encode("ascii")
    if len(new_url) != URL_LEN:
        print(f"[!] --url must be exactly {URL_LEN} chars, got {len(new_url)}: {args.url!r}", file=sys.stderr)
        sys.exit(1)
    if not (new_url.startswith(b"http://") or new_url.startswith(b"https://")):
        print(f"[!] --url should start with http:// or https://", file=sys.stderr)
        sys.exit(1)

    data = bytearray(args.input.read_bytes())
    found = bytes(data[EXPECTED_OFF:EXPECTED_OFF + URL_LEN])
    if found != EXPECTED_URL:
        print(f"[!] Expected {EXPECTED_URL!r} at 0x{EXPECTED_OFF:x}, found {found!r}", file=sys.stderr)
        print(f"[!] This libapp.so isn't the version this patch was derived for (com.even.sg v2.2.2 build 112).", file=sys.stderr)
        print(f"[!] To re-derive: grep -aob 'api2.evenreal.co' libapp.so", file=sys.stderr)
        sys.exit(1)
    if data[LEN_BYTE_OFF] != EXPECTED_LEN_BYTE:
        print(f"[!] Length byte mismatch at 0x{LEN_BYTE_OFF:x}: got 0x{data[LEN_BYTE_OFF]:02x}, want 0x{EXPECTED_LEN_BYTE:02x}", file=sys.stderr)
        sys.exit(1)

    data[EXPECTED_OFF:EXPECTED_OFF + URL_LEN] = new_url
    args.output.write_bytes(data)
    print(f"[+] {args.input} -> {args.output}")
    print(f"    news URL: {EXPECTED_URL.decode()} -> {args.url}")


if __name__ == "__main__":
    main()
