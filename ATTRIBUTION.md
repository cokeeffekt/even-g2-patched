# Attribution

This patch and its analysis stand on the shoulders of:

- **Even Realities** — the G2 hardware and the Android companion app being modified here.
- **[Blutter](https://github.com/worawit/blutter)** by worawit — Flutter AOT reverse engineering toolkit; used to extract Dart symbols and addresses from libapp.so.
- **[Frida](https://github.com/frida/frida)** by Ole André V. Ravnås and contributors — dynamic instrumentation framework; the bundled gadget and the runtime hook.
- **[APKEditor](https://github.com/REAndroid/APKEditor)** by REAndroid — split-APK merge + manifest sanitization.
- **[uber-apk-signer](https://github.com/patrickfav/uber-apk-signer)** by Patrick Favre-Bulle — APK v1/v2/v3/v4 signing with bundled zipalign.
- **[LIEF](https://lief.re/)** — used for the DT_NEEDED injection into libapp.so.
- **[kalanihelekunihi/evenRealities-openCFW](https://github.com/kalanihelekunihi/evenRealities-openCFW)** — community reverse-engineering of the G2 platform that informed the initial (incorrect) plan.

Original session: documented by the patch author across a single multi-hour Claude Code session. See `FINDINGS.md` for the full chronology of dead ends and pivots.
