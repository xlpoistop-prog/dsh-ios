# rootHide's two filesystem namespaces, and why they break things

This is the finding that cost the most time in this port and that is hardest to
find written down anywhere. It is written up first because almost every other
oddity traces back to it.

Verified on: iPhone 15 (A16), iOS 17.1.1, Relaxin (rootHide), Node 22.19.0
running `--jitless`, August–September 2026.

---

## The short version

On a rootHide jailbreak there are **two different answers to "where is
`/var/mobile`?"**, and which one you get depends on whether the process in
question went through rootHide's path interposition.

| Reader | `/var/mobile/Documents/x` resolves to |
|---|---|
| A **jailbreak binary** (NewTerm's `zsh`, `tar`, `ldid`) | `<jbroot>/var/mobile/Documents/x` |
| **Our Node binary** — a stock iOS build, *not* linked against rootHide | the **real** `/var/mobile/Documents/x` |

`<jbroot>` is a randomly named directory that changes on every re-jailbreak,
e.g. `/private/var/mobile/Containers/Shared/AppGroup/.jbroot-9B4D3528BE4E3803/`.

Node has no interposition because it is not a jailbreak binary. Nothing about it
is broken — it simply sees the real filesystem, which is the correct behaviour
for a normal iOS process. The confusion is that the *shell you launch it from*
does not.

## How to see it in one command

From the shell, `cd` somewhere under `/var/mobile` and ask Node where it thinks
it is:

```sh
cd /var/mobile/Documents/dsh-ios
./node --jitless -e "console.log(process.cwd())"
# /private/var/mobile/Containers/Shared/AppGroup/.jbroot-9B4D3528BE4E3803/var/mobile/Documents/dsh-ios
```

Node reports the **jbroot-prefixed** path. The shell's own `pwd` reports the
plain `/var/mobile/Documents/dsh-ios`. Both are "right"; they are different
views of the same directory. Note that the *kernel* agrees with Node — the
directory really does live under jbroot. `getcwd()` returns the real path
because that is what the kernel stores, and the shell only displays the
interposed form.

## What this breaks

### Absolute paths handed to Node

```sh
node /var/mobile/Documents/dsh-ios/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
# Error: Cannot find module '/var/mobile/Documents/dsh-ios/...'
```

Node resolves `/var/mobile/...` against the **real** root, where our files do not
exist. The same applies to `--import`, config paths, and anything else passed as
an argument.

**Rule: `cd` into the directory first, then pass paths relative to it.** The
shell performs the `chdir` through its own view, and Node inherits a correct
working directory via the kernel, so relative resolution works even though the
two processes disagree about the string form of the path.

This is why every launch in this repo is written as:

```sh
cd "$BASE" || exit 1
nohup ./node --expose-internals --import ./wasm-polyfill.js ... ./dsh/node_modules/.../bin.js web ...
```

### `dlopen` of native modules

The same mismatch applies to anything that resolves a path at runtime. It also
gives a *second*, unrelated failure — see the next section.

### Symlinks between the two namespaces

Creating `/var/mobile/Documents/dsh → <jbroot>/var/mobile/Documents/dsh` from
the shell appears to work, and makes non-interposed readers able to find the
tree. It was tried here and then abandoned: it makes the same path mean two
things depending on who asks, adds a layer of indirection to debug, and breaks
again on every re-jailbreak when the jbroot name changes. Relative paths from a
single `cd` are simpler and survive.

## The mmap constraint: jbroot works, the real filesystem does not

Separate from the namespace question, and the reason the install lives **inside
jbroot** rather than in the real user Documents directory.

An attempt was made to install into the real `/var/mobile/Documents/` so the
tree would survive an un-jailbreak. Native modules then failed to load:

```
DLOPEN_FAIL: dlopen(.../node-pty/prebuilds/ios-arm64/pty.node, 0x0001):
  tried: '...' (file system sandbox blocked mmap() of '...')
```

iOS's file-system sandbox refuses `mmap()` of executable code from that
location. The identical file, with the identical signature, loads fine from
inside jbroot. Adding `com.apple.private.security.no-sandbox` to the Node
binary's entitlements did **not** change it — the restriction is imposed by the
sandbox the process is already in, not by what Node may request.

**Rule: native `.node` modules must live inside jbroot.** The trade is real —
everything under jbroot is deleted when the jailbreak is removed — which is why
this repo ships an installer rather than a prebuilt tree.

## Consequences worth knowing before debugging

* **`pkill -f` silently does nothing here.** Process management is a pidfile plus
  `kill`, with `killall node` as the escape hatch for an orphan that has no
  pidfile. There is no `ps`, no `lsof`, no `ss`, no `netstat` on the device — to
  test whether a port is free, bind it with Node itself.
* **`su` is the BSD one** (`su [-] [-flm] [login [args]]`) and does not accept
  `-c`; root SSH login was refused with `PermitRootLogin` in its default state.
* **No `gzip`** in the jailbreak userland, although `tar` is present. `tar -xzf`
  fails with `gzip: cannot exec`. Decompress with Node's `zlib` instead:
  ```sh
  ./node --jitless -e "
    require('fs').writeFileSync('x.tar',
      require('zlib').gunzipSync(require('fs').readFileSync('x.tar.gz')))"
  ```
* **`/usr/bin` as seen by the shell is the jailbreak's**, and carries a full
  Procursus userland (`bash`, `cat`, `grep`, `sed`, `find`, `zsh`, …). The real
  iOS `/usr/bin` is nearly empty. When a tool is missing, check the shell's view
  before concluding it is absent from the system.

## Why the launch script uses relative paths *and* a jbroot-derived PATH

These look contradictory and are not:

```sh
cd "$BASE" || exit 1
export PATH="$(jbroot)usr/bin:$(jbroot)bin:/usr/bin:/bin:..."
nohup ./node ... --import ./wasm-polyfill.js ...
```

* **`--import` and the entry point are relative** — Node resolves them against a
  working directory that the kernel already made correct, so no path string has
  to be right.
* **`PATH` entries are absolute** — they are looked up by `execvp` in the spawned
  child, which has no way to inherit a working directory relative to them. They
  therefore have to be real paths, and `$(jbroot)` is the only way to name one
  that survives a re-jailbreak.

`$(jbroot)` and Node's `realpathSync` do **not** always agree — on the device
tested, `jbroot` reported `/var/containers/Bundle/Application/.jbroot-XXXX/`
while Node's realpath of the same tree was
`/private/var/mobile/Containers/Shared/AppGroup/.jbroot-XXXX/...`. Both are
reachable; prefer whichever the consumer resolves itself. For a shebang, neither
proved reliable as an interpreter path — which is one more reason the pure-JS
replacements in this repo avoid `exec` entirely.
