# Shipped: Even Realities G2 voice → custom-agent passthrough

## What it does

Every voice command spoken into the Even Realities G2 — including commands that the on-device classifier flags as built-in intents (`disp_bright_inc`, `ql_on`, `telep_on`, etc.) — is forwarded to the user's self-hosted AI agent at `https://agent.example.com/v1/chat/completions` as a plain OpenAI-style chat message. The built-in dispatch is bypassed entirely.

## Layered fix

**1. Binary patch in libapp.so** (one 4-byte NOP)
- File offset `0x1be04bc` (Blutter / original libapp.so) → `0x1be14bc` after lief rebuild adds the gadget DT_NEEDED.
- Original instruction: `tbnz w0, #4, +0x1b0` (bytes `80 0d 20 37`) — branches when `aiCommand.intent != "chat"`.
- Patched to `nop` (bytes `1f 20 03 d5`) so `CmdDispatchState.enter` always falls through to `DiyAgentTask::diyAgentChat`.

**2. ELF DT_NEEDED on libapp.so** (lief)
- Adds `libfrida-gadget.so` as a needed library so the Frida gadget loads alongside libapp.
- `libfrida-gadget.config.so` carries the listen config (127.0.0.1:27042, on_load: resume).

**3. Frida runtime hooks for fresh content** (final_fix.js)
- Hook `AzureTranscribeProcessor.processResponse` (libapp + `0x1e13938` Blutter offset). Reads `event.field_7`, validates it parses as a `_OneByteString` (cid 94; layout in this build: length Smi at tagged `+0x7`, chars at `+0xf`), caches the compressed pointer.
- Hook the NOP site (libapp + `0x1be04bc` Blutter offset). Only used for the glass-prefix PC redirect to `0x1be066c` — does not touch DiyAgentTask.content (see "Critical false starts" below).
- Hook `ApiServiceThirdPartyChatExt.diyAIChat` (libapp + `0x1be42b4` Blutter offset). At call entry x1 is the decompressed text Dart String pointer that's about to be serialised into the agent HTTP request. Re-validates the cached pointer; if our cache holds a valid `_OneByteString` whose text differs from the natural x1's text, substitutes x1 with the cached (decompressed) pointer. The substitution mutates only a CPU register — no Dart heap field is touched, no write barrier needed, no GC graph corruption.

**4. AndroidManifest patch: extractNativeLibs=true**
- Modern Android defaults `extractNativeLibs="false"`, which makes the package installer mmap `.so` files directly from the APK rather than extract them to `/data/app/.../lib/arm64/`. The Frida gadget's `script` interaction mode wants to `fopen` `libfrida-gadget.script.so` from the same directory it was loaded from, but that file lives only inside the APK zip when `extractNativeLibs=false`, so the script never runs. The build now patches the manifest's `extractNativeLibs` attribute data word in place (one 4-byte write at offset `0x809c` of the binary `AndroidManifest.xml`) so Android extracts the `.so` files and the gadget can find its script.

**Critical false starts (worth recording):**
- The first iteration hooked `CmdDispatchState.enter` at its function entry to do the content write. This crashes the app reliably with `Handle check failed: saw Context num_variables: 2 expected Instance` — hooking the entry of a Dart async function (it's an `InitAsyncStar` function) destabilises state-machine resumption. Moving the hook to the NOP-site (past async setup) cleared that crash.
- The OneByteString layout was wrong: chars at `0xb` (assumed) vs. `0xf` (empirical, this build). With the wrong layout the reader saw garbage and the cache held the *Context* parent pointer of `event.field_7` instead of the actual String. Writing that into `DiyAgentTask.content` produced the same `Handle check failed: saw Context` crash. Correct layout was found by reading "What time is it?" out of memory at multiple field offsets and decoding the first 4 chars at `+0xf`.
- Even with the correct layout and the NOP-site hook, writing a captured compressed pointer into `DiyAgentTask.content` produces *delayed* `SIGSEGV`s (often 13+ seconds after the write) in the `DartWorker` thread. Diagnosis: the natural `set content=` setter at `0x1720f3c` calls `WriteBarrierWrappersStub` (at `0x1f1aa54`) after the store. Our raw `writeU32` bypassed it, so the GC didn't know about the new reference. Within seconds the cached String would either be moved (leaving content pointing at stale memory) or, worse, scanned by the GC at a memory region that had been reclaimed for an unrelated buffer (one fault address decoded as ASCII fragments of a BLE MAC string — the GC was reading a `_OneByteString`'s char data as if it were an object header). Fix: stop writing into the field, hook `ApiServiceThirdPartyChatExt.diyAIChat` and substitute its `x1` argument at call time. That mutates a CPU register only — no Dart heap field is modified, so there's nothing for the barrier to track.
- For chat-classified prompts, the natural code path's `set content=` runs and allocates its own `_OneByteString` containing the transcript. That String is a DIFFERENT object from the one we cached at `processResponse` (different compressed pointer, same text). An earlier diyAIChat-substitution version compared only the pointer values; for chat-classified prompts it always substituted "different pointer = our cache" over "natural pointer = same text, GC-tracked", which still produced barrier-bypass crashes because the substituted pointer was untracked. Current logic compares the *decoded text* — if the natural x1 already has our text it's a pass-through, only genuinely-different text triggers substitution.

## How to run

```bash
cd /home/coke/gits/eveng2/phase3-blutter
adb forward tcp:27042 tcp:27042
.venv/bin/python -u /tmp/run_final.py > /tmp/final.log 2>&1 &
```

The patched APK is already installed (`com.even.sg` v2.2.2, build 112, with the NOP + gadget). The Frida script must be re-attached on each app launch — to make persistent, the Dart-side text write should be converted into a static patch too (see "Future work").

## Files

- `phase1-static/FINDINGS.md` — original recon notes (BERT path proved dead).
- `phase2-hook/build_patched.py` — lief DT_NEEDED injector.
- `phase2-hook/patched-unsigned.apk` — intermediate APK (pre-NOP).
- `phase3-blutter/patch_libapp.py` — the 4-byte NOP patch.
- `phase3-blutter/build_final.py` — combines NOP + gadget into the final APK.
- `phase3-blutter/patched-final.apk` — installed APK (signed via uber-apk-signer).
- `phase3-blutter/final_fix.js` — runtime Frida hook (the third layer).
- `phase3-blutter/out/` — full Blutter dump (asm/, blutter_frida.js, objs.txt, pp.txt).

## Truth corrections vs the original brief

- The bundled BERT classifier in libeven.so (`bert_infer`, `even::bert_module::*`) is **dead code**. Confirmed zero invocations across many voice commands.
- The bundled llama.cpp in libeven.so is also dead for this path.
- No `general_query` intent label exists. The 30 enum labels in libeven.so (CONVERSATE_ON, DISP_BRIGHT_INC, ...) match the openCFW doc but are not active.
- The actual classifier output format used at runtime is `{"intent":...,"is_supported":...,"score":...,"entities":{...}}` (LLM-style). The `"intent":"chat"` value is the existing fallback that routes to the user's agent.
- Source of the classifier output is opaque from outside the Microsoft Cognitive Services SDK (statically-linked SSL, invisible to system libssl / cronet hooks). It may be Azure CLU via the bundled Speech LU extension, or Even's backend — we did not pin it down.

## Known limitation: reply-and-dismiss

Built-in commands used to keep the mic open for a follow-up question. Our hijack routes those queries through the chat path, which has no `transitionTo(StayState)` — the state machine falls back to `IdleState` and dismisses.

## Future work

### 1. Stay-alive after agent reply
The chat path in `CmdDispatchState.enter` returns via `ReturnAsyncNotFuture` without a `transitionTo`. The built-in path explicitly transitions to `StayState` (20s timer) after `executeTask` succeeds — that's what keeps the mic open. Options to restore the behavior:

- **Frida-injected `transitionTo(StayState)`** after `diyAgentChat` returns. Requires constructing a `StayState` Dart object at runtime; the allocation stub is at `0x1664d8c` and the transition function `AIAgentContext::transitionTo` is at `0x166429c`. Possible but fiddly.
- **Revert NOP, patch built-in path instead.** Redirect `handleAiCommand` (at `0x1be0c38`) to call `diyAgentChat` (at `0x1be4110`) before returning. The natural `StayState` transition would still fire. Cleaner end state but needs more disassembly work.

Relevant addresses in `out/asm/even/common/services/ai_agent/state/cmd_dispatch_state.dart` (Blutter offsets, add `0x1000` for post-lief):
- `0x1be5414` — `AllocateStayStateStub` call
- `0x1be5454` — `transitionTo(StayState)` — what we want to trigger
- `0x1be5478` — `AllocateIdleStateStub` (the dismiss we're hitting)
- `0x1be54a4` — `transitionTo(IdleState)`
- `0x1d3adc8` — `transitionTo(WakeUpState with vadStart)` — only reachable from `handleWakeUp`

### 2. Bake the Frida hook into the binary
Currently the runtime text-refresh hook needs to be re-attached on every app launch. A second static patch (or an Xposed-style module) would make the whole thing standalone.

### 3. Re-derive when app updates
All offsets are tied to libapp.so v2.2.2 build 112. New app versions shift everything.

### 4. News feed redirect (implemented)
The app pulls a news feed from `api2.evenreal.co`. Resolved via the 24-char in-place URL swap in `scripts/patch_news_url.py` plus a server-side mock that implements the five news endpoints AND a catch-all reverse proxy for everything else (the swapped string is the shared base for the entire app's API, not just news). Full verified contract — including the gotchas about envelope `code:0` not `code:200`, GET+POST on `news_favorites_settings`, article `uri` must be a short opaque ID not a URL, and server-side settings persistence — is in [`docs/news_api.md`](docs/news_api.md).

### 4a. Shorten the news poll interval (implemented)
The app polled `news_list` on a `Timer.periodic` measured in hours. Now Frida-stomped to 15 min via a fourth hook in `final_fix.js`.

**Where the constant lives.** AOT specialised `3.hours` into a parameterless wrapper at libapp Blutter offset `0x1558780` that allocates a `Duration` (size 0x10, single unboxed-int64 field at tagged offset `+7`) and stores the constant `0x283baec00` (= 10800000000 us = 3h) into it. The wrapper is called from exactly five sites — all in `NewsService` (`_startNewsFetchTimer`'s start-delay, schedule-boundary calc, and periodic interval; plus `_isNeedFetchNews`'s gate and `_needForceFetch`'s `3.hours - 1.minutes` threshold). No other Dart code in the binary uses this specialisation, so a wrapper-level swap is safe.

**The hook.** `Interceptor.attach` with `onLeave` at `0x1558780 + 0x1000`. Read the returned tagged pointer, confirm `[ret+7]` reads 10800000000 (defensive — degrade to no-op if a future build changes the wrapper), then `writeS64` the desired interval. Because `Duration._duration` is an unboxed int64 (not a Dart object reference), there's no write barrier to bypass and nothing in the GC graph mutates. The Duration is also freshly-allocated per call, so the in-place stomp is per-call and can't alias another caller's Duration.

**Why a wrapper-level hook (not a call-site hook).** Stomping at the call site would have required identifying the right site (`0x1558828`'s BL to `Timer.periodic`, with the Duration in x2). But shortening only that site would desync the `_isNeedFetchNews` `elapsed >= 3.hours` gate and the `_needForceFetch` `3.hours - 1.minutes` threshold — they'd still expect a 3-hour cadence and skip ticks. The wrapper hook shrinks every dependent computation uniformly.

**Interval choice.** 15 min default (`NEWS_POLL_INTERVAL_US` constant at top of `frida/final_fix.js`). The server-side mock's content cache TTL is 5 min, so going shorter just wastes calls.

### 4b. Mock-side news contract gotchas (added 2026-06-02, after a day of live use)
Two non-obvious mock requirements that we found only by running the patched build for a full day on hardware and watching the news widget intermittently blank itself. Both are documented in detail in [`docs/news_api.md`](docs/news_api.md); summarised here for the FINDINGS thread:

- **`news_list` must return ≥ 5 articles per response.** `receiverApplyNewsEvent` calls a no-arg List method on the buffered news list and checks `result - 5 ≥ 0` (libapp `0x155428c`: `sub x0, x1, #5; tbnz x0, #0x3f, FAILURE`). Below 5, every periodic fetch ends with the app sending `APP_REQUEST_CLEAR_ALL_DATA(13)` to the glasses, blanking the news widget, then scheduling a 3-min retry that hits the same failure. The symptom is "news widget randomly goes empty every ~15 min and recovers on the next manual fetch". Pad with stable filler entries; the receiver only checks count, not relevance.

- **Article `uri` must be derived from the article's *slot identity*, not its content.** `sha256(source).hexdigest()[:16]` works for singleton-per-source slots. `sha256(source + title)` does not — once the slot's title or body legitimately refreshes (Calendar ticking over, news rotation), the uri changes and the next reindex against the previously-cached uri fails. Same `APP_REQUEST_CLEAR_ALL_DATA(13)` blanking consequence. The earlier docs said "stable across requests is mandatory" but didn't warn against title-as-input; we hit this twice during the day.

These weren't visible from static analysis alone; the receiver-side codepath only fires when the glasses send a news event back to the app, which the mock can't simulate. They surfaced once we had end-to-end logs (`adb logcat -s flutter:V`) tied to the timing of the empty-state symptom.

### 5. "glasses" keyword for opt-in local intent (implemented)
`final_fix.js` now recognises a `glass ` or `glasses ` prefix on the ASR transcript. At `processResponse` the prefix is stripped from the `OneByteString` in place (chars shifted left, tail padded with spaces) so the on-device intent classifier sees the unprefixed phrase. A second hook at the NOP site (`0x1be04bc` + 0x1000) sets PC to `0x1be066c` + 0x1000 — the original `tbnz` branch target — to put execution back on the `getTaskByIntent` → `handleAiCommand` path. Note: the assumption is that the on-device classifier reads `AsrResult.text` *after* `processResponse` returns. If it actually classifies in parallel with ASR, the strip won't reclassify and `aiCommand.intent` will still be `"chat"`, so `handleTask illegal !!!` will log and the built-in dispatch will silently no-op. In that case, fall back to a local keyword → intent table inside the Frida script.
