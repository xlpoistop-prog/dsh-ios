#!/usr/bin/env python3
# 03 - Fix B: race-free W^X for JIT code on iOS, by mapping the code space twice.
#
# The problem
# -----------
# iOS enforces W^X in hardware. An RWX request is silently downgraded to RW, and
# executing those pages faults; MAP_JIT pages are not executable either. So a JIT
# has to keep code pages writable *or* executable, and switch.
#
# Every published iOS Node port does exactly that: it keeps a list of code ranges
# and flips each one RW <-> RX with mprotect when V8 enters and leaves a write
# scope. That cannot be made race-free. The protection is process-wide, so the
# moment one thread makes a range writable, any other thread executing in that
# range faults. The published recipe's own comment says so, and its answer is to
# require `node --predictable --single-threaded`, which removes the concurrency
# rather than the race.
#
# The fix
# -------
# Map the same physical pages twice: one mapping kept writable, one kept
# executable. Nothing ever changes protection, so there is nothing to race over.
#
#   - V8's addresses are the *executable* mapping, so generated code runs.
#   - Every write to that space is redirected to the writable mapping. V8 funnels
#     all writes to JIT memory through WritableJitAllocation, which is why this
#     is a small change rather than a rewrite.
#   - Every permission request V8 makes is applied to the writable mapping (the
#     access it asked for) and mirrored to the executable one as R+X (or
#     NoAccess, for pages V8 is giving back).
#
# Verified on the device before any of this was written: two mappings of the same
# page, one writable and one executable, then 58,927,119 executions of the code
# through the executable mapping concurrent with 400,000 rewrites through the
# writable one -- zero faults, zero wrong results. The same probe also recorded
# that RWX is downgraded (`mach_vm_region` reports RW- after asking for RWX) and
# that executing the downgraded page is a SIGBUS, which is what rules the
# simpler designs out.
#
# Consequences: no --predictable, no --single-threaded, no protection flips, and
# background compilation threads can run while code executes.
#
# Usage: 03-fix-wx-alias.py <node-source-dir>
import sys
import pathlib

applied, skipped = [], []


def fail(msg):
    print("FAIL: " + msg, file=sys.stderr)
    sys.exit(1)


def patch(src, rel, old, new, label, marker, count=1):
    """count=1: exactly one match. count=None: all matches, at least one."""
    p = src / rel
    if not p.exists():
        fail(f"{rel} does not exist — wrong source tree?")
    s = p.read_text(encoding="utf-8")
    if marker in s:
        skipped.append(label)
        print(f"  skip (already applied): {label}")
        return
    found = s.count(old)
    if count is None:
        if found < 1:
            fail(f"{rel}: no match for '{label}'\n      anchor: {old[:110]!r}")
    elif found != count:
        fail(f"{rel}: expected {count} match(es) for '{label}', found {found}\n"
             f"      anchor: {old[:110]!r}")
    p.write_text(s.replace(old, new), encoding="utf-8")
    applied.append(label)
    print(f"  applied: {label} ({found} site(s))")


# --------------------------------------------------------------------------
# The platform implementation, injected into platform-darwin.cc (compiled for
# macOS and iOS, and already the home of the JIT-protection primitives).
# --------------------------------------------------------------------------
DARWIN_IMPL = r'''
#if V8_HAS_IOS_CODE_ALIAS

#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <mach/vm_prot.h>
#include <sys/mman.h>

// iOS port: the code space exists twice. `writable` is what V8 writes through,
// `executable` is what V8 executes and what all of its pointers refer to.
// Nothing ever changes the protection of either, so no write can race with an
// execution. See 03-fix-wx-alias.py for the on-device evidence behind this.
namespace {
struct CodeAliasRange {
  Address writable;
  size_t size;
  Address executable;
};

// The JS code range plus one range per wasm code space. Writes are not the hot
// path for JIT memory, so a linear scan is enough.
constexpr int kMaxCodeAliasRanges = 64;
CodeAliasRange g_code_alias_ranges[kMaxCodeAliasRanges];
int g_code_alias_count = 0;
}  // namespace

V8_BASE_EXPORT bool ReserveWithExecutableAlias(v8::PageAllocator* allocator,
                                               size_t size, void** writable,
                                               void** executable) {
  const size_t alignment = allocator->AllocatePageSize();
  void* w = allocator->AllocatePages(nullptr, size, alignment,
                                     v8::PageAllocator::kNoAccess);
  if (w == nullptr) return false;

  // Same pages, second address. Asking for alignment costs nothing and keeps the
  // cage's own rounding from eating part of the range.
  mach_vm_address_t alias = 0;
  vm_prot_t cur = 0, max = 0;
  kern_return_t kr = mach_vm_remap(
      mach_task_self(), &alias, size, static_cast<mach_vm_offset_t>(alignment - 1),
      VM_FLAGS_ANYWHERE, mach_task_self(),
      reinterpret_cast<mach_vm_address_t>(w), /*copy=*/FALSE, &cur, &max,
      VM_INHERIT_NONE);
  if (kr != KERN_SUCCESS) {
    allocator->FreePages(w, size);
    return false;
  }

  // The executable side is R+X from here on and never changes.
  kr = mach_vm_protect(mach_task_self(), alias, size, /*set_maximum=*/FALSE,
                       VM_PROT_READ | VM_PROT_EXECUTE);
  if (kr != KERN_SUCCESS) {
    mach_vm_deallocate(mach_task_self(), alias, size);
    allocator->FreePages(w, size);
    return false;
  }

  *writable = w;
  *executable = reinterpret_cast<void*>(alias);
  return true;
}

V8_BASE_EXPORT void RegisterCodeAlias(void* writable, size_t size,
                                      void* executable) {
  CHECK_LT(g_code_alias_count, kMaxCodeAliasRanges);
  g_code_alias_ranges[g_code_alias_count++] = {
      reinterpret_cast<Address>(writable), size,
      reinterpret_cast<Address>(executable)};
}

namespace {
const CodeAliasRange* FindCodeAliasRange(Address address) {
  for (int i = 0; i < g_code_alias_count; i++) {
    const CodeAliasRange& r = g_code_alias_ranges[i];
    if (address >= r.executable && address < r.executable + r.size) return &r;
  }
  return nullptr;
}
}  // namespace

V8_BASE_EXPORT Address CodeAliasWritableAddress(Address executable_address) {
  const CodeAliasRange* r = FindCodeAliasRange(executable_address);
  if (r == nullptr) return executable_address;
  return r->writable + (executable_address - r->executable);
}

V8_BASE_EXPORT bool CodeAliasHandlePermissions(void* address, size_t size,
                                               OS::MemoryPermission access) {
  const Address a = reinterpret_cast<Address>(address);
  const CodeAliasRange* r = FindCodeAliasRange(a);
  if (r == nullptr) return false;
  DCHECK_LE(a + size, r->executable + r->size);

  // kNoAccess and kNoAccessWillJitLater mean "give the pages back": they have to
  // become inaccessible in *both* mappings, since protection is per mapping even
  // though the pages are shared. Every other request is a request to write, so
  // the writable mapping gets the access asked for and the executable mapping
  // stays R+X.
  const bool inaccessible =
      (access == OS::MemoryPermission::kNoAccess ||
       access == OS::MemoryPermission::kNoAccessWillJitLater);
  const int writable_prot = inaccessible ? PROT_NONE : (PROT_READ | PROT_WRITE);
  const int executable_prot = inaccessible ? PROT_NONE : (PROT_READ | PROT_EXEC);

  void* w = reinterpret_cast<void*>(r->writable + (a - r->executable));
  CHECK_EQ(0, mprotect(w, size, writable_prot));
  CHECK_EQ(0, mprotect(address, size, executable_prot));
  return true;
}

V8_BASE_EXPORT void FreeCodeAlias(void* address, size_t size) {
  const Address a = reinterpret_cast<Address>(address);
  const CodeAliasRange* found = FindCodeAliasRange(a);
  if (found == nullptr) return;
  for (int i = 0; i < g_code_alias_count; i++) {
    if (&g_code_alias_ranges[i] != found) continue;
    // Unmap the executable twin; the writable one is freed by the caller through
    // the page allocator it came from. Drop the entry so later writes to the
    // reused address are not redirected into a stale mapping.
    mach_vm_deallocate(mach_task_self(), found->executable, found->size);
    g_code_alias_ranges[i] = g_code_alias_ranges[--g_code_alias_count];
    return;
  }
}

#endif  // V8_HAS_IOS_CODE_ALIAS
'''

PLATFORM_H_DECLS = r'''
#if V8_HAS_IOS_CODE_ALIAS
// iOS port: reserve memory writable and map the same physical pages a second
// time, executable. The caller uses the executable address as its code space;
// writes are redirected to the writable one by CodeAliasWritableAddress and
// permission changes are mirrored by CodeAliasHandlePermissions.
V8_BASE_EXPORT bool ReserveWithExecutableAlias(v8::PageAllocator* allocator,
                                               size_t size, void** writable,
                                               void** executable);
V8_BASE_EXPORT void RegisterCodeAlias(void* writable, size_t size,
                                      void* executable);
V8_BASE_EXPORT Address CodeAliasWritableAddress(Address executable_address);
V8_BASE_EXPORT bool CodeAliasHandlePermissions(void* address, size_t size,
                                               OS::MemoryPermission access);
V8_BASE_EXPORT void FreeCodeAlias(void* address, size_t size);
#endif  // V8_HAS_IOS_CODE_ALIAS
'''


def main():
    if len(sys.argv) != 2:
        fail("usage: 03-fix-wx-alias.py <node-source-dir>")
    src = pathlib.Path(sys.argv[1]).resolve()
    if not (src / "node.gyp").exists():
        fail(f"{src} does not look like a Node.js source tree")
    print(f"== Fix B (dual-mapped code space) -> {src}")

    # --- 1. the backend macro.
    patch(src, "deps/v8/src/base/build_config.h",
          "#if defined(V8_OS_LINUX) && defined(V8_HOST_ARCH_X64)\n"
          "#define V8_HAS_PKU_JIT_WRITE_PROTECT 1",
          "// iOS port: the code space is mapped twice -- once writable, once\n"
          "// executable -- instead of flipping protection on a single mapping.\n"
          "// iOS enforces W^X in hardware (an RWX request is downgraded to RW and\n"
          "// executing it faults) and offers no per-thread or pkey JIT write\n"
          "// protection, so a flip can never be race-free: a thread executing in\n"
          "// the range faults the moment another thread makes it writable.\n"
          "#if defined(V8_OS_IOS) && defined(V8_HOST_ARCH_ARM64)\n"
          "#define V8_HAS_IOS_CODE_ALIAS 1\n"
          "#else\n"
          "#define V8_HAS_IOS_CODE_ALIAS 0\n"
          "#endif\n"
          "\n"
          "#if defined(V8_OS_LINUX) && defined(V8_HOST_ARCH_X64)\n"
          "#define V8_HAS_PKU_JIT_WRITE_PROTECT 1",
          "build_config.h: V8_HAS_IOS_CODE_ALIAS",
          marker="#define V8_HAS_IOS_CODE_ALIAS 1")

    # --- 2. the heap-side switch, worded like the other backends.
    patch(src, "deps/v8/src/common/globals.h",
          "// Protect the JavaScript heap with memory protection keys.",
          "// Protect the JavaScript heap by mapping the code space twice.\n"
          "//\n"
          "// Unlike the pthread/pkey/becore backends this is deliberately not\n"
          "// guarded by !(V8_COMPRESS_POINTERS && !V8_EXTERNAL_CODE_SPACE). That\n"
          "// guard turns a backend off when code lives inside the pointer\n"
          "// compression cage; with two mappings the code space is a reservation of\n"
          "// its own either way, and silently turning this off would leave the\n"
          "// build assuming permanently-writable code memory -- which on iOS is a\n"
          "// write fault on the first JIT allocation. The build below fails loudly\n"
          "// instead.\n"
          "#if V8_HAS_IOS_CODE_ALIAS && defined(V8_COMPRESS_POINTERS) && \\\n"
          "    !defined(V8_EXTERNAL_CODE_SPACE)\n"
          "#error \"iOS code alias needs an external code space\"\n"
          "#endif\n"
          "#if V8_HAS_IOS_CODE_ALIAS\n"
          "#define V8_HEAP_USE_IOS_CODE_ALIAS true\n"
          "#else\n"
          "#define V8_HEAP_USE_IOS_CODE_ALIAS false\n"
          "#endif\n"
          "\n"
          "// Protect the JavaScript heap with memory protection keys.",
          "globals.h: V8_HEAP_USE_IOS_CODE_ALIAS",
          marker="#define V8_HEAP_USE_IOS_CODE_ALIAS true")

    # --- 3. platform.h: declare the helpers next to the existing JIT primitive.
    patch(src, "deps/v8/src/base/platform/platform.h",
          "#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT\n"
          "V8_BASE_EXPORT void SetJitWriteProtected(int enable);\n"
          "#endif",
          "#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT\n"
          "V8_BASE_EXPORT void SetJitWriteProtected(int enable);\n"
          "#endif\n" + PLATFORM_H_DECLS,
          "platform.h: alias helper declarations",
          marker="ReserveWithExecutableAlias")

    # --- 4. platform-darwin.cc: the implementation.
    patch(src, "deps/v8/src/base/platform/platform-darwin.cc",
          "V8_BASE_EXPORT void SetJitWriteProtected(int enable) {\n"
          "  pthread_jit_write_protect_np(enable);\n"
          "}",
          "V8_BASE_EXPORT void SetJitWriteProtected(int enable) {\n"
          "  pthread_jit_write_protect_np(enable);\n"
          "}" + DARWIN_IMPL,
          "platform-darwin.cc: dual mapping implementation",
          marker="ReserveWithExecutableAlias")

    # --- 5. platform-posix.cc: route permission requests through the alias.
    # Anchored per function rather than on the shared DCHECK preamble: five
    # functions in this file start with those two DCHECKs, and OS::Release is not
    # a permission change. The handler is a no-op for any address outside a
    # registered range, so a wrong guess here could not quietly corrupt anything,
    # but hooking the wrong function would still be wrong.
    alias_note = ("#if V8_HAS_IOS_CODE_ALIAS\n"
                  "  // The caller is describing the executable mapping. Apply what\n"
                  "  // it asked for to the writable twin, and keep the executable one\n"
                  "  // executable. Nothing here flips protection back and forth.\n"
                  "  if (CodeAliasHandlePermissions(address, size, %s)) return true;\n"
                  "#endif\n")
    for sig, arg, label in [
        ("bool OS::SetPermissions(void* address, size_t size, MemoryPermission access) {",
         "access", "SetPermissions"),
        ("bool OS::RecommitPages(void* address, size_t size, MemoryPermission access) {",
         "access", "RecommitPages"),
        ("bool OS::DiscardSystemPages(void* address, size_t size) {",
         "OS::MemoryPermission::kNoAccess", "DiscardSystemPages"),
        ("bool OS::DecommitPages(void* address, size_t size) {",
         "OS::MemoryPermission::kNoAccess", "DecommitPages"),
    ]:
        patch(src, "deps/v8/src/base/platform/platform-posix.cc",
              sig + "\n",
              sig + "\n" + (alias_note % arg),
              f"platform-posix.cc: {label} mirrors to the alias",
              # the marker has to name the function: four of these hooks differ
              # only in the argument they pass, so a shared marker would make the
              # 2nd..4th look already-applied and silently skip them.
              marker=sig + "\n" + (alias_note % arg))

    # --- 6. the same for returning memory: the executable twin must go too, or
    # stale code stays executable over pages V8 believes it has given back.
    patch(src, "deps/v8/src/base/platform/platform-posix.cc",
          "void OS::Free(void* address, size_t size) {",
          "void OS::Free(void* address, size_t size) {\n"
          "#if V8_HAS_IOS_CODE_ALIAS\n"
          "  FreeCodeAlias(address, size);\n"
          "#endif",
          "platform-posix.cc: OS::Free drops the alias",
          marker="FreeCodeAlias(address, size);")

    # --- 7. page-allocator.cc: fold kNoAccessWillJitLater like the other
    # Apple backends, since this port supplies its own reservation.
    patch(src, "deps/v8/src/base/page-allocator.cc",
          "#if !V8_HAS_PTHREAD_JIT_WRITE_PROTECT && !V8_HAS_BECORE_JIT_WRITE_PROTECT",
          "#if !V8_HAS_PTHREAD_JIT_WRITE_PROTECT && \\\n"
          "    !V8_HAS_BECORE_JIT_WRITE_PROTECT && !V8_HAS_IOS_CODE_ALIAS",
          "page-allocator.cc: kNoAccessWillJitLater folded",
          marker="!V8_HAS_BECORE_JIT_WRITE_PROTECT && !V8_HAS_IOS_CODE_ALIAS")

    # --- 8. code-memory-access-inl.h: the write scope becomes a no-op, and every
    # store is redirected to the writable mapping.
    patch(src, "deps/v8/src/common/code-memory-access-inl.h",
          "#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT\n"
          "#include \"src/base/platform/platform.h\"\n"
          "#endif",
          "#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT || V8_HAS_IOS_CODE_ALIAS\n"
          "#include \"src/base/platform/platform.h\"\n"
          "#endif\n"
          "\n"
          "#if V8_HAS_IOS_CODE_ALIAS\n"
          "// Redirect a write to the writable twin of the code space. The two\n"
          "// mappings share physical pages, so what is written here is what runs\n"
          "// there. A no-op everywhere else.\n"
          "#define DSH_CODE_ALIAS_ADDRESS(a) ::v8::base::CodeAliasWritableAddress(a)\n"
          "#else\n"
          "#define DSH_CODE_ALIAS_ADDRESS(a) (a)\n"
          "#endif",
          "code-memory-access-inl.h: write translation macro",
          marker="DSH_CODE_ALIAS_ADDRESS")

    # the write scope: nothing to do, because nothing changes protection
    patch(src, "deps/v8/src/common/code-memory-access-inl.h",
          "#if V8_HAS_PTHREAD_JIT_WRITE_PROTECT\n"
          "\n"
          "// static\n"
          "bool RwxMemoryWriteScope::IsSupported() { return true; }\n"
          "\n"
          "// static\n"
          "void RwxMemoryWriteScope::SetWritable() { base::SetJitWriteProtected(0); }\n"
          "\n"
          "// static\n"
          "void RwxMemoryWriteScope::SetExecutable() { base::SetJitWriteProtected(1); }\n",
          "#if V8_HAS_IOS_CODE_ALIAS\n"
          "\n"
          "// static\n"
          "bool RwxMemoryWriteScope::IsSupported() { return true; }\n"
          "\n"
          "// The writable mapping is always writable and the executable one always\n"
          "// executable, so entering a write scope changes nothing. This is the\n"
          "// whole point: no protection flip means no window in which another\n"
          "// thread can fault.\n"
          "// static\n"
          "void RwxMemoryWriteScope::SetWritable() {}\n"
          "\n"
          "// static\n"
          "void RwxMemoryWriteScope::SetExecutable() {}\n"
          "\n"
          "#elif V8_HAS_PTHREAD_JIT_WRITE_PROTECT\n"
          "\n"
          "// static\n"
          "bool RwxMemoryWriteScope::IsSupported() { return true; }\n"
          "\n"
          "// static\n"
          "void RwxMemoryWriteScope::SetWritable() { base::SetJitWriteProtected(0); }\n"
          "\n"
          "// static\n"
          "void RwxMemoryWriteScope::SetExecutable() { base::SetJitWriteProtected(1); }\n",
          "code-memory-access-inl.h: write scope is a no-op",
          marker="The writable mapping is always writable")

    # every store site, wrapped
    patch(src, "deps/v8/src/common/code-memory-access-inl.h",
          "HeapObject::FromAddress(address_)",
          "HeapObject::FromAddress(DSH_CODE_ALIAS_ADDRESS(address_))",
          "write translation: all header-slot stores",
          marker="HeapObject::FromAddress(DSH_CODE_ALIAS_ADDRESS(address_))",
          count=None)
    patch(src, "deps/v8/src/common/code-memory-access-inl.h",
          "WriteMaybeUnalignedValue<T>(address_ + offset, value);",
          "WriteMaybeUnalignedValue<T>(DSH_CODE_ALIAS_ADDRESS(address_ + offset), value);",
          "write translation: unaligned header slot",
          marker="DSH_CODE_ALIAS_ADDRESS(address_ + offset), value)")
    patch(src, "deps/v8/src/common/code-memory-access-inl.h",
          "  base::WriteUnalignedValue<T>(address, value);",
          "  base::WriteUnalignedValue<T>(DSH_CODE_ALIAS_ADDRESS(address), value);",
          "write translation: WriteUnalignedValue",
          marker="WriteUnalignedValue<T>(DSH_CODE_ALIAS_ADDRESS(address)")
    patch(src, "deps/v8/src/common/code-memory-access-inl.h",
          "  base::Memory<T>(address) = value;",
          "  base::Memory<T>(DSH_CODE_ALIAS_ADDRESS(address)) = value;",
          "write translation: WriteValue",
          marker="base::Memory<T>(DSH_CODE_ALIAS_ADDRESS(address)) = value;")
    patch(src, "deps/v8/src/common/code-memory-access-inl.h",
          "  reinterpret_cast<std::atomic<T>*>(address)->store(value,\n"
          "                                                    std::memory_order_relaxed);",
          "  reinterpret_cast<std::atomic<T>*>(DSH_CODE_ALIAS_ADDRESS(address))\n"
          "      ->store(value, std::memory_order_relaxed);",
          "write translation: relaxed atomic store",
          # marker is the whole replacement: a shorter one collides with the
          # WriteValue edit above and the patch is then skipped as "already
          # applied" without ever being applied.
          marker="reinterpret_cast<std::atomic<T>*>(DSH_CODE_ALIAS_ADDRESS(address))\n"
                 "      ->store(value, std::memory_order_relaxed);")
    patch(src, "deps/v8/src/common/code-memory-access-inl.h",
          "CopyBytes(reinterpret_cast<uint8_t*>(address_ + dst_offset), src, num_bytes);",
          "CopyBytes(\n"
          "      reinterpret_cast<uint8_t*>(DSH_CODE_ALIAS_ADDRESS(address_ + dst_offset)),\n"
          "      src, num_bytes);",
          "write translation: CopyCode/CopyData",
          marker="DSH_CODE_ALIAS_ADDRESS(address_ + dst_offset)),",
          count=None)
    patch(src, "deps/v8/src/common/code-memory-access-inl.h",
          "  memset(reinterpret_cast<void*>(address_ + offset), 0, len);",
          "  memset(reinterpret_cast<void*>(DSH_CODE_ALIAS_ADDRESS(address_ + offset)), 0,\n"
          "         len);",
          "write translation: ClearBytes",
          marker="DSH_CODE_ALIAS_ADDRESS(address_ + offset)), 0,")

    # --- 9. code-range.cc: reserve the pair and hand the executable half to the
    # cage as an existing reservation.
    patch(src, "deps/v8/src/heap/code-range.cc",
          "  VirtualMemoryCage::ReservationParams params;\n"
          "  params.page_allocator = page_allocator;\n"
          "  params.reservation_size = requested;",
          "#if V8_HAS_IOS_CODE_ALIAS\n"
          "  // Reserve the pair now and let the cage adopt the executable mapping as\n"
          "  // an existing reservation, so every address V8 sees is executable and\n"
          "  // every write is redirected to the writable twin.\n"
          "  void* alias_writable = nullptr;\n"
          "  void* alias_executable = nullptr;\n"
          "  if (!::v8::base::ReserveWithExecutableAlias(page_allocator, requested,\n"
          "                                              &alias_writable,\n"
          "                                              &alias_executable)) {\n"
          "    return false;\n"
          "  }\n"
          "  ::v8::base::RegisterCodeAlias(alias_writable, requested, alias_executable);\n"
          "#endif\n"
          "\n"
          "  VirtualMemoryCage::ReservationParams params;\n"
          "  params.page_allocator = page_allocator;\n"
          "  params.reservation_size = requested;",
          "code-range.cc: reserve the alias pair",
          marker="ReserveWithExecutableAlias(page_allocator, requested")

    patch(src, "deps/v8/src/heap/code-range.cc",
          "#if defined(V8_TARGET_OS_IOS)\n"
          "  // We only get one shot at doing MAP_JIT on iOS. So we need to make it\n"
          "  // the least restrictive so it succeeds otherwise we will terminate the\n"
          "  // process on the failed allocation.\n"
          "  params.requested_start_hint = kNullAddress;\n"
          "  if (!VirtualMemoryCage::InitReservation(params)) return false;",
          "#if V8_HAS_IOS_CODE_ALIAS\n"
          "  // Adopt the executable mapping we already reserved (and registered) in\n"
          "  // place of letting the cage reserve its own. The cage does not own an\n"
          "  // existing reservation, which is exactly right: the writable twin has to\n"
          "  // outlive it, since writes keep going there for the life of the process.\n"
          "  if (!VirtualMemoryCage::InitReservation(\n"
          "          params, base::AddressRegion(\n"
          "                      reinterpret_cast<Address>(alias_executable), requested))) {\n"
          "    return false;\n"
          "  }\n"
          "#elif defined(V8_TARGET_OS_IOS)\n"
          "  // We only get one shot at doing MAP_JIT on iOS. So we need to make it\n"
          "  // the least restrictive so it succeeds otherwise we will terminate the\n"
          "  // process on the failed allocation.\n"
          "  params.requested_start_hint = kNullAddress;\n"
          "  if (!VirtualMemoryCage::InitReservation(params)) return false;",
          "code-range.cc: cage adopts the executable alias",
          marker="alias_executable), requested)))")

    # --- 10. wasm has its own code space, so it needs its own pair.
    patch(src, "deps/v8/src/wasm/wasm-code-manager.cc",
          "VirtualMemory WasmCodeManager::TryAllocate(size_t size) {",
          "VirtualMemory WasmCodeManager::TryAllocate(size_t size) {\n"
          "#if V8_HAS_IOS_CODE_ALIAS\n"
          "  // The wasm code space is committed RWX, which iOS downgrades to RW, so\n"
          "  // wasm code would never be executable. Give it the same treatment as the\n"
          "  // JS code range: a writable mapping plus an executable twin, with the\n"
          "  // executable one handed back as the space's address.\n"
          "  {\n"
          "    v8::PageAllocator* allocator = GetPlatformPageAllocator();\n"
          "    const size_t alignment = allocator->AllocatePageSize();\n"
          "    const size_t reservation = RoundUp(size, alignment);\n"
          "    void* writable = nullptr;\n"
          "    void* executable = nullptr;\n"
          "    if (::v8::base::ReserveWithExecutableAlias(allocator, reservation, &writable,\n"
          "                                               &executable)) {\n"
          "      ::v8::base::RegisterCodeAlias(writable, reservation, executable);\n"
          "      return VirtualMemory(allocator,\n"
          "                           reinterpret_cast<Address>(executable), reservation);\n"
          "    }\n"
          "  }\n"
          "#endif",
          "wasm-code-manager.cc: wasm code space gets an alias",
          # marker must be text that the injection itself contains, or the patch
          # re-applies on every run (the label alone appears nowhere in the file).
          marker="if (::v8::base::ReserveWithExecutableAlias(allocator, reservation, &writable,")

    print(f"== done: {len(applied)} applied, {len(skipped)} already applied")
    return 0


if __name__ == "__main__":
    sys.exit(main())
