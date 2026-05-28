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

**3. Frida runtime hook for fresh content** (final_fix.js)
- Hook `AzureTranscribeProcessor.processResponse` (libapp + `0x1e13938` Blutter offset). Captures `event.text` (field at tagged-ptr offset 0x7) into a global compressed-pointer cache.
- Hook `CmdDispatchState.enter` (libapp + `0x1be039c` Blutter offset). Resolves `DiyAgentTask._instance` via `THR.field_table_values[0x2c68]`, then writes the cached text pointer to `DiyAgentTask._instance.content` (offset 0xb).

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

### 4. News feed redirect
The app pulls a news feed from `api2.evenreal.co` (saw `/v2/g/*` patterns in logs). Want to replace with a self-hosted feed source. Approaches: (a) DNS redirect via the home network or a proxy, (b) binary-patch the URL string in libapp.so. The first is reversible; the second is durable but requires the new host to mimic the API contract.

### 5. "glasses" keyword for opt-in local intent
With the current patch every voice command goes to the user's agent. To let the user *occasionally* invoke a built-in command (brightness, quicklist, etc.) without unbinding the patch, treat the leading word "glasses" as a passthrough trigger: if the ASR text starts with "glasses ...", skip the content-rewrite hook so the built-in dispatch runs normally; otherwise behave as today. Implementation goes in `final_fix.js` — check the text bytes at `processResponse` and only update the global pointer when the text does NOT start with "glasses".
