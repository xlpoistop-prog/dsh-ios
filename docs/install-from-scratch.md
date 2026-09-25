# Starting from nothing

`install.sh` assumes Node 22 and a DSH tree are already on the device. This is
how to get those there. Written for a jailbroken device reachable over SSH from
a desktop machine.

Throughout: **run device commands in the device's shell**, not through Node's
view of the filesystem. See [`jbroot-namespaces.md`](jbroot-namespaces.md) for
why that distinction matters and will bite you repeatedly otherwise.

---

## 0. Before you start

### Tested scope

Verified against **one configuration only**: iPhone 15 (A16), **iOS 17.1.1**,
Relaxin (rootHide), Node 22.19.0. **No other iOS version, device or jailbreak has
been tried.** The constraints below are platform properties rather than
version-specific quirks, so the approach should transfer — but that is reasoning,
not evidence. Expect to re-derive details on anything else, and note that a
**rootless** jailbreak (Dopamine and relatives) does not have the jbroot split
described in [`jbroot-namespaces.md`](jbroot-namespaces.md) in the same form.

### What you need

* a **jailbroken** device, with **`ldid`** — required to re-sign the two patched
  native addons. Almost every bootstrap ships it; check with `which ldid`.
* **`tar`** on the device. There is typically **no `gzip`** — see the
  decompression recipe below.
* **An SSH server on the device** — `openssh-server` from the jailbreak repos —
  if you want to work over SSH. This is not optional for remote access: every
  client ends up talking to `sshd` **on the device**, including i4Tools' channel,
  which only forwards a local port over USB (usbmuxd). Removing OpenSSH makes it
  fail with `Connection refused` while the i4Tools dialog still reports success,
  because that dialog only says the tunnel was created.
* **A terminal on the device.** [NewTerm](https://repo.chariz.com/) is what this
  was built with. Any POSIX shell should do; the scripts assume nothing beyond
  `sh`.

Nothing else. **No Mac, no Xcode, no cross-compiler.**

### Strongly recommended: SSH from a desktop

Not required — everything here runs from NewTerm. But it is the difference
between minutes and hours when something goes wrong, and this port was debugged
that way:

* copy files with `pscp`/`scp` instead of typing them out
* run a command and read its output directly, instead of transcribing it by hand
* iterate without switching apps

On Windows the `ssh`/`scp` you already have (Git Bash, or Windows 10/11's own) are
enough; the PuTTY suite (`plink` + `pscp`) is equally fine, and the examples below
write `pscp` because it takes a password in one argument. i4Tools' channel is the
convenient way to reach the device because it needs no device IP or Wi-Fi — but
it is a **forwarder, not a server**, so OpenSSH still has to be installed.

---

## 1. Get Node 22 for iOS

This is the one component that has to be a real iOS build. Two routes:

### Route A — use the build this port publishes (what `bootstrap.sh` does)

This port builds its own Node and publishes it, so its provenance is a release in
this repository rather than someone else's:

```
https://github.com/XLPOISTOP-prog/dsh-ios/releases/download/node-ios-v24.21.0-jit/node-v24.21.0-iphoneos-arm64
size    79,707,248 bytes
sha256  c3d667b8c4385086c150b7f495a5f8ded2e585be96b6bbd4b85f8df82c28bb62
```

**Verify the checksum before using it.** If it does not match, stop — something
changed upstream, or the download was tampered with:

```sh
# on the desktop
curl -LO https://github.com/XLPOISTOP-prog/dsh-ios/releases/download/node-ios-v24.21.0-jit/node-v24.21.0-iphoneos-arm64
sha256sum node-v24.21.0-iphoneos-arm64
# expect: c3d667b8c4385086c150b7f495a5f8ded2e585be96b6bbd4b85f8df82c28bb62
```

This build has a working JIT, which earlier builds of this port did not: patches
04 and 05 in `node-ios/` implement the W^X hook V8 never got on iOS and repair a
code page on the fault. See [`node-ios/README.md`](../node-ios/README.md). It
needs **no** `--jitless`; set `DSH_JITLESS=1` only to fall back.

Then stage it and push:

```sh
# on the desktop — stage where the real filesystem is visible, then move it from
# the device shell (see the note on jbroot paths above)
pscp -pw <pw> node-v24.21.0-iphoneos-arm64 mobile@127.0.0.1:/rootfs/var/mobile/Documents/
```

```sh
# on the device
cd /var/mobile/Documents/dsh-ios
cp /rootfs/var/mobile/Documents/node-v24.21.0-iphoneos-arm64 node
chmod 755 node
ldid -Sscripts/entitlements.plist node     # signing is required on a jailbroken device
./node --version                           # expect v24.21.0
./node -e "console.log(process.arch, process.platform)"
# expect: arm64 ios
```

Confirm JIT is actually on rather than assumed — the engine reports it:

```sh
./node --allow-natives-syntax -e '
  const f = (a) => a + 1;
  for (let i = 0; i < 1e5; i++) f(i);
  console.log(%GetOptimizationStatus(f));
'
# non-zero, and not just the "interpreted" bit, means Turbofan/Maglev ran
```

That build is MIT-licensed, and its maintainer describes it as *"the first public
Node >=20 build for iOS"*. Its own release notes recommend the same flag this
port depends on — `Run with --jitless` — which is worth knowing: **`--jitless` is
not a workaround invented here.** It is the intended usage of the only public
Node build for this platform.

Two things to know:

* **`--jitless` is mandatory** with this build. Without it you get `SIGBUS` on
  the first JS execution. There is nothing to configure; it is not a
  JIT-capable build on this OS.
* `process.platform` is **`ios`**, not `darwin`. Anything that derives a package
  name or a path from `process.platform` will look for a package that does not
  exist. That is why `rg-ios/` and `sharp-ios/` exist.

### Route B — build it yourself

If you have a Mac and a CI budget, the
[cross-compiled port](https://github.com/ddddddedcds/Node.js-for-ios) documents
this properly, including a V8 patch that gets **real JIT** working. That build
is strictly faster than the one this port uses. It is simply out of scope for a
toolchain-free approach.

---

## 2. Get the DSH tree

On the device, if `nodejs` came with `npm`:

```sh
mkdir -p /var/mobile/Documents/dsh-ios/dsh && cd /var/mobile/Documents/dsh-ios/dsh
npm install @deepseek-ai/dsh
```

**Most jailbreak Node packages ship the binary without `npm`.** If yours does,
build the tree on a desktop instead and copy it over:

```sh
# on the desktop, matching the device's Node major version
mkdir dsh-tree && cd dsh-tree
npm install @deepseek-ai/dsh
```

```sh
# copy it in. tar first: thousands of small files over SSH is slow otherwise.
tar -cf dsh-node_modules.tar node_modules
pscp -pw <pw> dsh-node_modules.tar \
     mobile@127.0.0.1:/var/mobile/Documents/dsh-ios/dsh/
```

```sh
# on the device
cd /var/mobile/Documents/dsh-ios/dsh
tar -xf dsh-node_modules.tar && rm dsh-node_modules.tar
ls node_modules/@deepseek-ai/dsh/lib/bin.js    # must exist
```

If you compressed it, remember there is **no `gzip` on the device** — either
ship a plain `.tar`, or decompress with Node:

```sh
../node --jitless -e "
  require('fs').writeFileSync('dsh-node_modules.tar',
    require('zlib').gunzipSync(require('fs').readFileSync('dsh-node_modules.tar.gz')))"
```

---

## 3. Put the port files on the device

```sh
# on the desktop
git clone https://github.com/<you>/dsh-ios.git
pscp -pw <pw> -r dsh-ios mobile@127.0.0.1:/var/mobile/Documents/
```

⚠️ Copying **into jbroot** matters. `pscp` writes to the real filesystem, where
paths look different. From the desktop, the real path is `/rootfs/...` relative
to the device shell. The reliable procedure is: `pscp` to a real-filesystem
staging directory, then `cp` into place from the device shell:

```sh
# desktop: stage it somewhere the real filesystem exposes
pscp -pw <pw> -r dsh-ios mobile@127.0.0.1:/rootfs/var/mobile/Documents/

# device shell: move it into jbroot
cd /var/mobile/Documents
cp -R /rootfs/var/mobile/Documents/dsh-ios .
```

---

## 4. Install

```sh
cd /var/mobile/Documents/dsh-ios
sh install.sh --dry-run      # see what it would do
sh install.sh
```

If it cannot find the DSH tree:

```sh
sh install.sh --dsh-tree /var/mobile/Documents/dsh-ios/dsh
```

## 5. Run

```sh
sh scripts/start.sh
```

It prints a URL of the form `http://127.0.0.1:3080/?token=…`. **Open that in
Safari on the device.** It is loopback-only by design; there is no remote
exposure.

**You only need the token once.** Safari stores the cookie the URL sets, so
after opening the full URL a single time, plain `127.0.0.1:3080` works from then
on. This is worth knowing because the token changes on every launch and is long
enough to be annoying to retype — and it is also why an old bookmark can look
like "the server is down" when the server is fine.

The URL is also written to `/var/mobile/Documents/dsh-url.txt` so the Files app
can reach it.

Inside the UI, set the permission mode to full access on first use —
`workspace-write` cannot start command-backed work here, because the sandbox
backends DSH looks for (bubblewrap/Landlock on Linux, `sandbox-exec` on macOS)
do not exist on iOS.

---

## Troubleshooting

**`EADDRINUSE` on start.** A previous instance still holds the port, and
`pkill -f` does not work on this device — it returns success and does nothing.
`scripts/start.sh` kills by pidfile and falls back to `killall node`; use
`DSH_SAFE=1 sh scripts/start.sh` if you must not disturb other node processes,
and clean up by hand.

**`Cannot find module '/var/mobile/…'`.** You passed an absolute
`/var/mobile/...` path to Node. `cd` first and pass a relative path. See
[`jbroot-namespaces.md`](jbroot-namespaces.md).

**`dlopen … file system sandbox blocked mmap()`.** The native module is outside
jbroot. It has to live inside.

**`ripgrep launch failed`.** The patched `dsh-tool-fs-search` was not installed,
or `rg-ios/rg-impl.mjs` is missing next to `bin/rg`.

**`Unsupported or malformed image data`.** The pure-JS codec overlay is not in
place, or the cached request image predates it — clear
`dsh-home/attachments/v1/request-images/`.

**Nothing happens when picking a workspace, and the server log is silent.**
Almost always a mounted agent preset failing, not a path problem. Check the
server log with the `tools/diag-overlay.js` banner installed — see
[`ios-constraints.md`](ios-constraints.md) §12 and §15.

**Everything is slow.** Expected. `--jitless` interprets; there is no
optimising compiler. Prefer starting a fresh session over continuing a very long
one, and expect the first seconds after launch to be busy.
