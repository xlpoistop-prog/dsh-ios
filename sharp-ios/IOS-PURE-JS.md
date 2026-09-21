# sharp on iOS: pure-JS replacement (no libvips, no WebAssembly)

`@deepseek-ai/dsh-attachment-local` statically does `import sharp from "sharp"`.
The published sharp package cannot load on this device: it has no iOS prebuild,
and the WebAssembly fallback is unavailable because Node runs with `--jitless`.
The previous workaround was a placeholder stub that kept module evaluation
alive but returned fabricated data, so `read_image` always failed with
`Unsupported or malformed image data.`

This directory now contains a self-contained pure-JS implementation of the
subset of sharp that DSH actually uses. It decodes and encodes real images with
only `node:zlib`.

## Files

| File | Role |
| --- | --- |
| `dist/index.cjs` | CommonJS entry (`main`) |
| `dist/index.mjs` | ESM entry (used by `import sharp from "sharp"`) |
| `dist/ios/sharp.cjs` | sharp-like chainable pipeline + format dispatch |
| `dist/ios/png.cjs` | PNG decoder/encoder and metadata reader |
| `dist/ios/jpeg.cjs` | JPEG decoder/encoder and metadata reader |
| `dist/ios/resize.cjs` | separable area/bilinear resampler |
| `dist/ios/exif.cjs` | EXIF orientation reader |

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

Everything is interpreter-bound. Measured on this device:

* PNG decode/encode, resize: effectively instant for the 480×200 test image.
* JPEG baseline decode: ~0.3 MP/s (~0.9 s for 512×512, ~1.6 s before the
  DC-only IDCT fast path). A 12 MP JPEG would take on the order of a minute.

## Self-test

From the workspace root:

```
./node --jitless sharp-ios-selftest.mjs     # full transcript also in sharp-ios-selftest.log
./node --jitless sharp-ios-e2e.mjs          # DSH attachment pipeline only
```

The self-test checks `metadata()` and raw pixels against an independent
reference decode of `test-image.png`, PNG/JPEG encode round-trips, real baseline
and progressive system JPEGs, explicit WebP/GIF failures, and the real
`saveImageFile` / `readImageFile` / `readRequestImageFile` pipeline.

## Rollback

The original placeholder stub is preserved in two places:

* `/tmp/sharp-backup/` (the whole directory, as requested by the task)
* `sharp-ios-rollback/` in the workspace (durable)

To restore the stub:

```
sh sharp-ios-rollback/restore.sh
```

## Loading

The replacement is loaded at process start. The already-running DSH process
holds the old stub in its module cache, so **DSH must be restarted** for
`read_image` to use this implementation.
