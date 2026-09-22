# `imgaddon` — the native image accelerator

A ~180-line C addon that does the three expensive things the pure-JS codec was
doing in the interpreter: **PNG/JPEG decode**, **resize**, and **PNG encode**.
It is compiled *on the device* with the jailbreak's own clang.

It is an optimisation, never a dependency. `sharp.cjs` requires it from its own
directory and silently falls back to the pure-JS path whenever it is missing,
unsigned, unloadable, or switched off with `DSH_NATIVE_CODEC=0`. A phone without
a compiler is a phone where this file simply does not exist.

## Why it exists

Measured on the device this was written for (iPhone 15, iOS 17.1.1, Node 22.19.0
with `--jitless`), on a 1254×1254 PNG of 2.1 MB:

| Step | pure JS | native | |
|---|---|---|---|
| decode | 2,910 ms | **65 ms** | 44.8× |
| resize | 6,921 ms | **86 ms** | 80.5× |
| PNG encode | 11,298 ms | **262 ms** | 43.1× |
| JPEG encode | 9,273 ms | 2,941 ms | 3.15× |

The whole "decode → resize → encode" path for one request image goes from about
**21 seconds to about 0.4 seconds**. That matters more here than it would
elsewhere: `--jitless` means none of this is ever compiled, so the pure-JS paths
run at interpreter speed permanently.

The JPEG row is smaller because the addon deliberately provides no JPEG *encoder*
— the pure-JS baseline encoder is still used, and the 3.15× is entirely the
decode and resize feeding it.

## Building it, on the device

```sh
sh build.sh                     # -> ../imgaddon.node, which install.sh installs
NODE_INC=<dir with node_api.h> sh build.sh out.node     # reuse headers
NODE_HEADERS_VERSION=v22.23.2 sh build.sh               # fetch a different set
```

What it needs, and what it does about each:

* **A compiler.** The jailbreak bootstrap ships Procursus clang (`/usr/bin/clang`,
  version 14 on the device tested). Nothing else is involved — no macOS, no
  Xcode, no cross-compilation, which is the point of doing it this way.
* **Node headers.** Fetched from `nodejs.org` and unpacked into `inc/`, or reuse
  a directory with `NODE_INC=`. N-API is ABI-stable, so headers that are not
  exactly the installed version are fine.
* **`TMPDIR`.** This one is not obvious and costs an afternoon: **clang has no
  working default temp directory on iOS.** With `TMPDIR` unset it fails with
  `unable to make temporary file: No such file or directory`, which says nothing
  about temp directories. Darwin's default (`_CS_DARWIN_USER_TEMP_DIR`) does not
  exist here. `build.sh` sets `TMPDIR=/tmp` when it is unset or unusable.
* **No `gzip`.** `tar -xzf` fails with `gzip: cannot exec` on this platform, so
  the headers tarball is inflated with Node's `zlib` first. `build.sh` looks for
  the Node binary at `../../node` (i.e. the one this repo installed) because it
  is not on `PATH` in a non-interactive shell.
* **`ldid`.** iOS will not map unsigned executable code. `build.sh` signs the
  output; `install.sh` signs the prebuilt copy it installs. The addon also has to
  live inside jbroot, for the same reason every other `.node` here does — see
  [`../../docs/jbroot-namespaces.md`](../../docs/jbroot-namespaces.md).

The link line is the ordinary one for Node addons —
`clang -shared -undefined dynamic_lookup` — so nothing links against libnode and
the N-API symbols are resolved by the host process at `dlopen`. iOS's linker
warns that `-undefined dynamic_lookup` is deprecated there; it works, and it is
how every addon on this platform is built.

## What it does, and what it guarantees

| Export | Signature |
|---|---|
| `decode(buffer)` | → `{ width, height, sourceChannels, data }`, always 4-channel RGBA |
| `info(buffer)` | → `{ width, height, channels }`, header only |
| `resize(buffer, w, h, newW, newH[, channels])` | → Buffer |
| `encodePng(buffer, w, h[, inChannels[, outChannels]])` | → Buffer |

Correctness was treated as the whole problem, because a faster image path that
changes the image is worse than a slow one:

* **`resize` is a bit-exact port of `resize.cjs`** — the same separable
  box-average-when-downscaling, centre-mapped-bilinear-when-upscaling kernel with
  the same `floor(v + 0.5)` rounding. stb's own resizers were tried and
  **rejected**: any other kernel shifts edges and visibly changes the image. This
  is why `stb_image_resize2.h` is not vendored here.
* **PNG decode is byte-identical to the JS decoder** — PNG is lossless, and the
  comparison harness checks the whole RGBA buffer, not a sample.
* **JPEG decode differs**, because it is a different decoder: measured at
  **max ±2 per channel, on 0.8% of pixels**, which is JPEG's own rounding
  behaviour. EXIF orientation still comes from the pure-JS header scan, since
  stb does not read EXIF.
* **PNG encode produces larger files** — same pixels, worse compression than the
  JS encoder (1.67 MB vs 1.25 MB on the test image, +34%). That is a real cost,
  paid in upload time; the JS path is one `DSH_NATIVE_CODEC=0` away if it matters
  more than the 43× speed-up.

Verified against the repository's own fixtures: **16 passed, 0 failed** with the
addon on, and 16/16 with it off.

## Layout

```
imgaddon.c              the addon
build.sh                on-device build + sign
stb/stb_image.h         vendored, v2.30   (decode)
stb/stb_image_write.h   vendored, v1.16   (PNG encode)
compare-pixels.cjs      pixel-exactness harness: addon vs pure JS
jpeg-diff.cjs           JPEG difference distribution, JS vs native
```

`../imgaddon.node` is the prebuilt that `install.sh` installs. It was produced by
this `build.sh` on the device, from the `imgaddon.c` in this directory, and its
output was compared byte-for-byte against the pure-JS codec before it was
committed:

```
clang        Procursus clang 14.0.0, target arm64-apple-ios16.0
sha256       437d1bb65c042c3e906d3f7c3602490d9c87164eeefe19ddcbbc24f74dad3925
```
