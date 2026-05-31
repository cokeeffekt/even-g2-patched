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

# 2. Python tools — both lief (ELF rewriting) and pyaxmlparser (manifest patching)
pipx install frida-tools
pipx inject frida-tools lief pyaxmlparser      # add both libs to the same venv used below

# 3. Pull your APK from the phone, then run the patcher
./scripts/pull_apk.sh             # pulls all split APKs from /data/app
PYTHON=~/.local/share/pipx/venvs/frida-tools/bin/python \
    ./scripts/build_patched.sh    # merges splits, flips extractNativeLibs=true,
                                  # applies the NOP, bundles frida-gadget+script,
                                  # re-signs with uber-apk-signer
                                  # outputs ./out/patched-final.apk

# 4. Install
adb uninstall com.even.sg
adb install -r out/patched-final.apk
```

You'll have to re-pair the glasses and re-sign in to the app (uninstall wipes user data). That's the one-time cost.

After launching the patched app once, every voice command goes to whatever endpoint you've configured for the AI Agent in the app's settings, in OpenAI chat-completions format.

### Optional: point the news feed at your own server

You can redirect the in-glasses news feed to a server you control. **Read this whole section before building** — the short version is "you're hijacking more than just news, and your server has to act as a reverse proxy for everything else."

#### What gets redirected (it's more than news)

The 24-char string `https://api2.evenreal.co` baked into `libapp.so` at file offset `0x1cbf47` is the **shared base URL for the entire app's backend**, not just the news feed. Every endpoint the Dart `ApiService` class hits — auth, `/v2/g/user_info`, `/v2/g/get_privacy_urls`, `/v2/g/jarvis/conversate/*`, `/v2/g/health/*`, `/v2/evenhub/installed`, the news endpoints, and more — appends a path to this single base. There is no separate news-only base in the binary, so a one-string byte-swap can't isolate news.

Consequence: if you point this string at your own server and don't proxy non-news paths, **the app won't even log in.** It'll try to call `/v2/g/user_info` against your mock, get nothing back, and stop.

#### What your server has to do

Implement the five news endpoints from [`docs/news_api.md`](docs/news_api.md), and for **every other path**, transparently reverse-proxy the request to `https://api2.evenreal.co` (forwarding method, query string, body, and headers — including `Authorization`/`Cookie` — and returning the upstream status/headers/body verbatim, minus hop-by-hop headers).

Done right, the user experience is: your news server controls news, Even's backend handles everything else, and the app behaves normally.

#### Building with `NEWS_URL`

Once your server has both the news routes and the proxy fallback, set `NEWS_URL` when running the build:

```bash
NEWS_URL='https://news.example.com' \
    PYTHON=~/.local/share/pipx/venvs/frida-tools/bin/python \
    ./scripts/build_patched.sh
```

The URL **must be exactly 24 characters** (same length as the original `https://api2.evenreal.co`) — `scripts/patch_news_url.py` does a strict same-length byte-swap into the Dart object pool. Anything else will be rejected with a clear error.

`verify.sh` (auto-run as the last build step) confirms what landed in the final APK:

```
news base URL (post-lief shift, +0x1000 -> 0x1ccf47):
    'https://news.example.com'
    swapped (custom feed)
```

#### Fast-track prompt for AI coding tools

If you already have the [news endpoints](docs/news_api.md) stubbed (the minimal FastAPI stub at the bottom of that doc is a good starting point) and just need to add the proxy fallback, paste this into Claude / your coding assistant of choice on your server, against your existing mock file:

> I have a FastAPI mock that handles the five Even Realities G2 news endpoints (`POST /v2/g/news_list`, `GET /v2/g/news_sources`, `GET /v2/g/news_categories`, `GET /v2/g/news_favorites_settings`, `POST /v2/g/news_favorites_settings_save`). I need to add a **catch-all reverse proxy** so that any other path the Even app calls is transparently forwarded to the real upstream at `https://api2.evenreal.co`. Without this, the app can't reach auth/user_info/health/jarvis endpoints and won't even log in.
>
> Requirements:
>
> 1. **Catch-all comes last in route order** — all my existing news routes must match first. Implement it as `@app.api_route("/{path:path}", methods=["GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"])`.
> 2. **Use `httpx.AsyncClient`** for the upstream call, with `httpx.Timeout(30.0, connect=10.0)`. Build the upstream URL as `f"https://api2.evenreal.co/{path}"` and forward the query string from `request.url.query`.
> 3. **Forward the request body verbatim** with `await request.body()` — don't try to parse it.
> 4. **Forward all incoming headers EXCEPT hop-by-hop / routing ones**: drop (case-insensitive) `host`, `content-length`, `connection`, `keep-alive`, `proxy-*`, `te`, `trailers`, `transfer-encoding`, `upgrade`. Keep `authorization`, `cookie`, `user-agent`, `content-type`, and any custom Even-app headers.
> 5. **Return upstream's status, body, and headers verbatim**, dropping the same hop-by-hop set plus `content-encoding` and `transfer-encoding`. Plain `Response`, not `StreamingResponse` — these are tiny JSON payloads.
> 6. **Log every proxied call** at INFO with method, path, upstream status, and a truncated body preview, matching the format my existing news routes use.
> 7. **Verify upstream TLS** (`verify=True`, the default).
> 8. **No retry, no caching** — clean transparent forwarding.
>
> Error handling:
> - Upstream timeout → HTTP 504, body `{"error": "upstream timeout"}`.
> - Upstream network error → HTTP 502, body `{"error": "upstream unreachable"}`.
> - Never crash the worker on an upstream failure.
>
> Show me the new code and where it goes in the file relative to the existing news routes. Don't change the news endpoints.

After your server is up with both the news routes and the proxy, run `adb logcat | grep API-Auth` while using the patched app — every call should show up there with paths to verify against your server logs.

### Confirming the patch is alive on the device

Once installed, watch for the gadget script's startup banner in logcat:

```bash
adb logcat -s FRIDA_PATCH:V
```

You should see, at app launch:
```
FRIDA_PATCH: === script loaded ===
FRIDA_PATCH: libapp base: 0x...
FRIDA_PATCH: hooks installed: processResponse@... nop@... -> builtin@... diyAIChat@...
```

…then per voice command:
```
FRIDA_PATCH: procResp: CACHED cmp=0x... text="..."        (every ASR partial+final result)
FRIDA_PATCH: diyAIChat: natural x1 already has our text   (chat-classified — natural code worked)
FRIDA_PATCH: [#N] diyAIChat: SUBSTITUTED x1 ...           (built-in-hijacked — we fixed the text)
```

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
│   ├── patch_news_url.py              optional: swap the news feed base URL
│   ├── set_extract_native_libs.py     manifest patch — forces .so extraction so the gadget can find its script
│   ├── inject_gadget.py               lief DT_NEEDED + frida-gadget bundle
│   └── verify.sh                      sanity-check the output APK
├── frida/
│   ├── final_fix.js                   the runtime hook that fixes the stale-text bug
│   ├── libfrida-gadget.config.so      gadget config — auto-loads the script
│   └── README.md                      what each hook does and why
└── docs/
    ├── pipeline.md                    end-to-end recipe with full commands
    ├── offsets.md                     exact addresses for v2.2.2 build 112
    ├── news_api.md                    contract your news server must implement
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
- **Local intent opt-in via "glass ..." / "glasses ..." prefix.** Prefix any voice command with `glass` (or `glasses`) to route it back through the on-device built-in dispatch — useful for "glass brightness up", "glass quicklist on", etc. The Frida script strips the prefix from the ASR transcript so the classifier sees the unprefixed phrase, then redirects execution at the NOP site into `getTaskByIntent` → `handleAiCommand`. See `frida/README.md` for the mechanics. Caveat: if the on-device classifier doesn't recognise the stripped phrase as a known intent label (`disp_bright_inc`, `ql_on`, `conversate_on`, …), the dispatch silently no-ops.
- **Version-locked.** Offsets above are for `com.even.sg v2.2.2 build 112`. Newer = redo step 5 of the [Quickstart](#quickstart-5-commands).

---

## Contributing

PRs welcome especially for: porting to newer app versions, adding the stay-alive / `"glasses"` keyword features, automating the offset rederivation.

## License

The original Even Realities app and its libraries are NOT covered by this license — only the scripts, the patch payload, and the documentation in *this* directory are. They are released under the MIT license (see `LICENSE`).
