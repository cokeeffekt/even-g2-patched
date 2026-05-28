#!/usr/bin/env python3
"""
Rebuild the APK with:
  - the NOP-patched libapp.so (lief-relinked to depend on libfrida-gadget.so)
  - frida-gadget bundled in lib/arm64-v8a/
  - libfrida-gadget.config.so + libfrida-gadget.script.so bundled alongside it

The gadget loads at app startup via the DT_NEEDED entry on libapp.so,
reads its config (script mode), reads the script from the same lib dir
inside the APK, and runs it. No external Frida runtime needed.
"""
import argparse
import zipfile
from pathlib import Path
import lief

TARGET_LIB         = "lib/arm64-v8a/libapp.so"
GADGET_PATH        = "lib/arm64-v8a/libfrida-gadget.so"
GADGET_CFG_PATH    = "lib/arm64-v8a/libfrida-gadget.config.so"
GADGET_SCRIPT_PATH = "lib/arm64-v8a/libfrida-gadget.script.so"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--merged",        required=True, type=Path, help="Universal APK from APKEditor merge")
    ap.add_argument("--libapp",        required=True, type=Path, help="NOP-patched libapp.so")
    ap.add_argument("--gadget",        required=True, type=Path, help="frida-gadget arm64 .so")
    ap.add_argument("--gadget-config", required=True, type=Path, help="gadget config (JSON renamed .so)")
    ap.add_argument("--gadget-script", required=True, type=Path, help="JS script (will be bundled as .so)")
    ap.add_argument("--output", "-o",  required=True, type=Path)
    args = ap.parse_args()

    print(f"[*] libapp.so input:      {args.libapp} ({args.libapp.stat().st_size:,} bytes)")
    libapp_bytes = args.libapp.read_bytes()

    print(f"[*] Adding DT_NEEDED libfrida-gadget.so to libapp.so...")
    elf = lief.ELF.parse(list(libapp_bytes))
    elf.add_library("libfrida-gadget.so")
    b = lief.ELF.Builder(elf)
    b.build()
    libapp_bytes = bytes(b.get_build())
    print(f"[*] libapp.so output:     {len(libapp_bytes):,} bytes (lief grew by ~0x1000)")

    print(f"[*] Reading {args.merged}")
    with zipfile.ZipFile(args.merged, "r") as src, zipfile.ZipFile(args.output, "w") as dst:
        skip = {TARGET_LIB, GADGET_PATH, GADGET_CFG_PATH, GADGET_SCRIPT_PATH}
        for item in src.infolist():
            if item.filename == TARGET_LIB:
                i = zipfile.ZipInfo(filename=item.filename, date_time=item.date_time)
                i.compress_type = zipfile.ZIP_STORED
                i.external_attr = item.external_attr
                dst.writestr(i, libapp_bytes)
            elif item.filename in skip:
                continue
            else:
                dst.writestr(item, src.read(item.filename))
        for path, blob in [(GADGET_PATH,       args.gadget.read_bytes()),
                           (GADGET_CFG_PATH,   args.gadget_config.read_bytes()),
                           (GADGET_SCRIPT_PATH, args.gadget_script.read_bytes())]:
            zi = zipfile.ZipInfo(filename=path)
            zi.compress_type = zipfile.ZIP_STORED
            zi.external_attr = 0o644 << 16
            dst.writestr(zi, blob)
    print(f"[+] Wrote {args.output} ({args.output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
