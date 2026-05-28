#!/usr/bin/env bash
# Sanity-check the patched APK.
set -euo pipefail
APK=${1:-./out/patched-final.apk}

echo "[*] Verifying $APK"
echo
echo "  contents (the three frida files should all be present, stored uncompressed):"
unzip -lv "$APK" 2>/dev/null | grep -E 'libfrida-gadget|libapp\.so|classes\.dex' | sed 's/^/    /'
echo
echo "  NOP location in patched libapp.so (post-lief shift, +0x1000):"
TMP=$(mktemp)
unzip -p "$APK" lib/arm64-v8a/libapp.so > "$TMP"
if command -v llvm-objdump >/dev/null; then
    llvm-objdump -d --start-address=0x1be14b8 --stop-address=0x1be14c4 --no-show-raw-insn "$TMP" 2>/dev/null \
        | sed 's/^/    /'
else
    echo "    (install llvm to disassemble; checking raw bytes instead)"
    python3 -c "
import sys
d = open('$TMP','rb').read()
got = d[0x1be14bc:0x1be14c0].hex()
want = '1f2003d5'
print(f'    bytes at 0x1be14bc: {got}  (want {want} = nop)')
print('    OK' if got == want else '    MISMATCH')
"
fi
rm -f "$TMP"
