# What iOS actually forbids, and how each obstacle was dealt with

A record of every wall hit while getting DSH running on a stock iOS build of
Node, in roughly the order they appeared. Each entry says what the platform
does, what the symptom looks like, and what the workaround costs.

Verified on iPhone 15 (A16), iOS 17.1.1, Relaxin (rootHide), Node 24.21.0.

> **Status note, added later.** §1 was the wall this port was built around, and
> it has since been taken down: JIT runs, and the port no longer passes
> `--jitless`. The root cause was not what this document originally said it was,
> so §1 and §2 are annotated rather than left as written. Everything else here
> still holds. See [`../node-ios/README.md`](../node-ios/README.md).

---

## 1. V8 could not generate code → SIGBUS  *(solved)*

Stock iOS builds of Node fault as soon as they execute JavaScript. On the A16
the fault surfaces as `SIGBUS` in the codegen path.

The original text here said the device "refuses the memory the JIT needs". **That
was wrong**, and it is worth recording because it sent the investigation down the
wrong path for a long time. Probes settled it: the kernel is permissive. A 256 MB
`PROT_NONE` reservation can be chunked to RW, written, flipped to RX and
executed, at the start of the range and 16 MB deep. `mprotect` to RWX is silently
downgraded to RW, but nothing refuses the JIT its memory.

The real cause was a build configuration bug: `deps/v8/src/base/build_config.h`
defines `V8_HAS_PTHREAD_JIT_WRITE_PROTECT` only for arm64 **macOS**, so on iOS the
macro is 0, `platform.h` compiles V8's `SetJitWriteProtected` declaration out,
`RwxMemoryWriteScope` becomes a no-op, code pages are never made executable, and
executing the first builtin raises `SIGBUS` **at the instruction fetch**
(`si_code` 1, `pc == si_addr`, `lr -> Builtins_*`).

**Workaround, while it lasted:** `NODE_OPTIONS=--jitless`. Note that it had to be
`NODE_OPTIONS` and not a command-line flag, because the launcher set it in the
environment and the environment wins — see the trap recorded in §16.

**Now:** `node-ios/patches/04` enables that macro for iOS and implements the hook
with `mprotect` over the code range, and `05` repairs a page on the fault and
retries. Measured: a 20M-iteration loop goes from ~1060 ms to ~300 ms, and cold
boot to first token from 45 s to 17 s.

**On the "not taken" note this entry used to carry:** it was right that a V8
`mprotect` W^X patch is the way, and wrong that it needs a macOS toolchain. This
port built it on Linux with clang and an extracted iPhoneOS SDK. The requirement
was real for the reference workflow, not for the technique.

## 2. No WebAssembly under `--jitless`  *(no longer the situation)*

V8's codegen is what compiles WebAssembly. With `--jitless` there is no
WebAssembly at all, and merely importing a module that expects it throws.

This mattered because Node's global `fetch` is undici, and undici compiles its
`llhttp` HTTP parser from WebAssembly **at module load**. So `fetch` could not
even be imported.

**Workaround, two parts, both required:**

1. `preload/wasm-polyfill.js` supplies a `globalThis.WebAssembly` so undici can
   finish loading.
2. `preload/fetch-https-shim.js` then replaces `globalThis.fetch` outright with
   an implementation over `node:http`/`node:https`, which uses the native
   HTTP parser and needs no WebAssembly.

The polyfill alone is not enough — undici loads, but its parser cannot actually
parse responses, so every real request fails. The shim alone is not enough
either — see §3.

## 3. `globalThis.fetch` is a lazy getter, so assigning to it loads undici

Writing `globalThis.fetch = myFetch` invokes Node's own accessor, which imports
undici to satisfy the read-before-write. That import is what crashes. The
symptom is that the polyfill appears not to be consulted at all.

**Workaround:** define the property instead of assigning it —
`Object.defineProperty(globalThis, 'fetch', { value, configurable: true, writable: true })`.
Whether `defineProperty` alone is sufficient seems to depend on the Node build;
on the device tested, both preloads in order (`wasm-polyfill` first, then the
shim) were what finally worked.

## 4. `node:zlib` zstd is needed, and Node 18 lacks it

`dsh-session-persistence-jsonl` writes session logs as `jsonl.zstd`. Node 18 —
the version packaged in the jailbreak repos — has `zstdCompressSync` and friends
only from Node 22. On Node 18 the session layer fails at startup.

**Resolution:** move to Node 22.19.0 (`iphoneos-arm64` build). This is the floor
for DSH's `engines` field anyway.

## 5. `koffi` has no iOS build

`dsh-sandbox-local` and `dsh-subprocess-local` do a hard top-level
`import koffi`. `koffi` is an FFI addon with no iOS prebuild, and its `import`
cannot fail softly — it takes the whole boot with it, because the plugin loader
treats a failing entry as fatal.

**Workaround:** `shims/koffi.js` — a module with the same 43 named exports, each
a chainable placeholder that never throws.

**Alternative worth considering:** replacing the two plugins themselves with
inert subclasses of their (pure-JS) base classes, which keeps `ctx.sandbox` and
`ctx.subprocess` registered. That is cleaner — it removes the dead FFI surface
rather than faking it — and is the approach taken by at least one other port.
See `../patched/README.md`.

## 6. `win32-process` asserts a Windows ABI at import time

It calls `koffi.pointer()` and asserts `STARTUPINFOW.size === 104` at module
scope. On iOS the assertion throws during import, before any plugin can react.

**Workaround:** `shims/win32-process.js` — 21 exports, non-throwing.

## 7. `sharp` needs iOS libvips, which does not exist

The attachment pipeline decodes, inspects, resizes and re-encodes images through
`sharp`. There is no iOS libvips, and building one is out of reach for this
approach.

**Workaround:** a **pure-JS image codec** replacing `sharp`'s backend —
`sharp-ios/`, five files, depending only on `node:fs` and `node:zlib`. PNG
decode/encode, JPEG decode (baseline, extended-sequential and progressive, with
Huffman and restart intervals) and encode, resampling, EXIF orientation.

**This is the part of the port with no known equivalent elsewhere.** Verified by
blind test: an image generated at random and never described to the model was
read back exactly — string, shape and both colours.

## 8. `node-pty`'s addon declares the wrong platform

The shipped prebuild is a macOS Mach-O. iOS dyld refuses it with
`have 'macOS', need 'iOS'` — a refusal based on the `LC_BUILD_VERSION`
`platform` field, not on the signature or the architecture.

**Workaround:** rewrite that one field in place (`1` = macOS → `2` = iOS) and
re-sign with `ldid`. See `tools/patch-macho-ios.mjs`. The same fix applies to
`node-addon-system`'s `system.node`.

This is far cheaper than compiling the addon. It is also bit-exact and trivially
reversible, which matters when the alternative is a toolchain requirement.

A related dead end: symlinking `prebuilds/ios-arm64 → darwin-arm64` **does not
work** for `require`. The loader follows the path and then refuses the same way.
The addon directory has to be a real copy.

## 9. `flock` is unavailable

`@deepseek-ai/node-addon-system`'s lock helper rejects any platform that is not
`linux` or `darwin`. iOS *is* Darwin and `flock(2)` is present, so a patched
guard gets past the check — but the native addon then fails to `dlopen` for the
same class of reason as §8.

**Workaround:** `shims/flock-stub.js`, which grants every exclusive lock
immediately. Safe here because a single DSH instance is running;
`shims/flock-patched.js` keeps the real-call version for reference.

## 10. Spawning is fine; resolving the executable is not

An early conclusion that turned out to be wrong: `child_process` was believed
blocked, because `execFileSync('/bin/ls')` and friends all returned `ENOENT`.

They returned `ENOENT` because **the real `/bin` has almost nothing in it** —
`df` and `ps` only. Every jailbreak binary lives under jbroot, and a
non-interposed Node resolves `/bin/ls` against the real root.

Once the jbroot's own `bin` directories are on `PATH`, spawning works normally:

```sh
export PATH="$(jbroot)usr/bin:$(jbroot)bin:$PATH"
node -e "require('child_process').execFileSync(process.env.JB+'usr/bin/bash',['-c','echo hi'])"
```

**The lesson cost days.** `ENOENT` from `spawn` on this platform means *the path
does not exist in this process's view*, not *the sandbox forbids spawning*. Two
very different situations, one identical errno.

## 11. Exec'ing a script is unreliable

Related to §10 and to the namespace split. Spawning an executable works.
Spawning a **script** whose `#!/…` interpreter has to be resolved by the kernel
did not, across every shebang form tried: the shell-visible path, the
Node-reported realpath, `#!/usr/bin/env node` with `node` placed on `PATH`.
The kernel's view and the process's view disagree, and no single absolute path
satisfies both.

**Resolution: stop exec'ing.** Both command-line tools that DSH needs —
`glob`/`grep` via ripgrep, and `sharp` — are now implemented in-process in
JavaScript. This removed the problem class rather than working around it, and
also removed a process spawn per search.

Worth internalising: **on this platform, if the answer involves `exec`ing a
script, look for an in-process answer instead.**

## 12. Errors get swallowed

The workspace picker silently reverted to its default, with nothing in the
server log and nothing on screen — the confirm handler threw, and something
caught the rejection.

**Workaround:** `tools/diag-overlay.js`, a ~140-line script injected ahead of
the app bundle that:
* installs `error` and `unhandledrejection` handlers,
* wraps `console.error`/`console.warn`,
* probes a list of late-ECMAScript APIs and reports which are missing,
* wraps the `WebSocket` constructor to expose the URL and any construction throw.

It located the real cause — a service I had disabled by mistake — in one page
load, after several rounds of guessing. **For silent failures, build the
instrument before forming a hypothesis.**

## 13. Safari 17 lacks `Iterator`

`Can't find variable: Iterator` breaks plugin loading in the browser. Iterator
Helpers are a later Safari feature.

**Workaround:** `preload/iterator-polyfill.js`, injected into
`dsh-web-frontend/dist/index.html` ahead of the module bundle.

## 14. Safari 17 lacks `AbortSignal.any` (and friends)

Workspace directory listing fails without it.

**Workaround:** `preload/es-late-polyfill.js` — `AbortSignal.any`,
`Promise.withResolvers`, `Object.groupBy`, `Map.groupBy`, `Array.fromAsync`.
`AbortSignal.any` needs real reason propagation, not just a resolved promise.

## 15. The workspace picker needs a mounted agent preset

Worth recording because it presented as a filesystem problem and was not.
Selecting a workspace created no session, and the server logged nothing.

The cause: `shell-env` was disabled in the profile overlay. The shipped
`standard` agent preset declares a `tool-bash` row that injects the `shellEnv`
service, so with `shell-env` off the preset fails to mount, session creation
fails, and the picker quietly reverts.

**Profile boot does not catch this** — the preset is mounted lazily, when a
session is created. The boot audit only checks the profile's own rows.

**Rule:** do not disable `shell-env`. Disabling `tool-bash` yourself is also
wrong, for the opposite reason: the audit skips disabled entries, so the
`subprocess` service disappears silently.

---

## 16. The trap that hid §1 for as long as it hid it

`NODE_OPTIONS` is equivalent to the command line. So when the only way to run
this port was `--jitless`, `scripts/start.sh` set:

```sh
export NODE_OPTIONS=--jitless
```

and that line **outlived the flag it was there for**. Once the binary had a
working JIT, removing `--jitless` from `argv` changed nothing: the environment
still said interpreter-only, so the server stayed a pure interpreter while every
isolated JIT test passed. "JIT works but DSH is still slow" is a very convincing
way to conclude the wrong thing, and it cost a round of it.

**Rule:** diagnose the engine from `env | grep NODE_OPTIONS`, never from the
process command line. `scripts/start.sh` now strips `--jitless` from
`NODE_OPTIONS` instead of setting it, and honours `DSH_JITLESS=1`.

**And the follow-on trap, which is worse because it is silent.** The obvious way
to strip it is the bash/zsh expansion. That dies on this device:

```sh
# wrong: /bin/sh here is dash, which has no ${var//pat/}
export NODE_OPTIONS="${NODE_OPTIONS//--jitless/}"
```

dash fails at **expansion** time with `Bad substitution` — so `sh -n` reports the
script as clean, and the first real run dies at the top of the file. Verify shell
changes by **running them under `dash`**, not by syntax-checking them. The
committed version does, and removes only `--jitless`, so other options survive.

---

## Two more, found later

### `pkill -f` does nothing

Verified repeatedly: `pkill -9 -f 'bin.js web'` returns without error and
without effect, so a stale server keeps the port and the next launch dies with
`EADDRINUSE` — while appearing to have started. Use a pidfile, and test the port
by trying to bind it.

### The request-image cache does not key on the pixel budget

Raising the budget has no effect on an image that was already sent once: the
cached request image is reused and the old, smaller encoding is what reaches the
model. Clearing `dsh-home/attachments/v1/request-images/` is required. Easy to
misread as "the change didn't work".
