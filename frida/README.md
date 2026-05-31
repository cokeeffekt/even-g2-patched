# What the Frida script does

`final_fix.js` runs inside the patched app via the bundled gadget. It installs **three** hooks (all at addresses inside `libapp.so`, expressed as Blutter offsets — at runtime the script adds `+0x1000` to account for the lief DT_NEEDED rebuild that shifts `.text`).

| Hook | Where | What it does |
|---|---|---|
| `AzureTranscribeProcessor.processResponse` | `0x1e13938` | At every ASR transcript event: read `event.field_7`, validate it parses as a `_OneByteString` (Dart cid 94 in this build), and if so cache its *compressed* pointer as `latestTextCompressed`. If the decoded text starts with `glass ` or `glasses `, strip that prefix in place (shift chars left, pad tail with spaces) and arm the glass-prefix flag. |
| NOP-site PC redirect | `0x1be04bc` | This is the exact address of the static 4-byte NOP we placed in `libapp.so`. Only used for glass-prefix routing: when the glass-prefix flag is armed, set `pc` to `libapp + 0x1be066c` (the original `tbnz` branch target — the built-in dispatch path `getTaskByIntent` → `handleAiCommand`) and clear the flag. Otherwise the NOP runs as-is and execution falls through to the chat path. |
| `ApiServiceThirdPartyChatExt.diyAIChat` | `0x1be42b4` | This is the function `DiyAgentTask.diyAgentChat` calls with the text-to-send-to-the-agent in `x1` (already-decompressed Dart String pointer). The hook reads the natural `x1`, decodes its text, and compares it to our cached transcript's text. If they match → pass through (chat-classified prompt, natural code worked). If they differ AND our cache is still a valid `OneByteString` → substitute `x1` with our cached pointer for the duration of this call. This fixes the "previous prompt being resent" bug for built-in-classified intents that the NOP hijacks into the chat path. |

## Why substitute `x1` instead of writing into `DiyAgentTask.content`

An earlier iteration of this script wrote the cached pointer directly into `DiyAgentTask.content` (field offset `0xb`) at the NOP site. That worked *briefly* and then crashed with `SIGSEGV` in the `DartWorker` (GC) thread, sometimes 13+ seconds after the write. Diagnosis: Dart's `set content=` setter normally goes through `WriteBarrierWrappersStub`, which tells the GC about the new reference. Our raw `writeU32` bypassed that. The GC then either missed our String when scanning (so it got moved or collected) or, worse, scanned the now-stale pointer into reclaimed memory that had been re-used for unrelated data (we observed a fault address that decoded as ASCII fragments of a BLE MAC string — the GC was reading a `_OneByteString`'s char data as if it were a Dart object header).

Substituting `x1` at `diyAIChat`'s entry mutates a CPU register, not a Dart heap field — there is no Dart object whose reference graph we're modifying, so there is nothing for the write barrier to track. The substituted pointer only needs to be valid for the duration of this one call (the function serialises it into an HTTP request body immediately). We still re-validate the cached pointer against the `_OneByteString` layout right before substituting, so if Dart's compacting GC has moved/freed our String between `processResponse` and `diyAIChat`, the substitution is skipped (you'll see `diyAIChat: cache 0x… no longer a OneByteString (GC moved?); pass through natural x1`).

## Why the substitution is needed at all

The binary NOP routes every voice command through the chat path that reads `DiyAgentTask._instance.content` and passes it to `diyAIChat`. For prompts the on-device classifier labelled as `intent: chat`, the natural code path *already* sets that field correctly — `diyAIChat` is called with the right text and our hook passes it through (`diyAIChat: natural x1 already has our text … pass through`). For prompts labelled as a built-in intent (`ql_on`, `disp_bright_inc`, `conversate_on`, …) the natural code doesn't update content (it expected the built-in dispatcher to take over), so `diyAIChat` would be called with whatever was in content from the *previous* chat query — the "previous prompt being resent" symptom. Our hook detects the text mismatch and substitutes the fresh transcript.

## Why the glass-prefix opt-in

Lets the user say `"glass brightness up"` to invoke the on-device `disp_bright_inc` intent (or any other built-in label) without removing the patch. `processResponse` strips the `glass `/`glasses ` prefix so the on-device intent classifier sees the unprefixed phrase and classifies it normally; the NOP-site hook re-routes execution to the built-in dispatch path that the static NOP would otherwise have killed.

## OneByteString layout

The reader assumes this build's `_OneByteString` (class id `94`) has this tagged-pointer layout, confirmed empirically by reading "What time is it?" out of memory and decoding "What" at chars offset:

| Offset (tagged) | Field |
|---|---|
| `-0x1`..`0x2` | header tags (class id at bits 12-31) |
| `0x3`..`0x6` | (padding / unused) |
| `0x7`..`0xa` | `length` (Smi, raw value = `len << 1`) |
| `0xb`..`0xe` | `hash` (raw uint32) |
| `0xf`..      | `data` (1 byte per char) |

If your build of `libapp.so` ships a different Dart and these offsets differ, `readOneByteString` returns `null`, nothing gets cached, and no substitution happens — you'd see no `procResp: CACHED …` lines in logcat and `diyAIChat: NO CACHE` on each call.

## What it does NOT do

- It does not run a local intent classifier. The "glass" opt-in trusts the on-device classifier to recognise the stripped phrase. If the classifier still returns `chat` for the stripped text, the built-in dispatch will log `handleTask illegal !!!` and silently no-op — verify phrasing matches the labels in `task_command.dart`.
- It does not modify any Dart heap field. Earlier iterations did (writing into `DiyAgentTask.content` at the NOP site), but bypassing `WriteBarrierWrappersStub` corrupted Dart's GC graph and caused delayed `SIGSEGV`s in the `DartWorker` thread. The current design substitutes a function-call argument register at `diyAIChat`, which the GC has no reason to track — there's no heap mutation to barrier.
- It does not handle GC invalidation. Dart's compacting GC can move a String between when `processResponse` caches its compressed pointer and when `diyAIChat` would substitute it. We revalidate just before substituting; if the cache no longer parses as a `_OneByteString` the substitution is skipped (look for `diyAIChat: cache 0x… no longer a OneByteString (GC moved?); pass through`). The agent then receives whatever the natural `x1` had — usually a stale prior prompt's text. This is the failure mode of last resort; we prefer "agent gets old text" over "GC explodes".
- It does not handle the "keep listening" follow-up window (see top-level `FINDINGS.md` future-work #1 for the proposed fix).

## Confirming it's working

After install you should see lines like these in `adb logcat -s FRIDA_PATCH:V`:
```
=== script loaded === (logPrintAddr=0x…)
libapp base: 0x…
hooks installed: processResponse@… nop@… -> builtin@… diyAIChat@…
procResp: CACHED cmp=0x… text="…"                         (every partial + final ASR transcript)
diyAIChat: natural x1 already has our text ("…"); pass through    (chat-classified — natural code already did the right thing)
[#N] diyAIChat: SUBSTITUTED x1 (…) -> 0x… ("…")           (built-in-hijacked — we fixed the text the agent receives)
```

## Gadget config

`libfrida-gadget.config.so` is plain JSON renamed `.so` so Android keeps it during install. The config tells the gadget to run in `script` mode and load `libfrida-gadget.script.so` from the same directory.

`libfrida-gadget.script.so` is `final_fix.js` renamed the same way.

For the script file to be readable at runtime, the APK needs `android:extractNativeLibs="true"` on `<application>`. Modern APKs default to `false` (native libs are mmap'd from the APK zip rather than extracted to disk), which makes the gadget's `fopen("libfrida-gadget.script.so")` fail silently — the gadget loads but the script never runs. `scripts/set_extract_native_libs.py` (called by `build_patched.sh`) patches the binary `AndroidManifest.xml` in place to flip this single byte.
