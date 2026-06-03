// Four-hook setup:
//   1) processResponse — read the ASR transcript at x2.field_7. If it parses as
//      a _OneByteString (Dart cid 94), cache its compressed pointer. If the text
//      begins with "glass " or "glasses ", strip that prefix in place and arm the
//      glass-prefix flag.
//   2) NOP site (same address we placed the binary NOP at) — only used for the
//      glass-prefix PC redirect. When the flag is armed, set pc to the original
//      tbnz target so execution lands on the built-in dispatch path. Otherwise
//      the NOP runs as-is and falls through to the chat path.
//   3) diyAIChat — substitutes the x1 argument (the text being sent to the user's
//      agent) when the natural x1's text differs from our cached transcript.
//      This fixes the "previous prompt being resent" symptom for built-in intents
//      (ql_on, disp_bright_inc, …) that the NOP hijacks into the chat path: in
//      those cases the natural code didn't update content, so x1 inherits whatever
//      the prior chat query left there.
//   4) GetNumUtils.hours (3-hour specialisation) — stomp the freshly-allocated
//      Duration's microseconds field on return. This wrapper is the AOT-specialised
//      `3.hours` and is called from five places, all in NewsService (start timer,
//      initial-delay calc, periodic interval, _isNeedFetchNews gate, _needForceFetch
//      gate). Shortening the return uniformly drops the news poll cadence from 3h
//      to NEWS_POLL_INTERVAL_US (default 15 min) without breaking the internal
//      timing arithmetic. Duration._duration is an unboxed int64 — no write
//      barrier, no GC graph touched.
//
// Why substitute x1 instead of writing into DiyAgentTask.content directly: the
// earlier write-content design bypassed Dart's WriteBarrierWrappersStub. Within
// seconds the GC would either move our String out from under the field or scan a
// stale pointer into reclaimed memory, producing delayed SIGSEGVs in the
// DartWorker thread (one observed fault decoded as ASCII fragments of a BLE MAC
// string — the GC was reading String char data as a Dart object header).
// Substituting a register at function entry mutates no heap field, so there's
// nothing for the barrier to track.
//
// libapp.so file offsets are post-lief (Blutter offset + 0x1000).

const PROC_RESPONSE_OFF = 0x1e13938 + 0x1000;
const NOP_OFF           = 0x1be04bc + 0x1000;  // the NOP'd tbnz site (still used for glass-prefix PC redirect)
const BUILTIN_OFF       = 0x1be066c + 0x1000;  // original tbnz branch target (built-in dispatch path)
const DIY_AI_CHAT_OFF   = 0x1be42b4 + 0x1000;  // ApiServiceThirdPartyChatExt.diyAIChat — text in x1
const NEWS_HOURS_OFF    = 0x1558780 + 0x1000;  // GetNumUtils.hours AOT-specialised wrapper that returns Duration(3h)

// News-poll interval override. The wrapper at NEWS_HOURS_OFF normally returns
// 10800000000us (3h); we replace that value on every call. 15 min is a balance
// between freshness and battery; backend mock content cache TTL is 5 min so going
// shorter than that just wastes calls.
const NEWS_POLL_INTERVAL_US = 15 * 60 * 1000 * 1000;  // 15 minutes
const NEWS_HOURS_ORIGINAL_US = "10800000000";          // 3 hours, as a decimal string for int64() — sanity check before stomping

const THR_FIELD_TABLE_VALUES_OFF = 0x68;
const DIY_INSTANCE_FIELD_OFF     = 0x2c68;
const EVENT_TEXT_FIELD_OFF       = 0x7;       // AsrResult.text (tagged-ptr offset)
const DIY_CONTENT_FIELD_OFF      = 0xb;       // DiyAgentTask.content (tagged-ptr offset)

// Empirical OneByteString layout in this Dart build (cid 94), in tagged-ptr offsets.
// Confirmed by /tmp/probe.js — reading "What time is it?" at len=16, chars start +0xf:
//   -1   : header tags (4 bytes — class id, etc.)
//   +0x7 : length_  (Smi, 4 bytes; raw = len << 1)
//   +0xb : hash_    (raw uint32, 4 bytes)
//   +0xf : data_    (1 byte per char)
const STR_LEN_OFF   = 0x7;
const STR_CHARS_OFF = 0xf;

// Diagnostic marker — proves whether the gadget ran the script.
// We call __android_log_print directly under a known tag so logcat surely captures it,
// regardless of whether the gadget's console.log routing is intact.
const ANDROID_LOG_INFO = 4;
function findLogPrint() {
    // Frida 17 deprecated Module.getExportByName(null, ...). Try multiple paths.
    const candidates = [
        () => Module.findGlobalExportByName && Module.findGlobalExportByName("__android_log_print"),
        () => Process.findModuleByName("liblog.so") && Process.findModuleByName("liblog.so").findExportByName("__android_log_print"),
        () => Process.findModuleByName("libc.so") && Process.findModuleByName("libc.so").findExportByName("__android_log_print"),
    ];
    for (const f of candidates) {
        try { const p = f(); if (p && !p.isNull()) return p; } catch (e) {}
    }
    return null;
}
const logPrintAddr = findLogPrint();
const __android_log_print = logPrintAddr
    ? new NativeFunction(logPrintAddr, "int", ["int", "pointer", "pointer", "pointer"])
    : null;
const FRIDA_TAG_PTR = Memory.allocUtf8String("FRIDA_PATCH");
const FRIDA_FMT_PTR = Memory.allocUtf8String("%s");
function marker(msg) {
    if (!__android_log_print) { console.log("[FRIDA_PATCH] " + msg); return; }
    try {
        __android_log_print(ANDROID_LOG_INFO, FRIDA_TAG_PTR, FRIDA_FMT_PTR, Memory.allocUtf8String(msg));
    } catch (e) { console.log("[FRIDA_PATCH] " + msg + " (log_print failed: " + e.message + ")"); }
}
marker(`=== script loaded === (logPrintAddr=${logPrintAddr})`);

let libapp;
try {
    libapp = Process.getModuleByName("libapp.so").base;
    marker(`libapp base: ${libapp}`);
} catch (e) {
    marker(`!! Process.getModuleByName('libapp.so') failed: ${e.message}`);
    throw e;
}
console.log(`[+] libapp base: ${libapp}`);

let glassPrefixArmed = false;
let latestTextCompressed = 0;     // cached pointer of last valid OneByteString from processResponse
let updateCount = 0;

function decompressInHeap(holder, compressed) {
    const heapBase = ptr(holder.toString()).and(ptr("0xffffffff00000000"));
    return heapBase.or(ptr("0x" + compressed.toString(16)));
}

function readOneByteString(strTagged, maxBytes) { try {
    const lenRaw = strTagged.add(STR_LEN_OFF).readU32();
    if ((lenRaw & 1) !== 0) return null;            // not a Smi → wrong layout
    const len = lenRaw >>> 1;
    if (len === 0 || len > 1024) return null;       // implausible
    const n = Math.min(len, maxBytes);
    const bytes = new Uint8Array(strTagged.add(STR_CHARS_OFF).readByteArray(n));
    for (let i = 0; i < n; i++) {
        if (bytes[i] < 0x20 || bytes[i] > 0x7e) {
            if (i === 0) return null;                // not ASCII → probably TwoByteString
            break;
        }
    }
    let text = "";
    for (let i = 0; i < n; i++) text += String.fromCharCode(bytes[i]);
    return { len, text };
} catch (e) { return null; } }

function stripLeadingInPlace(strTagged, prefixLen) {
    const lenRaw = strTagged.add(STR_LEN_OFF).readU32();
    const len = lenRaw >>> 1;
    const newLen = len - prefixLen;
    const charsPtr = strTagged.add(STR_CHARS_OFF);
    const tail = charsPtr.add(prefixLen).readByteArray(newLen);
    charsPtr.writeByteArray(tail);
    const pad = new Uint8Array(prefixLen);
    pad.fill(0x20);                                  // pad with spaces
    charsPtr.add(newLen).writeByteArray(pad);
}

function detectGlassPrefix(text) {
    const lower = text.toLowerCase();
    if (lower.startsWith("glasses ")) return 8;
    if (lower.startsWith("glass ")) return 6;
    return 0;
}

Interceptor.attach(libapp.add(PROC_RESPONSE_OFF), {
    onEnter(args) {
        try {
            const event = this.context.x2;
            if (event.isNull()) { marker("procResp: x2 null"); return; }
            const textCompressed = event.add(EVENT_TEXT_FIELD_OFF).readU32();
            if (textCompressed === 0) { marker("procResp: x2.field_7 = 0"); return; }

            const strTagged = decompressInHeap(event, textCompressed);
            const parsed = readOneByteString(strTagged, 64);
            if (parsed === null) {
                marker(`procResp: SKIP non-OneByteString cmp=0x${textCompressed.toString(16)}`);
                return;
            }

            latestTextCompressed = textCompressed;
            marker(`procResp: CACHED cmp=0x${textCompressed.toString(16)} text="${parsed.text}"`);

            const prefixLen = detectGlassPrefix(parsed.text);
            if (prefixLen === 0) return;

            stripLeadingInPlace(strTagged, prefixLen);
            glassPrefixArmed = true;
            const after = readOneByteString(strTagged, 32);
            marker(`[glass] stripped ${prefixLen}-char prefix; text now: "${after ? after.text : "?"}"`);
        } catch (e) {
            marker("!! processResponse: " + e.message);
        }
    }
});

Interceptor.attach(libapp.add(NOP_OFF), {
    onEnter() {
        // NOP-site hook is now ONLY for glass-prefix PC redirect. Content fix-up moved
        // to diyAIChat hook below — that approach substitutes a function argument
        // instead of writing into a Dart heap field, avoiding the WriteBarrierWrappersStub
        // bypass that was corrupting the GC graph and causing delayed crashes.
        if (glassPrefixArmed) {
            glassPrefixArmed = false;
            marker(`[glass] redirecting PC to built-in dispatch @ ${libapp.add(BUILTIN_OFF)}`);
            this.context.pc = libapp.add(BUILTIN_OFF);
        }
    }
});

Interceptor.attach(libapp.add(DIY_AI_CHAT_OFF), {
    onEnter() {
        // ApiServiceThirdPartyChatExt.diyAIChat is called from DiyAgentTask.diyAgentChat with
        //   x1 = decompressed content String (the text that will be sent to the user's agent)
        // The function serialises x1 into an HTTP request body immediately, so substituting
        // x1 here only needs the new value to be valid for this one call — no write barrier
        // (no Dart heap field is being modified), no GC graph corruption, no delayed crashes.
        try {
            const naturalText = this.context.x1;
            const naturalParsed = readOneByteString(naturalText, 80);
            const naturalDesc = naturalParsed ? `"${naturalParsed.text}"` : `cid=${classIdAt(naturalText)}`;

            if (latestTextCompressed === 0) {
                marker(`diyAIChat: NO CACHE; natural x1=0x${naturalText.toString(16)} (${naturalDesc}); pass through`);
                return;
            }

            // Re-validate the cached pointer (GC may have moved it).
            const cachedStr = decompressInHeap(naturalText, latestTextCompressed);
            const cachedParsed = readOneByteString(cachedStr, 80);
            if (cachedParsed === null) {
                marker(`diyAIChat: cache 0x${latestTextCompressed.toString(16)} no longer a OneByteString (GC moved?); pass through natural x1 (${naturalDesc})`);
                return;
            }

            if (naturalParsed && naturalParsed.text === cachedParsed.text) {
                marker(`diyAIChat: natural x1 already has our text ("${naturalParsed.text}"); pass through`);
                return;
            }

            // Genuinely different — built-in-hijacked prompt where the chat path inherited a
            // stale content. Substitute x1. Register reassignment in onEnter() is the only
            // mutation; no heap is touched.
            this.context.x1 = cachedStr;
            updateCount++;
            marker(`[#${updateCount}] diyAIChat: SUBSTITUTED x1 (${naturalDesc}) -> 0x${cachedStr.toString(16)} ("${cachedParsed.text}")`);
        } catch (e) {
            marker("!! diyAIChat hook: " + e.message);
        }
    }
});

function classIdAt(taggedPtr) {
    try { const t = taggedPtr.add(-1).readU32(); return (t >>> 12) & 0xfffff; } catch (e) { return -1; }
}

// 4. GetNumUtils.hours (3-hour specialisation). onLeave runs at the wrapper's `ret`;
// retval is the tagged pointer to the freshly-allocated Duration. The microseconds
// field (Duration._duration in this build, unboxed int64) sits at tagged offset +7
// — that's the same offset both the wrapper's `stur x1, [x0, #7]` and every reader
// site uses. We sanity-check the value matches the expected 3h constant before
// stomping, so if a future build changes the wrapper or shares it across other
// `.hours` callers we degrade to a no-op instead of corrupting them.
const NEWS_POLL_INTERVAL_INT64 = int64(String(NEWS_POLL_INTERVAL_US));
const NEWS_HOURS_ORIGINAL_INT64 = int64(NEWS_HOURS_ORIGINAL_US);
let newsHoursStompCount = 0;
let newsHoursSkipCount = 0;

Interceptor.attach(libapp.add(NEWS_HOURS_OFF), {
    onLeave(retval) {
        try {
            if (retval.isNull()) return;
            const microsAddr = retval.add(0x7);
            const current = microsAddr.readS64();
            if (!current.equals(NEWS_HOURS_ORIGINAL_INT64)) {
                newsHoursSkipCount++;
                if (newsHoursSkipCount <= 3) {
                    marker(`news.hours: SKIP unexpected micros=${current} (expected ${NEWS_HOURS_ORIGINAL_INT64}) @ ${retval}`);
                }
                return;
            }
            microsAddr.writeS64(NEWS_POLL_INTERVAL_INT64);
            newsHoursStompCount++;
            if (newsHoursStompCount <= 5 || newsHoursStompCount % 20 === 0) {
                marker(`[#${newsHoursStompCount}] news.hours: 3h -> ${NEWS_POLL_INTERVAL_US / 60e6}min @ ${retval}`);
            }
        } catch (e) {
            marker(`!! news.hours hook: ${e.message}`);
        }
    }
});

// NOTE: enter hook intentionally removed. Investigation showed even a no-op hook
// installed at CmdDispatchState.enter's function entry was associated with crashes
// (Dart Handle check). We need a different hook point — see below.

console.log(`[+] Hooks: processResponse @ ${libapp.add(PROC_RESPONSE_OFF)}, nop @ ${libapp.add(NOP_OFF)} -> ${libapp.add(BUILTIN_OFF)}, diyAIChat @ ${libapp.add(DIY_AI_CHAT_OFF)}, news.hours @ ${libapp.add(NEWS_HOURS_OFF)} (3h -> ${NEWS_POLL_INTERVAL_US / 60e6}min)`);
marker(`hooks installed: processResponse@${libapp.add(PROC_RESPONSE_OFF)} nop@${libapp.add(NOP_OFF)} -> builtin@${libapp.add(BUILTIN_OFF)} diyAIChat@${libapp.add(DIY_AI_CHAT_OFF)} news.hours@${libapp.add(NEWS_HOURS_OFF)} (3h->${NEWS_POLL_INTERVAL_US / 60e6}min)`);
