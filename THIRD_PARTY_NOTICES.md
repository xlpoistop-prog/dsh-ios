# Third-party notices

`dsh-ios` is an adaptation layer. It re-implements rather than redistributes
wherever it can. What it does contain, and under what terms, is below — including
the one binary it ships, which is a build of its own source.

---

## Redistributed source

### DeepSeek Harness — `@deepseek-ai/dsh` and the `@deepseek-ai/*` packages

**License: MIT** — Copyright (c) DeepSeek

Upstream: <https://github.com/deepseek-ai/deepseek-harness>

Three files under [`patched/`](patched/) are the **bundled build output**
(`lib/index.js`) of upstream packages with edits applied. The MIT notice and
terms apply to them unchanged:

| File in this repo | Upstream package | Edits |
|---|---|---|
| `patched/dsh-tool-fs-search.lib.index.js` | `@deepseek-ai/dsh-tool-fs-search` | spawn a ripgrep binary → call a JS implementation in-process |
| `patched/dsh-attachment-local.lib.index.js` | `@deepseek-ai/dsh-attachment-local` | alpha images: WebP → PNG; request-image cache version bumped |
| `patched/dsh-llm-deepseek.lib.index.js` | `@deepseek-ai/dsh-llm-deepseek` | image pixel budget `64e4` → `15e5`; byte cap 1 MiB → 4 MiB |

Exactly what changed, and why, is in [`patched/README.md`](patched/README.md).

### `sharp` — package entry redirect

**License: Apache-2.0** — Copyright (c) 2013 Lovell Fuller and contributors

Upstream: <https://github.com/lovell/sharp>

This repo contains **one 3-line file**, `sharp-ios/index.cjs`, which is a
replacement for `sharp`'s own `dist/index.cjs` entry point:

```js
'use strict';

// Package entry (CommonJS). Pure-JS implementation; see ./ios/sharp.cjs.
module.exports = require('./ios/sharp.cjs');
```

No `sharp` source, binaries or vendored dependencies are redistributed. The
remaining files in `sharp-ios/` are original work that happens to implement a
compatible subset of `sharp`'s public API; they contain no `sharp` code.

`install.sh` obtains `sharp` itself from npm. Apache-2.0 requires that
modifications be stated — this file *is* the statement.

### `stb` — single-header libraries, vendored in `sharp-ios/native/stb/`

**License: public domain (dual-licensed MIT, at your option)** — Copyright (c)
Nothings and contributors; see the end of each header for the full text.

Upstream: <https://github.com/nothings/stb>

| File | Version | Used for |
|---|---|---|
| `stb_image.h` | v2.30 | PNG/JPEG decode in the native image accelerator |
| `stb_image_write.h` | v1.16 | PNG encode in the same |

Vendored rather than fetched so that `sharp-ios/native/build.sh` works offline and
so that the source that produced the shipped binary is exactly the source in the
tree. `stb_image_resize2.h` is deliberately **not** vendored — the addon uses its
own resampler, which is a bit-exact port of the JS one, and nothing else.

These headers are compiled into `sharp-ios/imgaddon.node` (see below), which is
therefore a redistribution of compiled stb code. Public domain imposes no
condition; the MIT option is noted here for completeness.

---

## The one binary this repository ships

### `sharp-ios/imgaddon.node`

**Original work, compiled from this repository's own source** — no third-party
binary is redistributed by it, beyond the vendored-to-source stb headers above.

It is a Node N-API addon, built *on the device* by `sharp-ios/native/build.sh`
from `sharp-ios/native/imgaddon.c`, and installed by `install.sh` (which re-signs
it with `ldid`, as iOS requires for any executable code).

```
source    sharp-ios/native/imgaddon.c  +  sharp-ios/native/stb/*
script    sharp-ios/native/build.sh
compiler  Procursus clang 14.0.0, target arm64-apple-ios16.0
size      230,624 bytes
sha256    437d1bb65c042c3e906d3f7c3602490d9c87164eeefe19ddcbbc24f74dad3925
```

It is optional by construction: delete the file and the codec runs in pure JS.
Its behaviour is compared byte-for-byte against the pure-JS codec by
`sharp-ios/native/compare-pixels.cjs`, and the reasoning is in
[`sharp-ios/native/README.md`](sharp-ios/native/README.md).

---

## Original work in this repository

The following are original to this project and carry this repository's license:

```
sharp-ios/         exif.cjs, png.cjs, jpeg.cjs, resize.cjs, sharp.cjs
sharp-ios/native/  imgaddon.c, build.sh, compare-pixels.cjs, jpeg-diff.cjs
                   (stb/ is vendored, not original — see above)
rg-ios/            rg-impl.mjs, package.json, rg-launcher.tmpl
preload/           wasm-polyfill.js, fetch-https-shim.js,
                   iterator-polyfill.js, es-late-polyfill.js, settings-mobile.css
shims/             koffi.js, win32-process.js, flock-stub.js, flock-patched.js
patched/           (see above — derived from MIT upstream)
tools/             patch-macho-ios.mjs, patch-macho-ios.py,
                   diag-overlay.js, diag-dlopen.mjs, diag-services.mjs
scripts/           start.sh, stop.sh, install-*.sh
docs/              jbroot-namespaces.md, ios-constraints.md
```

---

## Fetched at install time, not redistributed

Deliberately absent from this repository. `install.sh` and `npm` obtain them.

| Component | License | Where it comes from | Why not here |
|---|---|---|---|
| **Node.js** (iOS `iphoneos-arm64` build) | **MIT** — [`j0shua-SYSON/node-ios`](https://github.com/j0shua-SYSON/node-ios) | [release `v22.19.0`](https://github.com/j0shua-SYSON/node-ios/releases/tag/v22.19.0) | 71 MB binary; fetch and verify it rather than vendoring it |
| **DSH** and the `@deepseek-ai/*` tree | MIT | `npm install @deepseek-ai/dsh` | ~265 MB of dependencies; `npm` already does this |
| **`sharp`** + `@img/colour` | Apache-2.0 / MIT | npm | obtained by `npm install` |
| **`@vscode/ripgrep`** | MIT | npm | **not used** — `rg-ios/` replaces it, so its platform binaries never need to exist |
| **`node-pty`** | MIT | npm | obtained by `npm install`; the macOS prebuild is patched in place at install time |
| **`koffi`** | MIT | npm | **not used** — `shims/koffi.js` stands in for it |
| **`@deepseek-ai/node-addon-system`** | MIT | npm | obtained by `npm install`; `flock` replaced by a shim |

Nothing under `node_modules/` is committed. `.gitignore` enforces this.

### The Node build, specifically

This port was developed against exactly one Node build, and its provenance is
pinned by checksum so it can be re-obtained rather than trusted:

```
source   https://github.com/j0shua-SYSON/node-ios/releases/download/v22.19.0/node-v22.19.0-iphoneos-arm64
size     74,851,216 bytes
sha256   1f0975217902badb1919b6d6f5dfd9e1083e765f090766dab6d50f562044fbcc
license  MIT (Copyright (c) 2026 j0shua-SYSON)
```

```
source   https://github.com/j0shua-SYSON/node-ios/releases/download/v22.19.0/entitlements.plist
size     362 bytes
sha256   d7bca5deecd3bad89d7c0bb92db4fd4d83f817a7dfcb90bd84bef18f410b5983
```

Both checksums were verified against the files used to build and test this port;
the `entitlements.plist` in this repo is that exact file.

That project describes itself as *"the first public Node >=20 build for iOS"*,
and its own release notes recommend the same flag this port depends on:

> Run with `--jitless`. Validated on iPhone 6s Plus / iOS 15.8.5 / Dopamine.

Which is worth noting independently: **`--jitless` is not a workaround this port
invented.** It is the intended usage of the only public Node build for this
platform, and it is required for the same reason here — see
[`docs/ios-constraints.md`](docs/ios-constraints.md) §1.

The Node.js sources it is built from are themselves MIT.

---

## Platform prerequisite: the jailbreak

Not a dependency of this software and not redistributed — but nothing here runs
without it, so it belongs in a notices file.

| Component | License | Role |
|---|---|---|
| [Relaxin](https://github.com/owngoal-dev/Relaxin) | MIT | The jailbreak this was built and verified against (iOS 17.1.1) |
| [roothide Bootstrap](https://github.com/roothide/Bootstrap) | MIT | Provides the jbroot mechanism — see [`docs/jbroot-namespaces.md`](docs/jbroot-namespaces.md) |
| [Procursus](https://github.com/ProcursusTeam/Procursus) | — | The bootstrap userland supplying `ldid`, `tar`, `zsh` |

The jbroot filesystem layout described throughout this repo is a property of
that design, not of iOS. Anyone adapting this to a **rootless** jailbreak will
find the namespace section does not apply in the same form.

---

## Considered and not used

### `everettjf/dsh-ios`

<https://github.com/everettjf/dsh-ios> — **GPL-3.0**

A genuinely different approach: DSH running inside an iSH-emulated Linux
(itself GPL-3.0, which is why that project is GPL-3.0) packaged as an iOS app.

**No code from it is used in this repository**, and no obligation is inherited.
It is listed here because it addresses the same problem and is worth reading, and
because its license is the reason a deliberate decision was made not to draw on
it. Its `LICENSE.md` documents the iSH GPL lineage clearly.

### `ddddddedcds/deepseek-harness-ios` (branch `ios-port`)

<https://github.com/ddddddedcds/deepseek-harness-ios> — **MIT**
Companion: <https://github.com/ddddddedcds/Node.js-for-ios>

A cross-compiled port: custom Node build with a patched V8 for real JIT, native
`node-pty`, `.deb` packaging. **MIT, and compatible with this repository.**

It is credited rather than drawn from. Its `docs/ios-port.md` independently
establishes several facts recorded in this repo's `docs/ios-constraints.md`, and
where this project's notes agree with it, that agreement is meaningful evidence
for both. If any text here overlaps with that document, treat that document as
the earlier and more authoritative source on the points it covers.

### `imcynic/nodejs-ios`

<https://github.com/imcynic/nodejs-ios> — **no license file**

Referenced only as the source of the observation that V8 on iOS cannot use
`MAP_JIT`. No code, text or binaries from it are used. Noted explicitly because
a repository without a license grants no rights by default.
