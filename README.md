# Even Realities G2: route every voice command to your own AI agent

A patch for the **Even Realities G2** Android companion app (`com.even.sg`) that bypasses the on-device voice intent classifier and forwards **every** spoken command — including the ones that would normally trigger built-in actions like "brightness up" or "add to quicklist" — to the user-configured custom AI agent endpoint.

Why? The built-in voice classifier is greedy. Anything that *sounds* like a built-in intent ("add bread to the shopping list", "open the calendar") gets eaten by the local dispatcher and never reaches your custom agent. This patch lets your agent see and answer all of it.

> **Status**: tested only against **com.even.sg v2.2.2 (build 112)** on **Pixel 7a / Android 16**. Offsets will need rederiving for any other version. This is a research/personal-use patch — not a production tool. See the [open issues](#known-limitations--todo) section.

> **Legal**: the patched APK contains Even Realities' copyrighted code. Don't redistribute it. This repo ships the *recipe* — your own legitimately-obtained APK + these scripts → your own patched APK.

---

## How it works (one-paragraph version)

The app classifies your voice via Microsoft Cognitive Services (the Azure Speech LU extension), then a Dart state machine (`CmdDispatchState.enter`) branches: `intent == "chat"` → forward the text to your custom agent; anything else → run a built-in action. The patch consists of:

1. A **4-byte NOP** in `libapp.so` that turns the chat/built-in branch into an unconditional fall-through to the chat path.
2. A **`frida-gadget` bundled inside the APK** that auto-loads a JS script which fixes the resulting stale-text bug (the chat path reads from a field that wasn't refreshed for non-chat queries).
3. A relinked `libapp.so` with `libfrida-gadget.so` added as a `DT_NEEDED` entry so the gadget is loaded automatically at app startup. No external Frida runtime, no root, no re-attachment per launch.

Read [`FINDINGS.md`](FINDINGS.md) for the full reverse-engineering journey — the *original* premise (BERT classifier in `libeven.so` is what we hook) turned out to be wrong, the actual classifier is opaque inside Azure's static-SSL networking, and the right Dart-side hook took a lot of pivoting to find.

---

## What you'll need

- **Linux** (tested on EndeavourOS / Arch). macOS likely works with minor changes; Windows not tested.
- **A rootless Android phone** with the Even Realities app installed and **USB debugging enabled**.
- **Java 21+**, **Python 3.10+**, **gcc ≥13** or **clang ≥16**.
- **Disk**: ~5 GB free (mostly for the Blutter / Dart SDK build during the *one-time* offset discovery — you don't need to re-do that step if you trust the offsets shipped here).
- **`com.even.sg` v2.2.2 (build 112)** specifically. Different version → see [Re-deriving offsets](#re-deriving-offsets-for-a-new-app-version).

---

## Quickstart (5 commands)

Assumes you have a Pixel 7a or similar on a recent Android with the matching app version, USB debugging on.

```bash
# 1. System deps
sudo pacman -S --needed android-tools python-pipx llvm capstone     # or apt/dnf equivalent

# 2. Python tools
pipx install frida-tools
python -m venv .venv && .venv/bin/pip install lief

# 3. Pull your APK from the phone, then run the patcher
./scripts/pull_apk.sh             # pulls all split APKs from /data/app
./scripts/build_patched.sh        # merges splits, applies the NOP, bundles frida-gadget+script,
                                  # re-signs with uber-apk-signer
                                  # outputs ./out/patched-final.apk

# 4. Install
adb uninstall com.even.sg
adb install -r out/patched-final.apk
```

You'll have to re-pair the glasses and re-sign in to the app (uninstall wipes user data). That's the one-time cost.

After launching the patched app once, every voice command goes to whatever endpoint you've configured for the AI Agent in the app's settings, in OpenAI chat-completions format.

---

## Layout

```
release/
├── README.md                          you are here
├── FINDINGS.md                        full reverse-engineering writeup
├── ATTRIBUTION.md                     credit + prior art
├── scripts/
│   ├── pull_apk.sh                    adb-pulls base+split APKs from the device
│   ├── build_patched.sh               full one-shot pipeline
│   ├── patch_libapp.py                the 4-byte NOP patch
│   ├── inject_gadget.py               lief DT_NEEDED + frida-gadget bundle
│   └── verify.sh                      sanity-check the output APK
├── frida/
│   ├── final_fix.js                   the runtime hook that fixes the stale-text bug
│   ├── libfrida-gadget.config.so      gadget config — auto-loads the script
│   └── README.md                      what each hook does and why
└── docs/
    ├── pipeline.md                    end-to-end recipe with full commands
    ├── offsets.md                     exact addresses for v2.2.2 build 112
    └── rederive.md                    how to rebuild offsets for a new version
```

---

## Re-deriving offsets for a new app version

When Even Realities ships a new app, libapp.so changes and all our offsets shift. The pipeline:

1. Pull and merge the new APK (`pull_apk.sh` + APKEditor merge).
2. Build [Blutter](https://github.com/worawit/blutter) and run it on the new `libapp.so`. First run downloads + compiles the matching Dart SDK (~15-30 min).
3. In Blutter's `out/asm/even/common/services/ai_agent/state/cmd_dispatch_state.dart`, find:
   - The `"chat"` string load (`add x16, PP, #..., lsl #12 ; "chat"`)
   - The `tbnz w0, #4, ...` immediately after the `==` call → that's the patch site
4. In `out/asm/flutter_ezw_asr/src/transcribe/utils/azure_transcribe_processor.dart`, find `processResponse` — its address is the second hook target.
5. Update the offsets in `scripts/patch_libapp.py` and `frida/final_fix.js`, then re-run the pipeline.

See [`docs/rederive.md`](docs/rederive.md) for the play-by-play.

---

## Known limitations / TODO

- **Reply-and-dismiss.** Built-in commands kept the mic listening for a follow-up question. Our hijack loses that — every reply ends the conversation. The fix is to make the chat path also `transitionTo(StayState)`; details and exact addresses in [`FINDINGS.md`](FINDINGS.md).
- **No opt-in for local intents.** If you genuinely want "brightness up" to set brightness today, you can't — it always reaches your agent. Proposed: prefix command with `"glasses ..."` to bypass the patch. Trivial to add to `final_fix.js`.
- **News feed locked to Even.** The app pulls news from `api2.evenreal.co`. Some users will want their own feed. Approach: DNS redirect or `libapp.so` string patch.
- **Version-locked.** Offsets above are for `com.even.sg v2.2.2 build 112`. Newer = redo step 5 of the [Quickstart](#quickstart-5-commands).

---

## Contributing

PRs welcome especially for: porting to newer app versions, adding the stay-alive / `"glasses"` keyword features, automating the offset rederivation.

## License

The original Even Realities app and its libraries are NOT covered by this license — only the scripts, the patch payload, and the documentation in *this* directory are. They are released under the MIT license (see `LICENSE`).
