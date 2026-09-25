# node-ios

Building Node.js for a jailbroken iOS device, and the reason JIT now runs there.

`build-node-ios.sh` is the recipe; `patches/` is what makes it produce a binary
that runs DSH. This file records what each patch is for and what was measured,
so the next person does not have to rediscover it.

## Build it

```sh
NODE_VERSION=24.21.0 sh node-ios/build-node-ios.sh
```

Runs on macOS with Xcode. It also runs on Linux with clang and an extracted
iPhoneOS SDK — that is the path this project actually used, through a cloud box
and a 12-core VM:

```sh
SDK=/path/to/iPhoneOS18.5.sdk
SHIM=$PWD/node-ios/ios-sdk-shim
export CC="clang -fuse-ld=lld -target arm64-apple-ios16.0 -isysroot $SDK \
            -miphoneos-version-min=16.0 -I$SHIM \
            -framework CoreFoundation -framework CoreServices -framework Security"
export CXX="clang++ -fuse-ld=lld -target arm64-apple-ios16.0 -isysroot $SDK \
            -miphoneos-version-min=16.0 -stdlib=libc++ -std=gnu++20 -I$SHIM \
            -framework CoreFoundation -framework CoreServices -framework Security"
export CC_host=./hostcc CXX_host=./hostcxx      # see below
export GYP_DEFINES="OS=ios target_arch=arm64 host_arch=x64 host_os=linux target_os=ios"
python3 configure --dest-os=ios --dest-cpu=arm64 --cross-compiling \
  --with-intl=small-icu --without-npm --without-node-snapshot \
  --without-node-code-cache --without-inspector --openssl-no-asm
make -j"$(nproc)" AR=llvm-ar RANLIB=llvm-ranlib
```

Two host-toolchain details, both of which cost a build:

* `host_os=linux` needs `-Wl,--start-group … -Wl,--end-group` around the link,
  because GNU ld resolves static archives strictly in order and V8's host
  libraries are mutually recursive. Wrap the host compilers:

  ```sh
  printf '#!/bin/sh\nexec clang -D_GNU_SOURCE -Wl,--start-group "$@" -Wl,--end-group -l:libatomic.so.1\n' > hostcc
  printf '#!/bin/sh\nexec clang++ -D_GNU_SOURCE -std=gnu++20 -Wl,--start-group "$@" -Wl,--end-group -l:libatomic.so.1\n' > hostcxx
  chmod +x hostcc hostcxx
  ```

* `-l:libatomic.so.1` is not optional: 16-byte atomics in `wasm-code-manager.cc`
  and `isolate.cc` otherwise fail to link, and Debian ships no `libatomic.so`
  symlink without the `-dev` package. Name the soname, not the symlink.

## The one that matters: `OS=ios`

`gyp` reads `GYP_DEFINES` from the environment, and the environment wins over
`configure --dest-os=ios`. Without `OS=ios` there, gyp evaluates `OS` as the
*build host* — `mac`, or `linux` on the path above — so every `OS=="ios"`
condition in node and v8 silently fails.

That single missing word is the root cause of an entire error family:

```
deps/zlib/cpu_features.c:  <asm/hwcap.h> not found   (a Linux header)
deps/cares/...:            <sys/random.h> not found  (a Linux header)
undefined reference to `v8_internal_simulator_ProbeMemory`      (host link)
undefined reference to `TryHandleSignal`, `RegisterDefaultTrapHandler`
```

and of the iOS-only branches in patches 01, 02 and 04 being dead code while they
were being written. Fix the word and the conditions start working.

## Patches

| patch | what it does |
|---|---|
| `01-ios-base.py` | the base port: gyp and toolchain conditions so an iOS target is built as iOS at all |
| `02-fix-trap-handler.py` | makes V8's wasm decisions agree, instead of the launcher having to pass `--wasm-enforce-bounds-checks` |
| `03-fix-wx-alias.py` | **not applied.** Maps the code space twice. Kept for the record — see below |
| `04-ios-jit-wx-hook.py` | implements the W^X hook V8 never got on iOS |
| `05-ios-jit-fault-repair.py` | repairs a code page on the fault, then retries |

All are anchor-checked (they abort rather than half-apply) and idempotent.

### 04 — the missing implementation

`platform-darwin.cc` says:

```c
// See platform-ios.cc for the iOS implementation.
```

`platform-ios.cc` does not exist in this tree. Nothing else implements
`SetJitWriteProtected` for iOS either, because V8 only declares the hook when
`V8_HAS_PTHREAD_JIT_WRITE_PROTECT` is 1, and `build_config.h` sets that to 1 only
for arm64 macOS:

```c
// pthread_jit_write_protect is only available on arm64 Mac.
#if defined(V8_HOST_ARCH_ARM64) && defined(V8_OS_MACOS)
```

So on iOS the macro is 0, `platform.h` compiles the declaration out,
`RwxMemoryWriteScope` becomes a no-op, code pages are never made executable, and
executing the first builtin in a non-writable page faults **at the instruction
fetch**:

```
[DSH-TRAP-WHERE] signal=10 si_code=1 addr=0x11ff009a0
[DSH-TRAP-WHERE] pc=0x11ff009a0
[DSH-TRAP-WHERE] lr -> Builtins_InterpreterEntryTrampoline + 0x10c
```

`si_code` 1 is `BUS_ADRALN`. Read that carefully: an alignment fault on an
instruction fetch is not an alignment problem, it is the kernel reporting "this
page is not executable" in the only way that path can. `pc == si_addr`, and the
address is inside the registered code range.

04 enables the macro for iOS and implements the hook with `mprotect` over the
range: `PROT_READ|PROT_WRITE` while a write scope is open, `PROT_READ|PROT_EXEC`
otherwise. `pthread_jit_write_protect_np` is not an option — `dlsym` does not
find it, `mmap(MAP_JIT)` fails, and the SDK marks it unavailable. V8's own
alternative is gated on `__IPHONE_17_4`, which a 17.1.1 device does not have.

### 05 — repair on the fault

`mprotect` is process-wide; the macOS API it stands in for is per-thread. So a
range that is writable because *this* thread opened a write scope is writable for
every other thread, and one of them can fetch from it and fault. Without 05, with
04 applied:

```
[DSH-TRAP-WHERE] pc=0x11f700c68 lr=0x1033b9c4c
[DSH-TRAP-WHERE] lr -> Builtins_InterpreterOnStackReplacement_ToBaseline + 0x8c
Bus error: 10
```

05 handles the fault instead of dying on it: if the fault address is inside the
code range, make its 16 KB page executable (fetch fault) or writable (write
fault) and return, which makes the kernel retry the faulting instruction. Outside
the range, behaviour is unchanged — a genuine segfault still crashes.

### 03 — why it is not applied

03 maps the code space twice and claims JIT then needs neither
`--predictable --single-threaded` nor `--jitless`. Measured, that is not true:

* the second mapping is incompatible with V8's memory layout — the heap writes
  page headers into pages that must also be executable;
* the resulting build still faults.

04 and 05 are what actually work.

## Measured, on the device

| | `--jitless` | JIT |
|---|---|---|
| 20M-iteration loop | ~1060 ms | **~300 ms (3.5×)** |
| cold boot to first token | 45 s | **17 s (2.6×)** |
| `JSON.parse`/`stringify` 5×50k | 311 ms | 306 ms (native C++, unaffected) |

Confirmed in the running server, not just in a one-off test — V8 reports
`Optimized + Maglev + OptimizingConcurrently`, `LiteMode=false`.

Working under JIT: plain JS, regular expressions with Unicode property escapes,
WebAssembly (native again — under `--jitless` `typeof WebAssembly` is
`undefined`), file I/O, and multi-million-iteration loops. Not reliable: worker
threads, for the process-wide `mprotect` reason above.

## The trap that hid all of this

`NODE_OPTIONS` is equivalent to the command line. So this line in `start.sh`

```sh
export NODE_OPTIONS=--jitless
```

kept the server a pure interpreter *even after* `--jitless` had been removed from
argv — JIT measured fine in isolation while DSH stayed slow, which is a very
convincing way to conclude the wrong thing.

Diagnose from `env | grep NODE_OPTIONS`, never from the process command line.
`scripts/start.sh` now strips `--jitless` from `NODE_OPTIONS` and honours
`DSH_JITLESS=1` to restore the old behaviour.

Stripping it has its own trap: this device's `/bin/sh` is **dash**, which has no
`${var//pat/}`. That expansion fails at *expansion* time with `Bad substitution`,
so `sh -n` reports the script as fine and it dies on first run. `start.sh` uses a
POSIX `for` loop and only removes `--jitless` itself, so memory flags someone set
survive. It was verified by running the real block under `dash` for six inputs,
not by a syntax check.

## Diagnostics worth keeping

Two things made this findable, and both are cheap:

* a signal handler that logs `signo`, `si_code`, `si_addr`, `pc`, `lr`, `sp` and
  `dladdr()` symbols before dying — `pc == si_addr` plus `lr -> Builtins_*` was
  what identified "not executable" rather than "bad memory";
* probes that establish what the kernel actually permits, before designing around
  what the documentation implies. `mprotect` to RWX is silently downgraded to RW
  on iOS; a 256 MB `PROT_NONE` reservation chunked to RW, written, flipped to RX
  and executed works; `fork()` breaks execution of remapped pages. Each of those
  took minutes and each of them killed a plan that an assumption had built.
