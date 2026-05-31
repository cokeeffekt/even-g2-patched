#!/usr/bin/env python3
"""
Set android:extractNativeLibs="true" on <application> in a merged APK.
Without this, the .so files are mmap'd from the APK zip and the Frida gadget
in script-mode can't fopen libfrida-gadget.script.so (it lives only inside the APK).
Setting extractNativeLibs="true" forces Android to extract /lib/arm64-v8a/*.so
to /data/app/.../lib/arm64/ on install, where the gadget can read them.

Strategy: parse AndroidManifest.xml (Android binary XML), locate the
extractNativeLibs attribute record on <application>, and flip its 4-byte
boolean from 0x00000000 to 0xffffffff in place.

Operates on the merged APK in place by replacing the manifest entry.
"""
import argparse
import struct
import sys
import zipfile
from pathlib import Path


def parse_string_pool(data, pos):
    chunk_type, hs, ts = struct.unpack_from('<HHI', data, pos)
    assert chunk_type == 0x0001, f"expected string pool got 0x{chunk_type:x}"
    string_count, _, flags, strings_start, _ = struct.unpack_from('<IIIII', data, pos + 8)
    is_utf8 = (flags & 0x100) != 0
    offsets = struct.unpack_from(f'<{string_count}I', data, pos + 28)
    strings = []
    for off in offsets:
        base = pos + strings_start + off
        if is_utf8:
            u8len = data[base + 1]
            strings.append(data[base + 2:base + 2 + u8len].decode('utf-8', errors='replace'))
        else:
            ulen = struct.unpack_from('<H', data, base)[0]
            if ulen & 0x8000:
                ulen = ((ulen & 0x7fff) << 16) | struct.unpack_from('<H', data, base + 2)[0]
                so = base + 4
            else:
                so = base + 2
            strings.append(data[so:so + ulen * 2].decode('utf-16-le', errors='replace'))
    return strings, ts


def find_extract_native_libs(mfst):
    chunk_type, hs, ts = struct.unpack_from('<HHI', mfst, 0)
    assert chunk_type == 0x0003, f"not an Android binary XML (root chunk 0x{chunk_type:x})"
    strings, sp_size = parse_string_pool(mfst, hs)
    name_idx = strings.index('extractNativeLibs')
    pos = hs + sp_size
    while pos < len(mfst):
        chunk_type, chunk_hs, chunk_ts = struct.unpack_from('<HHI', mfst, pos)
        if chunk_ts == 0:
            raise RuntimeError(f"zero-size chunk at offset 0x{pos:x}")
        if chunk_type == 0x0102:  # StartElement
            ext_off = pos + chunk_hs
            _, name_i, attr_start, attr_size, attr_count, *_ = struct.unpack_from('<IIHHHHHH', mfst, ext_off)
            elem = strings[name_i]
            attr_off = ext_off + attr_start
            for i in range(attr_count):
                arec = attr_off + i * attr_size
                _, a_name, _, _, _, a_type, a_data = struct.unpack_from('<IIIHBBI', mfst, arec)
                if a_name == name_idx and elem == 'application':
                    return arec, a_type, a_data
        pos += chunk_ts
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apk', required=True, type=Path, help='Merged APK to modify in place.')
    args = ap.parse_args()

    with zipfile.ZipFile(args.apk, 'r') as z:
        mfst = bytearray(z.read('AndroidManifest.xml'))

    hit = find_extract_native_libs(mfst)
    if hit is None:
        print(f"[!] no extractNativeLibs attribute found on <application>; assuming default-false and aborting", file=sys.stderr)
        sys.exit(1)
    arec_off, a_type, a_data = hit
    data_field_off = arec_off + 16
    if a_type != 0x12:
        print(f"[!] extractNativeLibs attr has unexpected type 0x{a_type:02x} (want 0x12)", file=sys.stderr)
        sys.exit(1)
    if a_data == 0xFFFFFFFF:
        print(f"[+] extractNativeLibs already true; nothing to do")
        return
    print(f"[+] {args.apk} AndroidManifest.xml: setting extractNativeLibs at 0x{data_field_off:x}: 0x{a_data:08x} -> 0xFFFFFFFF")
    struct.pack_into('<I', mfst, data_field_off, 0xFFFFFFFF)

    # Now rewrite the APK: copy all other entries, replace AndroidManifest.xml
    import shutil, tempfile
    tmp = args.apk.with_suffix('.apk.tmp')
    with zipfile.ZipFile(args.apk, 'r') as zin, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.namelist():
            buf = zin.read(item)
            info = zin.getinfo(item)
            if item == 'AndroidManifest.xml':
                buf = bytes(mfst)
            # Preserve uncompressed flag for .so files (Android requires uncompressed native libs since API 23)
            ct = zipfile.ZIP_STORED if info.compress_type == zipfile.ZIP_STORED else zipfile.ZIP_DEFLATED
            new_info = zipfile.ZipInfo(item)
            new_info.compress_type = ct
            new_info.external_attr = info.external_attr
            zout.writestr(new_info, buf)
    shutil.move(tmp, args.apk)
    print(f"[+] rewrote {args.apk}")


if __name__ == '__main__':
    main()
