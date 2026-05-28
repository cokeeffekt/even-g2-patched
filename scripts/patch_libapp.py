#!/usr/bin/env python3
"""
Apply the 4-byte NOP that bypasses the chat/built-in branch in CmdDispatchState.enter.

Target offset (v2.2.2 build 112): 0x1be04bc
Original:  80 0d 20 37    (tbnz w0, #4, +0x1b0  -- branch to built-in dispatch when intent != "chat")
Patched:   1f 20 03 d5    (nop                  -- always fall through to chat path -> diyAgentChat)
"""
import argparse
from pathlib import Path
import sys

PATCH_OFFSET = 0x1be04bc
ORIGINAL = bytes([0x80, 0x0d, 0x20, 0x37])
NOP      = bytes([0x1f, 0x20, 0x03, 0xd5])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input",  required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    args = ap.parse_args()

    data = bytearray(args.input.read_bytes())
    found = bytes(data[PATCH_OFFSET:PATCH_OFFSET + 4])
    if found != ORIGINAL:
        print(f"[!] Expected {ORIGINAL.hex()} at offset 0x{PATCH_OFFSET:x}, found {found.hex()}", file=sys.stderr)
        print(f"[!] This libapp.so isn't the version this patch was derived for (com.even.sg v2.2.2 build 112).", file=sys.stderr)
        print(f"[!] See docs/rederive.md to re-derive the offset for your version.", file=sys.stderr)
        sys.exit(1)
    data[PATCH_OFFSET:PATCH_OFFSET + 4] = NOP
    args.output.write_bytes(data)
    print(f"[+] {args.input} -> {args.output} (4-byte NOP at 0x{PATCH_OFFSET:x})")


if __name__ == "__main__":
    main()
