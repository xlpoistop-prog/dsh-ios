#!/usr/bin/env python3
"""
04 — implement V8's W^X write-protect hook for iOS, so JIT can run.

The failure being fixed
-----------------------
V8's platform-darwin.cc says "See platform-ios.cc for the iOS implementation."
That file does not exist in this tree. Nothing else implements
SetJitWriteProtected for iOS either, because V8 only declares the whole hook
when V8_HAS_PTHREAD_JIT_WRITE_PROTECT is 1, and build_config.h sets that to 1
only for arm64 macOS:

    #if defined(V8_HOST_ARCH_ARM64) && defined(V8_OS_MACOS)

So on iOS the macro is 0, platform.h compiles the SetJitWriteProtected
declaration out, RwxMemoryWriteScope (code-memory-access-inl.h) becomes a no-op,
code pages are never made executable, and executing the first builtin that is
not in the current RW mapping raises SIGBUS at the instruction fetch:

    [DSH-TRAP-WHERE] pc=0x11ff009a0
    [DSH-TRAP-WHERE] lr -> Builtins_InterpreterEntryTrampoline + 0x10c

What this patch does
--------------------
* build_config.h: define the macro for iOS as well. Its real meaning is "this
  platform implements the JIT write-protect hook", which iOS now does.
* build_config.h: V8_HAS_IOS_CODE_ALIAS -> 0. That was patch 03's alternative
  mechanism, mapping the code space twice. It is not used: the second mapping is
  incompatible with V8's memory layout (the heap writes page headers into pages
  that must also be executable), and the build still faulted.
* platform-darwin.cc: implement the hook with mprotect over V8's code range.
  pthread_jit_write_protect_np does not exist on iOS -- dlsym does not find it
  and mmap(MAP_JIT) fails -- so the range is PROT_READ|PROT_WRITE while a write
  scope is open and PROT_READ|PROT_EXEC otherwise.
* platform-darwin.cc: ApplyJitProtectionTo, so a freshly recommitted page is
  returned in the right mode for whatever the range is currently doing.
* platform-posix.cc: RecommitPages routes through that.
* allocation.cc / code-range.cc: hand the range to the hook once it exists.
* v8.gyp: include the trap-handler sources for iOS (the host toolset, running on
  x86_64 Linux, needs the posix handler and the simulator, which no existing
  condition covered).

Note: mprotect is process-wide while the macOS API this replaces is per-thread.
That is a real difference: a thread executing in the range can fault if another
thread opens a write scope, which is why patch 05 also repairs a page on the
fault instead of relying on the scope alone.
"""
import io
import os
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("NODE_TREE", ".")
BUILD_CONFIG = os.path.join(SRC, "deps/v8/src/base/build_config.h")
PLATFORM_H = os.path.join(SRC, "deps/v8/src/base/platform/platform.h")
DARWIN = os.path.join(SRC, "deps/v8/src/base/platform/platform-darwin.cc")
POSIX_CC = os.path.join(SRC, "deps/v8/src/base/platform/platform-posix.cc")
ALLOCATION = os.path.join(SRC, "deps/v8/src/utils/allocation.cc")
CODERANGE = os.path.join(SRC, "deps/v8/src/heap/code-range.cc")
V8GYP = os.path.join(SRC, "tools/v8_gypfiles/v8.gyp")

MARK = "DSH-IOS-JITSCOPE"


def read(p):
    return io.open(p, encoding="utf-8", errors="replace").read()


def write(p, s):
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)


def fail(msg):
    sys.exit("  04 FAIL: " + msg)


# --------------------------------------------------------------- build_config.h
s = read(BUILD_CONFIG)
if "defined(V8_OS_IOS)" in s and "V8_HAS_PTHREAD_JIT_WRITE_PROTECT 1" in s:
    print("  build_config.h: already defines the hook for iOS")
else:
    old = "#if defined(V8_HOST_ARCH_ARM64) && defined(V8_OS_MACOS)\n#define V8_HAS_PTHREAD_JIT_WRITE_PROTECT 1"
    new = (
        "// iOS has no pthread_jit_write_protect_np (dlsym finds nothing and\n"
        "// mmap(MAP_JIT) fails), but the macro's real meaning is \"this platform\n"
        "// implements the JIT write-protect hook\", and on iOS we implement it with\n"
        "// mprotect over the code range -- see platform-darwin.cc. Without this,\n"
        "// RwxMemoryWriteScope compiles to a no-op, code pages are never made\n"
        "// executable, and executing builtins raises SIGBUS at the instruction fetch.\n"
        "#if defined(V8_HOST_ARCH_ARM64) && \\\n"
        "    (defined(V8_OS_MACOS) || defined(V8_OS_IOS))\n"
        "#define V8_HAS_PTHREAD_JIT_WRITE_PROTECT 1"
    )
    if old not in s:
        fail("build_config.h: V8_HAS_PTHREAD_JIT_WRITE_PROTECT anchor not found")
    s = s.replace(old, new, 1)

# and retire the double-mapping alternative
m = re.search(r"#if defined\(V8_OS_IOS\) && defined\(V8_HOST_ARCH_ARM64\)\n"
              r"#define V8_HAS_IOS_CODE_ALIAS 1\n"
              r"#else\n"
              r"#define V8_HAS_IOS_CODE_ALIAS 0\n"
              r"#endif\n", s)
if m:
    s = s[:m.start()] + (
        "// The double-mapping alias is not used: it is incompatible with V8's\n"
        "// memory layout (the heap writes page headers into pages that must also be\n"
        "// executable). The mprotect hook above is what makes JIT work.\n"
        "#define V8_HAS_IOS_CODE_ALIAS 0\n") + s[m.end():]
write(BUILD_CONFIG, s)
print("  build_config.h: hook enabled for iOS, code alias retired")

# ------------------------------------------------------------------ platform.h
s = read(PLATFORM_H)
if "SetJitCodeRange" in s:
    print("  platform.h: already declares the iOS hooks")
else:
    old = ("#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT\n"
           "V8_BASE_EXPORT void SetJitWriteProtected(int enable);\n"
           "#endif")
    new = ("#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT\n"
           "V8_BASE_EXPORT void SetJitWriteProtected(int enable);\n"
           "#endif\n"
           "// Declared unconditionally: callers such as src/node.cc do not include this\n"
           "// header, and a declaration that depends on which macros happen to be\n"
           "// visible in each translation unit is a trap. The definitions exist only\n"
           "// in the iOS build, which is the only build this project makes.\n"
           "V8_BASE_EXPORT void SetJitCodeRange(void* base, size_t size);\n"
           "V8_BASE_EXPORT void ApplyJitProtectionTo(void* addr, size_t size);\n"
           "V8_BASE_EXPORT int FixJitFetchFault(void* addr);\n"
           "V8_BASE_EXPORT int FixJitWriteFault(void* addr);")
    if old not in s:
        fail("platform.h: SetJitWriteProtected block not found")
    s = s.replace(old, new, 1)
    write(PLATFORM_H, s)
    print("  platform.h: iOS hooks declared")

# ---------------------------------------------------------------- darwin impl
s = read(DARWIN)
if MARK in s:
    print("  platform-darwin.cc: already implemented")
else:
    marker = "// See platform-ios.cc for the iOS implementation."
    i = s.find(marker)
    if i == -1:
        fail("platform-darwin.cc: marker comment not found")
    j = s.find("#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT", i)
    if j == -1:
        fail("platform-darwin.cc: no #if after the marker")
    k = s.find("\n#endif", j)
    if k == -1:
        fail("platform-darwin.cc: no #endif after the #if")
    k = s.find("\n", k + 1) + 1

    block = '''// See platform-ios.cc for the iOS implementation -- except that file does not
// exist in this tree, which is the root cause of JIT failing on iOS: V8's
// RwxMemoryWriteScope calls SetJitWriteProtected, nothing implemented it for
// iOS, so code pages were never made executable and executing builtins raised
// SIGBUS at the instruction fetch.
//
// DSH-IOS-JITSCOPE: implement it here with mprotect over V8's code range, which
// the heap registers below. pthread_jit_write_protect_np does not exist on iOS:
// dlsym does not find it, mmap(MAP_JIT) fails, and the SDK marks it unavailable.
//
// mprotect is process-wide while the macOS API is per-thread, so a thread can
// still fault by executing in the range while another thread has a write scope
// open. FixJitFetchFault/FixJitWriteFault (patch 05) repair that page on the
// fault and retry, which is what makes this reliable in practice.
#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT
#if defined(V8_OS_IOS)

namespace {
void* g_code_base = nullptr;
size_t g_code_size = 0;
// Which mode the range should be in when no write scope is open. Toggled by
// ApplyJitProtectionTo so a recommitted page matches its neighbours.
int g_executable = 0;
constexpr size_t kPage = 16384;  // iOS arm64 pages are 16 KB

void Flip(void* addr, size_t size, int prot) {
  if (mprotect(addr, size, prot) != 0) {
    fprintf(stderr, "[jitscope] mprotect(%p, %zu, %d) failed: %s\\n", addr, size,
            prot, strerror(errno));
  }
}
}  // namespace

void SetJitCodeRange(void* base, size_t size) {
  g_code_base = base;
  g_code_size = size;
  g_executable = 0;  // start writable: nothing has been emitted yet
}

// Make the range writable (enable == 0) or executable (enable == 1).
void SetJitWriteProtected(int enable) {
  if (g_code_base == nullptr || g_code_size == 0) return;
  g_executable = enable ? 1 : 0;
  Flip(g_code_base, g_code_size,
       enable ? (PROT_READ | PROT_EXEC) : (PROT_READ | PROT_WRITE));
}

// A page was just recommitted; give it whichever mode the range is in now.
void ApplyJitProtectionTo(void* addr, size_t size) {
  if (g_code_base == nullptr || g_code_size == 0) return;
  Flip(addr, size, g_executable ? (PROT_READ | PROT_EXEC)
                                : (PROT_READ | PROT_WRITE));
}

// Patch 05 builds on these two; it declares FixJitFetchFault/FixJitWriteFault
// itself, so the two patches stay independent of each other.

#else
void SetJitWriteProtected(int enable) {
  pthread_jit_write_protect_np(enable);
}
#endif  // V8_OS_IOS
#endif  // V8_HAS_PTHREAD_JIT_WRITE_PROTECT
'''
    s = s[:i] + block + s[k:]
    if "#include <stdio.h>" not in s:
        # <string.h> and <errno.h> come in with the platform header chain
        m2 = s.find("#include")
        s = s[:m2] + "#include <stdio.h>\n" + s[m2:]
    if "#include <sys/mman.h>" not in s:
        m2 = s.find("#include")
        s = s[:m2] + "#include <sys/mman.h>\n" + s[m2:]
    write(DARWIN, s)
    print("  platform-darwin.cc: mprotect hook implemented")

# ------------------------------------------------- registration: allocation.cc
s = read(ALLOCATION)
if "SetJitCodeRange" in s:
    print("  allocation.cc: already registers the range")
else:
    old = ("bool VirtualMemoryCage::InitReservation(\n"
           "    const ReservationParams& params, base::AddressRegion existing_reservation) {\n")
    new = old + (
        "#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT && defined(V8_OS_IOS)\n"
        "  // DSH-IOS-JITSCOPE: the cage exists now; hand its executable part to the\n"
        "  // W^X hook so it can flip between writable and executable.\n"
        "  ::v8::base::SetJitCodeRange(reinterpret_cast<void*>(allocatable_base),\n"
        "                              allocatable_size);\n"
        "#endif\n")
    if old not in s:
        fail("allocation.cc: VirtualMemoryCage::InitReservation anchor not found")
    s = s.replace(old, new, 1)
    write(ALLOCATION, s)
    print("  allocation.cc: registers the cage")

# --------------------------------------------------- registration: code-range.cc
s = read(CODERANGE)
if "SetJitCodeRange" in s:
    print("  code-range.cc: already registers the range")
else:
    idx = s.find("bool CodeRange::InitReservation")
    if idx == -1:
        print("  code-range.cc: InitReservation not found, skipping")
    else:
        tail = s.find("\n  return true;\n}", idx)
        if tail == -1:
            print("  code-range.cc: end of InitReservation not found, skipping")
        else:
            inject = ("\n#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT && defined(V8_OS_IOS)\n"
                      "  // DSH-IOS-JITSCOPE: hand the code range to the iOS W^X hook.\n"
                      "  ::v8::base::SetJitCodeRange(reinterpret_cast<void*>(region().begin()),\n"
                      "                              region().size());\n"
                      "#endif\n  return true;\n}")
            s = s[:tail] + inject + s[tail + len("\n  return true;\n}"):]
            write(CODERANGE, s)
            print("  code-range.cc: registers the code range")

# ------------------------------------------------------- recommit honours mode
s = read(POSIX_CC)
if "ApplyJitProtectionTo" in s:
    print("  platform-posix.cc: RecommitPages already mode-aware")
else:
    # RecommitPages on Darwin only madvise()s the pages back and returns true; it
    # does not set permissions. A recommitted code page therefore comes back in
    # whatever mode it already had, which is wrong once the range has been flipped
    # to executable. Route it through the hook.
    old = ("#if defined(V8_OS_DARWIN)\n"
           "  while (madvise(address, size, MADV_FREE_REUSE) == -1 && errno == EAGAIN) {\n"
           "  }\n"
           "#endif  // defined(V8_OS_DARWIN)\n"
           "  return true;\n"
           "}\n")
    if old not in s:
        fail("platform-posix.cc: OS::RecommitPages tail not found")
    new = ("#if defined(V8_OS_DARWIN)\n"
           "  while (madvise(address, size, MADV_FREE_REUSE) == -1 && errno == EAGAIN) {\n"
           "  }\n"
           "#endif  // defined(V8_OS_DARWIN)\n"
           "#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT && defined(V8_OS_IOS)\n"
           "  // DSH-IOS-JITSCOPE: this may be a code page. Hand it to the hook, which\n"
           "  // applies whichever mode the code range is currently in -- a page left\n"
           "  // writable faults at the instruction fetch.\n"
           "  ::v8::base::ApplyJitProtectionTo(address, size);\n"
           "#endif\n"
           "  return true;\n"
           "}\n")
    s = s.replace(old, new, 1)
    write(POSIX_CC, s)
    print("  platform-posix.cc: RecommitPages routes through the hook")

# --------------------------------------------------------------- v8.gyp (ios)
s = read(V8GYP)
before = s
s = s.replace('OS in "linux mac openharmony"', 'OS in "linux mac ios openharmony"')
s = s.replace('OS in "linux mac win openharmony"', 'OS in "linux mac ios win openharmony"')
# the cross case: x86_64 host building arm64 target, which no condition covered
anchor = """                ['(_toolset=="host" and host_arch=="x64" or _toolset=="target" and target_arch=="x64" or _toolset=="host" and host_arch=="arm64" or _toolset=="target" and target_arch=="arm64") and OS=="win"', {"""
cross = """                # host on x86_64 simulating an arm64 target: the host tools must
                # run arm64 code, so they need the posix handler and the simulator.
                ['_toolset=="host" and target_arch=="arm64" and OS=="ios"', {
                  'sources': [
                    '<(V8_ROOT)/src/trap-handler/handler-inside-posix.cc',
                    '<(V8_ROOT)/src/trap-handler/handler-outside-posix.cc',
                    '<(V8_ROOT)/src/trap-handler/handler-outside-simulator.cc',
                  ],
                }],
"""
if anchor in s and 'target_arch=="arm64" and OS=="ios"' not in s:
    s = s.replace(anchor, cross + anchor, 1)
if s != before:
    write(V8GYP, s)
    print("  v8.gyp: iOS trap-handler sources added")
else:
    print("  v8.gyp: nothing to change")

print("  04 done")
