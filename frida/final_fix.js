// Two-hook content refresh:
//   1) processResponse — capture the latest user-text Dart-String pointer
//   2) CmdDispatchState.enter — write that pointer into DiyAgentTask.content
//
// libapp.so file offsets are post-lief (Blutter offset + 0x1000).

const PROC_RESPONSE_OFF = 0x1e13938 + 0x1000;
const ENTER_OFF         = 0x1be039c + 0x1000;

const THR_FIELD_TABLE_VALUES_OFF = 0x68;
const DIY_INSTANCE_FIELD_OFF     = 0x2c68;
const EVENT_TEXT_FIELD_OFF       = 0x7;   // event.text (tagged-ptr offset)
const DIY_CONTENT_FIELD_OFF      = 0xb;   // DiyAgentTask.content (tagged-ptr offset)

const libapp = Process.getModuleByName("libapp.so").base;
console.log(`[+] libapp base: ${libapp}`);

let latestTextCompressed = 0;
let updateCount = 0;

Interceptor.attach(libapp.add(PROC_RESPONSE_OFF), {
    onEnter(args) {
        try {
            const event = this.context.x2;
            if (event.isNull()) return;
            const textCompressed = event.add(EVENT_TEXT_FIELD_OFF).readU32();
            if (textCompressed !== 0) {
                latestTextCompressed = textCompressed;
            }
        } catch (e) {}
    }
});

Interceptor.attach(libapp.add(ENTER_OFF), {
    onEnter(args) {
        try {
            if (latestTextCompressed === 0) return;
            const thisPtr = this.context.x1;
            const THR = this.context.x26;
            const fieldTable = THR.add(THR_FIELD_TABLE_VALUES_OFF).readPointer();
            const diyCompressed = fieldTable.add(DIY_INSTANCE_FIELD_OFF).readU32();
            if (diyCompressed === 0) return;
            const heapBase = ptr(thisPtr.toString()).and(ptr("0xffffffff00000000"));
            const diyInstance = heapBase.or(ptr("0x" + diyCompressed.toString(16)));
            const before = diyInstance.add(DIY_CONTENT_FIELD_OFF).readU32();
            diyInstance.add(DIY_CONTENT_FIELD_OFF).writeU32(latestTextCompressed);
            updateCount++;
            console.log(`[#${updateCount}] enter: DiyAgentTask.content 0x${before.toString(16)} -> 0x${latestTextCompressed.toString(16)}`);
        } catch (e) {
            console.log("!! enter hook: " + e.message);
        }
    }
});

console.log(`[+] Hooks installed: processResponse @ ${libapp.add(PROC_RESPONSE_OFF)}, enter @ ${libapp.add(ENTER_OFF)}`);
