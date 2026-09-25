#!/usr/bin/env python3
"""
05 — repair a code page on the fault, then let the CPU retry.

Why this is needed on top of 04
-------------------------------
04 implements V8's W^X hook with mprotect, which is process-wide, while the macOS
API it stands in for (pthread_jit_write_protect_np) is per-thread. So a range
that is RW because *this* thread opened a write scope is also RW for every other
thread, and a thread fetching an instruction from it faults. V8 also patches
trampolines lazily, so a page can be left in the wrong mode by a scope that was
opened and closed around a different page.

Measured on the device, without this patch, with 04 applied:

    [DSH-TRAP-WHERE] signal=10 si_code=1 addr=0x11f700c68
    [DSH-TRAP-WHERE] pc=0x11f700c68 lr -> Builtins_InterpreterOnStackReplacement_ToBaseline + 0x8c
    -> Bus error: 10

si_code 1 is BUS_ADRALN, pc == si_addr, and the address is inside the registered
code range: the page simply was not executable when it was fetched.

What this patch does
--------------------
* platform-darwin.cc: FixJitFetchFault(addr) makes the 16 KB page containing a
  fetch fault executable; FixJitWriteFault(addr) makes the page containing a data
  fault writable. Both refuse addresses outside the code range, so they cannot
  silently paper over an unrelated fault.
* src/node.cc: the last-installed signal handler (TrapWebAssemblyOrContinue)
  calls the right one and returns, which makes the kernel retry the faulting
  instruction. If the address is outside the range, or the fix fails, the
  original behaviour is unchanged -- the fault is still reported.

node.cc does not include base/platform/platform.h, so it declares what it needs
at file scope. Declaring a namespace inside a function body is not valid C++, and
including the header instead pulled in a declaration that was compiled out --
both of which cost a build each.

With 04+05 the device runs JIT: plain JS, regular expressions, WebAssembly, file
I/O and multi-million-iteration loops all complete with exit status 0, a
20M-iteration loop goes from ~1060 ms to ~300 ms, and cold boot to first token
from 45 s to 17 s. Worker threads remain unreliable (the process-wide mprotect
above), which is what DSH_JITLESS=1 is for.
"""
import io
import os
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("NODE_TREE", ".")
DARWIN = os.path.join(SRC, "deps/v8/src/base/platform/platform-darwin.cc")
PLATFORM_H = os.path.join(SRC, "deps/v8/src/base/platform/platform.h")
NODE_CC = os.path.join(SRC, "src/node.cc")
MARK = "FixJitFetchFault"


def read(p):
    return io.open(p, encoding="utf-8", errors="replace").read()


def write(p, s):
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)


def fail(msg):
    sys.exit("  05 FAIL: " + msg)


# ------------------------------------------------------------------ darwin.cc
s = read(DARWIN)
if MARK in s:
    print("  platform-darwin.cc: already repairs faults")
else:
    anchor = "V8_BASE_EXPORT void ApplyJitProtectionTo(void* addr, size_t size) {"
    if anchor not in s:
        fail("platform-darwin.cc: ApplyJitProtectionTo not found (apply 04 first)")
    helpers = '''// DSH-IOS-JITFIX: the two halves of the fault repair. Return non-zero when the
// page was fixed, in which case the handler returns and the CPU retries.
//
// A fetch fault means the page must be executable; a write fault means V8 is
// emitting code into a page that is currently executable. Both are limited to
// the registered code range: anything else keeps its original behaviour.
namespace {
int RepairPage(uintptr_t addr, int prot) {
  if (g_code_base == nullptr || g_code_size == 0) return 0;
  const uintptr_t base = reinterpret_cast<uintptr_t>(g_code_base);
  if (addr < base || addr >= base + g_code_size) return 0;
  void* page = reinterpret_cast<void*>(addr & ~(kPage - 1));
  if (mprotect(page, kPage, prot) != 0) return 0;
  static int reported = 0;
  if (++reported <= 8) {
    fprintf(stderr, "[jitscope] repaired %p as %s (#%d)\\n", page,
            prot == (PROT_READ | PROT_EXEC) ? "executable" : "writable", reported);
  }
  return 1;
}
}  // namespace

int FixJitFetchFault(void* addr) {
  return RepairPage(reinterpret_cast<uintptr_t>(addr), PROT_READ | PROT_EXEC);
}

int FixJitWriteFault(void* addr) {
  const int fixed =
      RepairPage(reinterpret_cast<uintptr_t>(addr), PROT_READ | PROT_WRITE);
  if (fixed) {
    // A write is in progress, so the range is writable again from now on.
    g_executable = 0;
  }
  return fixed;
}

'''
    s = s.replace(anchor, helpers + anchor, 1)
    write(DARWIN, s)
    print("  platform-darwin.cc: fetch and write fault repair added")

# ----------------------------------------------------------------- platform.h
s = read(PLATFORM_H)
if "FixJitFetchFault" in s:
    print("  platform.h: already declares the repairs")
else:
    anchor = "V8_BASE_EXPORT void ApplyJitProtectionTo(void* addr, size_t size);"
    if anchor not in s:
        fail("platform.h: ApplyJitProtectionTo declaration not found (apply 04 first)")
    s = s.replace(
        anchor,
        anchor + "\n"
        "V8_BASE_EXPORT int FixJitFetchFault(void* addr);\n"
        "V8_BASE_EXPORT int FixJitWriteFault(void* addr);", 1)
    write(PLATFORM_H, s)
    print("  platform.h: repairs declared")

# ------------------------------------------------------------------- node.cc
s = read(NODE_CC)
if "FixJitFetchFault" in s:
    print("  node.cc: already hooked up")
else:
    # 1. a file-scope declaration: node.cc does not include base/platform/platform.h
    anchor = '#include "node.h"'
    if anchor not in s:
        fail("node.cc: #include \"node.h\" not found")
    decl = anchor + '''
// DSH-IOS-JITFIX: node.cc does not include base/platform/platform.h, so declare
// the iOS fault repairs here. A namespace cannot be declared inside a function
// body, so this has to be at file scope.
namespace v8 {
namespace base {
int FixJitFetchFault(void* addr);
int FixJitWriteFault(void* addr);
}  // namespace base
}  // namespace v8
'''
    s = s.replace(anchor, decl, 1)

    # 2. hook the last-installed handler, which already decodes nothing itself --
    #    it hands the fault to V8 first. We repair the page before that, because a
    #    page that is simply not executable is not a V8 webassembly trap.
    probe = ("void TrapWebAssemblyOrContinue(int signo, siginfo_t* info, void* ucontext) {\n"
             "  if (!v8::TryHandleWebAssemblyTrapPosix(signo, info, ucontext)) {")
    if probe not in s:
        fail("node.cc: TrapWebAssemblyOrContinue anchor not found")
    hooked = """void TrapWebAssemblyOrContinue(int signo, siginfo_t* info, void* ucontext) {
#if defined(__APPLE__) && (defined(__arm64__) || defined(__aarch64__))
  // DSH-IOS-JITFIX: repair the page and let the kernel retry the instruction.
  // A fetch fault (pc == far) needs the page executable; a write fault means V8
  // is emitting code into a page that is currently executable. Anything outside
  // the registered code range falls through to the original handling below.
  // Note this function returns void: returning at all is the retry.
  {
    const ucontext_t* uc = static_cast<const ucontext_t*>(ucontext);
    const uintptr_t pc =
        static_cast<uintptr_t>(uc->uc_mcontext->__ss.__pc);
    const uintptr_t far = static_cast<uintptr_t>(
        reinterpret_cast<void*>(uc->uc_mcontext->__es.__far));
    if (pc == far && ::v8::base::FixJitFetchFault(reinterpret_cast<void*>(pc))) {
      return;
    }
    if (pc != far && ::v8::base::FixJitWriteFault(reinterpret_cast<void*>(far))) {
      return;
    }
  }
#endif  // __APPLE__ && __aarch64__
  if (!v8::TryHandleWebAssemblyTrapPosix(signo, info, ucontext)) {"""
    s = s.replace(probe, hooked, 1)
    write(NODE_CC, s)
    print("  node.cc: handler repairs the page and retries")

print("  05 done")
