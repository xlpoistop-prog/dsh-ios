# Changelog

This is a set of scripts rather than a package, so there is no version number to
bump. Entries are dated, and each one says what was verified and how — the point
of this repository is that its claims are measured, so the changelog records the
measurement as much as the change.

Unless stated otherwise, everything targets whatever `@deepseek-ai/dsh` npm's
`latest` dist-tag points at (`0.1.5-rc.2` at the time of the last entry); pin a
different one with `--dsh-version`.

---

## 2026-09-22

### Added

* **The native image accelerator** — `sharp-ios/native/`, a ~180-line C addon
  that takes over decode, resize and PNG encode. It is compiled **on the phone**
  by the jailbreak's own clang; no Mac, no Xcode, no cross-compilation.

  | Step | pure JS | native | |
  |---|---|---|---|
  | decode | 2,910 ms | 65 ms | 44.8× |
  | resize | 6,921 ms | 86 ms | 80.5× |
  | PNG encode | 11,298 ms | 262 ms | 43.1× |

  One request image goes from ~21 s to ~0.4 s (1254×1254 PNG, Node 22.19.0 with
  `--jitless`).

  The C resampler is a **bit-exact port of `resize.cjs`**; stb's own filters were
  tried and rejected because they shift edges. PNG decode is byte-identical to
  the JS decoder, JPEG decode differs only by JPEG's own rounding (measured: max
  ±2 per channel on 0.8% of pixels), and native PNG output is **larger** than the
  JS encoder's (+34%, same pixels) — the one real cost, recorded rather than
  hidden.

  It is an optimisation, never a dependency: `sharp.cjs` falls back to pure JS
  whenever the addon is missing, unsigned, unloadable, or `DSH_NATIVE_CODEC=0`.
  A prebuilt `sharp-ios/imgaddon.node` ships (built by `native/build.sh` from the
  source in the same directory), and `install.sh` copies and `ldid`-signs it.

  Two platform traps found while building it are written down: **clang has no
  working default temp directory on iOS** (`TMPDIR` must be set, or it fails with
  `unable to make temporary file`), and there is **no `gzip`**, so the Node
  headers are inflated with Node's own `zlib`.

* **`bootstrap.sh --push-only`** — copy the repo across and stop. For answering
  "is it the transfer or the install that is failing?" without touching a working
  installation.

* **README: "When it does not work"** — the script's own error strings mapped to
  a cause and a fix, plus how to roll back (`.dsh-ios.bak` per file) and the
  `bootstrap.sh` flags that until then existed only behind `--help`.

* Measured disk usage, now stated up front: **423 MB** for a full install, 71 MB
  of it the Node binary.

### Fixed

Found by running everything against a real device, not by reading it:

* **`install.sh` had never run to completion.** `backup()` assigned the caller's
  `src` — POSIX sh has no `local` — so `install_file` copied the destination onto
  itself and died on the first file with `cp: 'X' and 'X' are the same file`.
  `--dry-run` does not execute `install.sh`, so this was invisible.
* **The no-PuTTY path could not find the phone.** With OpenSSH selected and
  `--device` omitted, the 127.0.0.1 probe dereferenced an unset `PLINK_BIN` and
  aborted with "unbound variable" — which is precisely the case the search exists
  for.
* **OpenSSH was not a fallback, it was an error message** telling people to go
  install PuTTY. The password now reaches `ssh` through an `SSH_ASKPASS` helper
  (OpenSSH 8.4+), so neither PuTTY nor `sshpass` is required.
* The askpass helper was created lazily inside `$( )`; a subshell's variables do
  not come back, so it created one temporary directory per connection and left 12
  behind in a single run.
* Two `trap ... EXIT` statements, the second of which silently displaced the
  first.
* The network search used only the first private address (wrong network on a
  machine with a VPN or second NIC), and probed port 22 even when `--port` said
  otherwise.
* A dropped connection was reported as "no tar on the phone".
* The 74 MB Node binary was left behind in `Documents` after installation; the
  two tarballs were cleaned up and this one was missed.
* A staging directory was created on every run and used by nothing.

### Changed

* **PuTTY stays first, now with the measurement behind it.** Parallel to the
  fallback work: on the network this was written for, 20 sequential connections
  gave **plink 20/20** and the built-in `ssh` **17/20**, failing at the same three
  positions with the proxy both off and on. So the `ssh` weakness is not the
  proxy's doing — a proxy is just one more thing on the route — and both READMEs
  say exactly that instead of the tidier story.
* Because of it, connections are now **retried twice** before a failure is
  reported. Without that, the OpenSSH fallback fails most runs on exactly the
  networks that need it.
* `--dry-run` **announces that it still connects and still asks for the
  password**: the plan is built from what is already installed on the phone.
  Nothing in it writes, but being asked for a password immediately after asking
  for a dry run reads as the flag having been ignored.
* The quick start shows the dry run as three lines to copy, rather than "add
  `--dry-run` to the last line".
* `ConnectTimeout` 20 s → 10 s. It covers the banner exchange, which is where
  this transport fails, and the retry triples it.

### Verified

* `fixtures/verify-image-codec.mjs`: **16 passed, 0 failed** with the addon on,
  and 16/16 with it off.
* An addon built from the shipped source by the shipped `build.sh` produces
  output **byte-identical** to the deployed one — decode, resize and PNG encode.
* The transfer path was rehearsed through both transports into empty directories
  on the device: 57 files each, every sha256 computed on the phone matching the
  local one.

---

## 2026-09-21 — first working port

* `install.sh`: adapts an existing Node + DSH tree — native-module shims
  (`koffi`, `win32-process`, `flock`), a pure-JS `sharp` overlay, a pure-JS
  ripgrep replacement, three patched DSH files, a one-byte Mach-O patch plus
  `ldid` re-sign, and browser polyfills.
* `sharp-ios/`: the pure-JS image codec (PNG, JPEG, resize, EXIF), verified
  against fixtures whose recorded truth is in `fixtures/blind-test.answer.txt`.
* `rg-ios/`: a pure-JS ripgrep replacement called in-process, because
  `ripgrep-ios-arm64` is never published and spawning a script on this platform
  is unreliable.
* `preload/`: the WebAssembly stand-in and the `fetch` shim that make undici
  importable under `--jitless`.
* `bootstrap.sh`: desktop-side install — device discovery, Node download with a
  pinned sha256, `npm install` on the computer, transfer, adapt, start.
* `docs/jbroot-namespaces.md` and `docs/ios-constraints.md`: the two long-form
  notes this repository exists to carry.
* README in English and Chinese, with tested scope stated as one device, one iOS
  version and one jailbreak, and credits for the jailbreak this is all
  downstream of.
