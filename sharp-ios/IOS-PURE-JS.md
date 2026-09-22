# sharp on iOS: pure-JS replacement (no libvips, no WebAssembly)

`@deepseek-ai/dsh-attachment-local` statically does `import sharp from "sharp"`.
The published sharp package cannot load on this device: it has no iOS prebuild,
and the WebAssembly fallback is unavailable because Node runs with `--jitless`.
The previous workaround was a placeholder stub that kept module evaluation
alive but returned fabricated data, so `read_image` always failed with
`Unsupported or malformed image data.`

This directory contains a self-contained pure-JS implementation of the subset of
sharp that DSH actually uses. It decodes and encodes real images with only
`node:zlib`.

An optional native accelerator takes over decode, resize and PNG encode when it
is present — measured at 45–80× on those three steps. It is built from the C in
[`native/`](native/README.md), works on the device with the jailbreak's own
clang, and is never required: `sharp.cjs` falls back to the code below whenever
it is absent or unloadable.

## Files

| File | Role |
| --- | --- |
| `index.cjs` | replacement for sharp's package entry, redirects to `ios/sharp.cjs` |
| `sharp.cjs` | sharp-like chainable pipeline + format dispatch (+ native fast path) |
| `png.cjs` | PNG decoder/encoder and metadata reader |
| `jpeg.cjs` | JPEG decoder/encoder and metadata reader |
| `resize.cjs` | separable area/bilinear resampler |
| `exif.cjs` | EXIF orientation reader |
| `imgaddon.node` | optional native accelerator (prebuilt) |
| `native/` | the accelerator's C source, its headers, its build script |

`install.sh` copies these into `node_modules/sharp/dist/ios/`.

## API surface actually exercised by DSH

Grep of `@deepseek-ai/dsh-attachment-local/lib/index.js` is the authority:

```
sharp(data, { failOn: "error", limitInputPixels: false })
  .metadata()
  .raw().toBuffer()
  .rotate().toColourspace("srgb").resize({ width, height, fit: "inside", withoutEnlargement: true })
  .clone()
  .jpeg({ quality })  |  .webp({ quality, effort: 0 })
  .toBuffer({ resolveWithObject: true })   // -> { data, info: { width, height } }
```

Also implemented for completeness: `png()`, `toFormat()`, `ensureAlpha()`,
`removeAlpha()`, `flatten()`, `grayscale()`, `rotate(angle)`, `sharp.versions`.

`metadata()` returns the fields DSH reads: `format`, `width`, `height`,
`depth`, `space`, `hasAlpha`, `channels`, `pages`, `orientation`, plus `exif`,
`icc`, `xmp`, `iptc`, `comments`, `hasProfile` when present. A pipeline decodes
fresh on every `toBuffer()` and never mutates the input buffer.

## Supported

* **PNG decode** — bit depths 1/2/4/8/16, colour types 0/2/3/4/6, non-interlaced
  and Adam7 interlaced, `tRNS`, palette, `eXIf`/`iCCP`/XMP metadata.
* **PNG encode** — 8-bit RGB/RGBA with adaptive filtering and `zlib` deflate.
* **JPEG decode** — 8-bit Huffman, baseline/extended-sequential and progressive
  (`SOF0`/`SOF1`/`SOF2`), grayscale and YCbCr, restart intervals.
* **JPEG encode** — baseline sequential, 4:2:0, standard Huffman tables,
  quality-scaled standard quantisation tables.
* **resize / rotate / clone / raw / colourspace** and the metadata fields above.

## Not implemented (fails with a descriptive `Error`, never fake data)

* **WebP** — neither decode nor encode. Pure-JS VP8/VP8L is out of scope.
  `dsh-attachment-local` therefore encodes images that *have alpha and need
  normalisation* as lossless PNG (`encodingLadder` selects `image/png` when the
  source has alpha) instead of WebP; opaque images use the JPEG path. Clean
  alpha images also pass through byte-identically, so the common case never
  re-encodes at all.
* **GIF decode** — metadata is parsed, pixel decode is not.
* **JPEG** — arithmetic coding, 12-bit precision, 4-component CMYK/YCCK.
* The rest of sharp's surface (composite, blur, sharpen, SVG, `withMetadata`, …).

## Performance (Node `--jitless`)

Without the native accelerator everything is interpreter-bound. Measured on this
device, on a 1254×1254 PNG:

| Step | pure JS | native `imgaddon.node` |
| --- | --- | --- |
| decode | 2,910 ms | **65 ms** |
| resize | 6,921 ms | **86 ms** |
| PNG encode | 11,298 ms | **262 ms** |
| JPEG encode | 9,273 ms | 2,941 ms (no native encoder; the gain is decode + resize) |

The pure-JS figures for smaller images are less dramatic but the shape is the
same: JPEG baseline decode runs at roughly 0.3 MP/s, and a 12 MP JPEG would take
on the order of a minute. Set `DSH_NATIVE_CODEC=0` to force the pure-JS paths, and
see [`native/README.md`](native/README.md) for what the accelerator does and does
not guarantee.

## Self-test

`fixtures/verify-image-codec.mjs` in the repository root checks decode, metadata,
resize and both encode paths against fixtures whose recorded truth is in
`blind-test.answer.txt` — a passing run means the pixels really decoded, not that
something plausible came back. Run it after `install.sh`, from the install
directory on the device:

```
./node --jitless fixtures/verify-image-codec.mjs ../dsh/node_modules/sharp/dist/ios
DSH_NATIVE_CODEC=0 ./node --jitless fixtures/verify-image-codec.mjs ../dsh/node_modules/sharp/dist/ios
```

Both are expected to print `16 passed, 0 failed` — the first exercises the native
path, the second the pure-JS one.

## Rollback

`install.sh` copies every file it replaces to `<name>.dsh-ios.bak` first, so any
single file can be restored by copying it back. To drop only the native
accelerator, delete `dist/ios/imgaddon.node` (or set `DSH_NATIVE_CODEC=0`) — the
codec continues in pure JS with no other change.

## Loading

The replacement is loaded at process start. The already-running DSH process
holds the old stub in its module cache, so **DSH must be restarted** for
`read_image` to use this implementation.
