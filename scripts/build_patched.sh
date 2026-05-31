#!/usr/bin/env bash
# Full pipeline: split APKs -> merged -> patched libapp.so -> patched APK with gadget+script -> signed.
# Inputs:
#   ./apks/{base.apk, split_config.*.apk}
# Requires (pre-fetched into ./tools/):
#   APKEditor.jar           https://github.com/REAndroid/APKEditor
#   uber-apk-signer.jar     https://github.com/patrickfav/uber-apk-signer
#   libfrida-gadget.so      https://github.com/frida/frida/releases  (android-arm64)
# Output:
#   ./out/patched-final.apk
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APKS="${APKS:-$ROOT/apks}"
OUT="${OUT:-$ROOT/out}"
TOOLS="${TOOLS:-$ROOT/tools}"
PYTHON="${PYTHON:-python3}"
FRIDA_DIR="$ROOT/frida"
SCRIPTS_DIR="$ROOT/scripts"
WORK="$OUT/work"

# Optional: replace the news feed base URL.
# Must be EXACTLY 24 chars (same length as the original 'https://api2.evenreal.co').
# Leave unset / empty to keep the original Even Realities news server.
NEWS_URL="${NEWS_URL:-}"

mkdir -p "$OUT" "$WORK"

for f in APKEditor.jar uber-apk-signer.jar libfrida-gadget.so; do
    [ -f "$TOOLS/$f" ] || { echo "ERROR: missing $TOOLS/$f — see comment at top of this script" >&2; exit 1; }
done

echo "[*] 1/5  Merge split APKs + flip extractNativeLibs=true on manifest"
java -jar "$TOOLS/APKEditor.jar" m -i "$APKS" -o "$WORK/merged.apk" >/dev/null
$PYTHON "$SCRIPTS_DIR/set_extract_native_libs.py" --apk "$WORK/merged.apk"

echo "[*] 2/5  Extract libapp.so + apply 4-byte NOP (+ optional news URL swap)"
mkdir -p "$WORK/lib"
unzip -o -j "$WORK/merged.apk" "lib/arm64-v8a/libapp.so" -d "$WORK/lib" >/dev/null
$PYTHON "$SCRIPTS_DIR/patch_libapp.py" --input "$WORK/lib/libapp.so" --output "$WORK/lib/libapp.patched.so"
if [ -n "$NEWS_URL" ]; then
    echo "    -> swapping news base URL to: $NEWS_URL"
    $PYTHON "$SCRIPTS_DIR/patch_news_url.py" \
        --input  "$WORK/lib/libapp.patched.so" \
        --output "$WORK/lib/libapp.patched.so" \
        --url    "$NEWS_URL"
fi

echo "[*] 3/5  Rebuild APK with patched libapp.so + bundled gadget + script + config"
$PYTHON "$SCRIPTS_DIR/inject_gadget.py" \
    --merged "$WORK/merged.apk" \
    --libapp "$WORK/lib/libapp.patched.so" \
    --gadget "$TOOLS/libfrida-gadget.so" \
    --gadget-config "$FRIDA_DIR/libfrida-gadget.config.so" \
    --gadget-script "$FRIDA_DIR/final_fix.js" \
    --output "$OUT/patched-unsigned.apk"

echo "[*] 4/5  Sign + zipalign"
java -jar "$TOOLS/uber-apk-signer.jar" -a "$OUT/patched-unsigned.apk" --allowResign --overwrite >/dev/null
mv "$OUT/patched-unsigned.apk" "$OUT/patched-final.apk"

echo "[*] 5/5  Verify"
"$SCRIPTS_DIR/verify.sh" "$OUT/patched-final.apk" || true

echo
echo "[+] Done: $OUT/patched-final.apk"
echo "    adb uninstall com.even.sg && adb install -r $OUT/patched-final.apk"
