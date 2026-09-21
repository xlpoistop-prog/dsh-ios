# What was changed in `@deepseek-ai/*`

DSH is MIT-licensed, so the modified files are redistributed here in full rather
than as context diffs. A diff would have been tied to one exact build of each
package (the bundled `lib/index.js` is a build artifact whose line layout changes
between releases), whereas the full files plus the table below stay readable and
auditable.

Each file below is the **bundled build output** (`lib/index.js`, the `//#region`
form), with the listed edits applied. Copyright remains DeepSeek's; the MIT
notice and the original terms apply to all of them — see
`../THIRD_PARTY_NOTICES.md`.

---

## 1. `dsh-tool-fs-search.lib.index.js`

**Problem.** The plugin resolves `@vscode/ripgrep-<platform>-<arch>` at first
use and then `spawn`s that binary. On iOS the resolved package is
`ripgrep-ios-arm64`, which is never published; the npm `darwin-arm64` build is a
macOS Mach-O linking `/usr/lib/libiconv.2.dylib`, which iOS does not have. Even
after supplying a working `rg`, spawning a *script* proved unreliable here: the
shebang is resolved by the kernel against the real filesystem, while the
interpreter path that works is only meaningful inside the jbroot namespace. The
result was a bare `ripgrep launch failed` with no useful diagnostic.

**Change.** The spawn is replaced with an in-process call.

* New `resolveRgImpl()` resolves `bin/rg` as before, then dynamically imports the
  sibling `rg-impl.mjs` and caches its exported `runRgImpl`.
* `runRipgrep()` no longer calls `ctx.subprocess.spawn`; it calls `runRgImpl`
  with the same argv and captures stdout into the same in-memory buffer.
* The existing `completeStdout()` / `classifyRunFailure()` path is kept, so the
  failure codes (`SEARCH_FAILED`, `SEARCH_INVALID_PATTERN`, `SEARCH_ABORTED`,
  `SEARCH_RAW_OUTPUT_OVERFLOW`) and the byte-cap semantics are unchanged.

This removes the dependency on `exec`, `shebang`, `PATH` and the filesystem
sandbox in one move. `inject: ["subprocess"]` was deliberately left alone —
`subprocess` still exists as a service and removing the injection changes
composition behaviour.

## 2. `dsh-attachment-local.lib.index.js`

**Problem.** `encodingLadder()` chose **WebP** for any source carrying an alpha
channel:

```js
if (hasAlpha) return [() => encode(prepared.clone(), "image/webp", void 0)];
```

Our `sharp` replacement (see `../sharp-ios/`) is pure JS and has no WebP
encoder, so that branch could not produce a valid WebP — yet the declared
`mediaType` still said `image/webp`. The API rejected the mismatch:

```
INVALID_REQUEST messages[N].image[0]: You have uploaded an unsupported image.
```

**Change.** Alpha sources are encoded as **PNG** instead. PNG is lossless, needs
only `node:zlib`'s deflate, and the API accepts it.

```js
if (hasAlpha) return [() => encode(prepared.clone(), "image/png", void 0)];
```

The corresponding encoder selection follows:

```js
const encoded = mediaType === "image/png" ? pipeline.png()
              : mediaType === "image/jpeg" ? pipeline.jpeg({ quality })
              : void 0;
if (encoded === void 0) throw new Error(`attachment-local: unsupported encoding media type ${mediaType}`);
```

The version marker in the request-image cache key was also bumped
(`request-image-v6` → `request-image-v7`) so that already-cached images encoded
by the old branch are not served again. **Note:** the marker does *not* include
the pixel budget, which means changing that budget does not invalidate cached
request images — clearing `attachments/v1/request-images/` is required for a
budget change to take effect on images that were already sent once.

`assertAlphaCompatible()`'s WebP-specific clause was left as-is; it only runs for
WebP output, which this path no longer produces.

## 3. `dsh-llm-deepseek.lib.index.js`

**Problem.** Two constants decide how much detail reaches the model:

```js
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 64e4;      // 640,000 px
const DEFAULT_REQUEST_IMAGE_MAX_BYTES   = 1024 * 1024; // 1 MiB
```

`requestImageDimensions()` scales an image down to `sqrt(maxPixels/(w*h))`, so a
1179×2556 iPhone screenshot became 543×1177 — each edge halved, and small text
in the screenshot became unreadable to the model.

**Change.** Both defaults raised:

```js
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 15e5;       // 1,500,000 px
const DEFAULT_REQUEST_IMAGE_MAX_BYTES   = 4 * 1024 * 1024;
```

The same screenshot now encodes to 831×1802 (×1.53 per edge, ×2.34 by area).
Measured against the live API: both old and new encoded forms return HTTP 200,
and `usage.input_tokens` rises 419 → 916, confirming the extra pixels really do
reach the vision pipeline rather than being dropped.

**Cost note.** Image tokens scale with pixel area, so this roughly doubles the
per-image token cost. It is a deliberate trade, not a free win. Keep
`model.imagePixelBudget` in the catalog in mind if you want a different point on
that curve: it is the intended per-model knob, and the constant here is only the
fallback for models that declare nothing.

---

## Not changed, and why

* **`node-pty`.** Not patched at the JS level. The shipped prebuild declares
  `platform = macOS` in `LC_BUILD_VERSION`, which dyld refuses on iOS
  (`have 'macOS', need 'iOS'`). Rather than patch source, the one platform byte
  is rewritten in place and the binary re-signed — see
  `../tools/patch-macho-ios.mjs`. The same treatment applies to
  `node-addon-system`'s `system.node`.
* **`koffi`, `win32-process`.** They fail at `import` time and cannot be fixed by
  configuration, so they are replaced by inert stubs — see `../shims/`.
* **`sharp`.** Official `sharp` needs iOS libvips, which does not exist. The
  `dist/index.cjs` entry is redirected to a pure-JS backend; the official package
  is otherwise untouched by us. See `../sharp-ios/`.
