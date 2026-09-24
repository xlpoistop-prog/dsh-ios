#!/usr/bin/env python3
# 02 - The wasm guard-region / trap-handler inconsistency.
#
# The problem this fixes, and why the published recipes only worked around it:
#
# V8 decides whether a wasm memory can use the signal-based trap handler for its
# bounds checks. That mechanism needs *guard regions*: a multi-gigabyte
# reservation around each wasm memory so an out-of-bounds access lands in
# inaccessible pages and raises a fault instead of needing an explicit check.
# iOS refuses that reservation.
#
# `V8_TRAP_HANDLER_SUPPORTED` nevertheless evaluated true on iOS, because it
# lists V8_OS_DARWIN and iOS is a Darwin. So V8 advertised the trap handler,
# requested guard regions, failed to get them, and the two decisions then
# disagreed. The published port resolved the disagreement from the wrong end: it
# forced `bool guards = false` in backing-store.cc, which left V8 still believing
# the trap handler was in use, and V8 aborts on that combination:
#
#   Check failed: use_trap_handler implies backing_store->has_guard_regions().
#     SetInstanceMemory -> WasmMemoryObject::UseInInstance
#                                              -> InstanceBuilder::Build
#
# observed on-device, intermittently, in every wasm workload (an empty module
# aborts about as often as a 30-million-call loop). Their answer was to require
# --wasm-enforce-bounds-checks --wasm-max-mem-pages=16384 on every launch.
#
# This patch fixes the cause instead. iOS genuinely cannot support the trap
# handler, so say so:
#
#   - guard regions are no longer requested, so nothing needs the reservation
#     iOS refuses, and the backing-store.cc workaround becomes unnecessary;
#   - V8 falls back to explicit bounds checks on its own. That is what
#     --wasm-enforce-bounds-checks does, and V8 documents it as mattering only
#     "even if the trap handler is available" (flag-definitions.h), so the flag
#     is now redundant rather than required;
#   - the CHECK above can no longer fire, because there is no longer a decision
#     to disagree with.
#
# Link safety: this is a supported V8 configuration, not a hole. handler-outside.cc
# carries an explicit `#if !V8_TRAP_HANDLER_SUPPORTED` stub, so EnableTrapHandler()
# and g_is_trap_handler_enabled still exist, and IsTrapHandlerEnabled() is an
# inline header function reading that flag. Nothing fails to link.
#
# Usage: 02-fix-trap-handler.py <node-source-dir>
import sys
import pathlib

ANCHOR = """// Everything else is unsupported.
#else
#define V8_TRAP_HANDLER_SUPPORTED false
#endif
"""

INJECT = ANCHOR + """
// iOS port: the trap handler is genuinely unsupported here, for the reason
// above. It needs guard regions -- a multi-gigabyte reservation per wasm memory
// -- and iOS refuses that reservation. Left declared as supported (V8_OS_DARWIN
// covers iOS), V8 requested guard regions, failed to obtain them, and aborted on
// the first wasm instantiation:
//
//   Check failed: use_trap_handler implies backing_store->has_guard_regions().
//
// With the trap handler switched off the three decisions agree: no guard regions
// are requested, V8 emits explicit bounds checks by itself (which is all that
// --wasm-enforce-bounds-checks asks for), and the check cannot be reached.
#if defined(V8_OS_IOS)
#undef V8_TRAP_HANDLER_SUPPORTED
#define V8_TRAP_HANDLER_SUPPORTED false
#endif
"""


def main():
    if len(sys.argv) != 2:
        print("usage: 02-fix-trap-handler.py <node-source-dir>", file=sys.stderr)
        return 2
    src = pathlib.Path(sys.argv[1]).resolve()
    p = src / "deps/v8/src/trap-handler/trap-handler.h"
    if not p.exists():
        print(f"FAIL: {p} not found", file=sys.stderr)
        return 1

    s = p.read_text(encoding="utf-8")
    if "iOS port: the trap handler is genuinely unsupported" in s:
        print("  skip (already applied): trap handler disabled on iOS")
        return 0
    if s.count(ANCHOR) != 1:
        print(f"FAIL: expected exactly 1 match for the end of the SUPPORTED chain, "
              f"found {s.count(ANCHOR)}", file=sys.stderr)
        return 1
    p.write_text(s.replace(ANCHOR, INJECT, 1), encoding="utf-8")
    print("  applied: V8_TRAP_HANDLER_SUPPORTED = false on iOS")
    print("           -> no guard regions, explicit bounds checks, no aborts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
