# Third-party notices

`dsh-ios` is an adaptation layer. It ships **no** third-party binaries and
re-implements rather than redistributes wherever it can. What it does contain,
and under what terms, is below.

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
remaining five files in `sharp-ios/` are original work that happens to implement
a compatible subset of `sharp`'s public API; they contain no `sharp` code.

`install.sh` obtains `sharp` itself from npm. Apache-2.0 requires that
modifications be stated — this file *is* the statement.

---

## Original work in this repository

The following are original to this project and carry this repository's license:

```
sharp-ios/         exif.cjs, png.cjs, jpeg.cjs, resize.cjs, sharp.cjs
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
| **Node.js** (iOS `iphoneos-arm64` build) | MIT | upstream release; URL and checksum pinned in `install.sh` | 74 MB binary; should be fetched and verified, not vendored |
| **DSH** and the `@deepseek-ai/*` tree | MIT | `npm install @deepseek-ai/dsh` | ~265 MB of dependencies; `npm` already does this |
| **`sharp`** + `@img/colour` | Apache-2.0 / MIT | npm | obtained by `npm install` |
| **`@vscode/ripgrep`** | MIT | npm | **not used** — `rg-ios/` replaces it, so its platform binaries never need to exist |
| **`node-pty`** | MIT | npm | obtained by `npm install`; the macOS prebuild is patched in place at install time |
| **`koffi`** | MIT | npm | **not used** — `shims/koffi.js` stands in for it |
| **`@deepseek-ai/node-addon-system`** | MIT | npm | obtained by `npm install`; `flock` replaced by a shim |

Nothing under `node_modules/` is committed. `.gitignore` enforces this.

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
