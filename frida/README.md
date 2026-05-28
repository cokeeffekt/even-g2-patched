# What the Frida script does

`final_fix.js` runs inside the patched app via the bundled gadget. It installs two hooks:

| Hook | Where | What it does |
|---|---|---|
| `AzureTranscribeProcessor.processResponse` | `libapp.so + 0x1e13938` (Blutter offset, +0x1000 after the lief rebuild) | Captures the live ASR text — reads `event.field_7` (Dart String compressed pointer) and saves it to a global. Fires for every transcript event including partial ones; the *last* capture before classification is the final user text. |
| `CmdDispatchState.enter` | `libapp.so + 0x1be039c` (Blutter offset, +0x1000 after the lief rebuild) | Right before the (NOP'd-into-fall-through) chat path runs, resolves `DiyAgentTask._instance` via `THR.field_table_values + 0x2c68`, decompresses the pointer, and writes the captured text pointer into the instance's `content` field (offset `0xb`). That field is what `diyAgentChat` reads when forwarding to the user's agent. |

## Why both hooks?

The binary NOP alone routes every voice command through the chat path. But the chat path forwards `DiyAgentTask._instance.content` to the agent — and that field gets refreshed only in code we bypassed. Result: every non-chat command echoes the *previous* chat query. The Frida script fixes the stale-content read by writing the fresh text in just-in-time.

## What it does NOT do

- It does not capture text for use anywhere else; there's just one writer (the `enter` hook) and the global is reset each time.
- It does not signal Dart's GC about the write. The pointer it writes is a pointer that's already alive (held by the AsrEvent and the chat history), so the GC won't collect it before `diyAgentChat` reads it. In months of running this would matter; for normal use it's fine.
- It does not handle the "keep listening" follow-up window (see top-level `FINDINGS.md` for the proposed fix).

## Gadget config

`libfrida-gadget.config.so` is plain JSON renamed `.so` so Android keeps it during install (Android's APK extraction normally drops non-`.so` files from `lib/`). The config tells the gadget to run in `script` mode and load `libfrida-gadget.script.so` from the same directory inside the APK.

`libfrida-gadget.script.so` is `final_fix.js` renamed the same way — for the same APK-extraction reason.
