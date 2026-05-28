#!/usr/bin/env bash
# Pull all split APKs for com.even.sg from the connected device.
# Output: ./apks/{base,split_config.*}.apk
set -euo pipefail

PKG="${1:-com.even.sg}"
OUT="${OUT:-./apks}"

adb devices >/dev/null
mkdir -p "$OUT"

echo "[*] Listing APK paths for $PKG..."
mapfile -t paths < <(adb shell pm path "$PKG" | sed 's/^package://')
if [ "${#paths[@]}" -eq 0 ]; then
    echo "ERROR: $PKG is not installed on the device" >&2
    exit 1
fi

for p in "${paths[@]}"; do
    p=${p%$'\r'}
    name=$(basename "$p")
    echo "[*] Pulling $name"
    adb pull "$p" "$OUT/$name" >/dev/null
done
echo "[+] Done. APKs in $OUT/"
ls -lh "$OUT/"
