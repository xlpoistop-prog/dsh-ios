# dsh-ios

**English** | [中文](README.zh.md)

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
on a jailbroken iPhone — with **no Mac, no Xcode, and no cross-compilation**.

## Quick start

**⚠️ First, confirm one thing: can you already reach the phone over SSH from
this computer?**

* **Yes** — carry on. The command below finds the phone and prompts for the
  password; in the common case it is just these three lines.
* **No** — **read [Install](#install) first.** The phone needs a jailbreak and
  **OpenSSH** (`openssh-server` from Sileo). The computer needs an SSH client:
  PuTTY if you have it, otherwise the one your system already ships —
  **nothing to download either way**. **The script cannot install the phone half
  of that** — every SSH route to the phone ends at `sshd` running *on the phone*.
  Come back once it works.

**Once that is true, the fastest route: put the phone and the computer on the
same Wi-Fi, then run these three lines.**

```sh
git clone https://github.com/XLPOISTOP-prog/dsh-ios.git
cd dsh-ios
./bootstrap.sh
```

> **Too lazy to download PuTTY, or not sure how to use it? Then don't.** If PuTTY
> is installed the script uses it; if it is not, it falls back to the `ssh` your
> computer already has — Git Bash brings one, and so does Windows 10/11 — and
> finds the phone on your Wi-Fi by itself. **Either way there is nothing to
> install: same Wi-Fi, one command, one password.**

> ⚠️ **One exception, and it matters: if a proxy or VPN is running on this
> computer — Clash, Surge, Meta, sing-box, and especially in TUN or global mode —
> use PuTTY.** Those take over the route to the local network as well, which is
> one more thing standing between this computer and the phone. On one machine, 20
> sequential connections gave **plink 20/20** and **`ssh` 17/20** — measured
> twice, with the proxy off and on, failing in exactly the same three places both
> times, always `Connection timed out during banner exchange`, i.e. never getting
> as far as authenticating. The script looks for a running proxy and warns you
> when you are on the built-in `ssh`.

**No IP to look up, no arguments to work out.** The script finds the phone
itself — first checking whether anything is listening on `127.0.0.1` (a
USB-forwarded channel), otherwise scanning this computer's own local networks for
SSH servers (by reading their banners, not by testing whether the port is open) —
**and then asks for the password**, the one the jailbreak asked you to set
(`alpine` if you never set one).

**To look before leaping, run this one instead** — it only looks:

```sh
git clone https://github.com/XLPOISTOP-prog/dsh-ios.git
cd dsh-ios
./bootstrap.sh --dry-run
```

It prints what it intends to do and **changes nothing** — but it still contacts the
phone and still asks for the password, because the plan is built from what is
already installed there. Everything it runs on the phone is read-only. Happy with
the plan? Run the same thing without `--dry-run`.

**What the search actually covers**, since it can only find the phone if it is
somewhere it looked:

* the **private ranges only** — `192.168.x.x`, `10.x.x.x`, `172.16–31.x.x` — one
  `/24` for **each** address this computer holds (a second NIC or a VPN with its
  own `10.x` address included, so the wrong network does not get scanned instead
  of the right one);
* port **22**, or whatever `--port` says. `22` is OpenSSH's default, and the stock
  `openssh-server` config on a jailbroken device leaves `Port 22` commented out,
  which means the default applies. Some jailbreaks listen on a second port as
  well — the launchd plist on the device this was written for opens **2222** too;
* **not** the phone if it is on a different network from this computer (a guest
  SSID, mobile data), not a LAN bigger than a `/24` where the phone sits outside
  this computer's own range, and not a non-default port without `--port`. Give the
  address yourself in those cases: `--device mobile@<phone ip> --port <n>`.

### Specifying the connection yourself

For the cases the search cannot cover, or when it fails:

| Your setup | Pass |
|---|---|
| **Wi-Fi, same network** | `--device mobile@<phone IP>` from Settings → Wi-Fi |
| **i4Tools' "open SSH channel"** | `--device mobile@127.0.0.1` — it forwards the phone's port 22 to your local port 22 over USB |
| **`iproxy`** (libimobiledevice) | `--device mobile@127.0.0.1 --port <the port you forwarded>` |
| **Any other tunnel** | `--device mobile@<host> --port <port>` |
| **Prefer not to type the password** | omit `--password` and it prompts, with echo off |

| Argument | Meaning |
|---|---|
| `--device USER@HOST` | **How to reach the phone.** `mobile` is the account name **on the phone** (iOS always has `root` and `mobile`; use `mobile`, since root login is normally disabled). Omit it and the script searches. |
| `--password <pw>` | The password for the `mobile` account **on the phone** — the one the jailbreak asked you to set (`alpine` if you never did). Omit it and it prompts. |
| `--dry-run` | Prints what it intends to do and **changes nothing**. It still connects and still asks for the password — the plan depends on what is already installed. |
| `--key <file>` | Use an SSH private key instead of a password. |
| `--port <n>` | SSH port. Default 22, which is OpenSSH's own default. Also the port the search scans. |
| `--push-only` | Copy the repo across and stop: no Node, no DSH tree, no `install.sh`, no restart. For checking that a transfer works. |
| `--transport putty\|openssh` | Force which SSH client to use. By default PuTTY is used when it is installed, and the built-in `ssh` when it is not. |
| `--hostkey <fp>` | Pin the host key (by default it is learned on first contact). |

> **Nothing here requires i4Tools.** `127.0.0.1` is simply one of the things the
> search tries; Wi-Fi or any other forwarder works.

**Then `bootstrap.sh` does the rest by itself:**

1. checks the phone — jailbreak, `jbroot`, `ldid`, `tar`, and whether Node and
   the DSH tree are already there,
2. if Node is missing, downloads the pinned build, **verifies its sha256**, and
   copies it across,
3. if the DSH tree is missing, runs `npm install` **on your computer** (which is
   where npm and a fast network are), packs it, and copies it across,
4. copies this repo across, runs `install.sh` on the phone, and starts it,
5. prints a `http://127.0.0.1:3080/?token=…` URL.

**Finally**, open that URL in **Safari on the phone** and set the permission mode
to **full access** — `workspace-write` has no sandbox backend able to start on
iOS.

**Before the script can work you need, on the phone:** a jailbreak,
[NewTerm](https://repo.chariz.com/), **`openssh-server`** from Sileo, and
`ldid` + `tar`. **On the computer:** an SSH client — PuTTY (`plink` + `pscp`) if
you have it, since that is what the script reaches for first, otherwise the
`ssh`/`scp` that ship with Git for Windows, WSL, macOS, Linux, and Windows 10/11
itself. Neither has to be downloaded. The [Install](#install) section below
walks through all of it — including why i4Tools reports success even when
OpenSSH is missing.

**Only tested on iPhone 15 / iOS 17.1.1 / Relaxin (rootHide).** See
[tested scope](#read-this-before-assuming-it-will-work-for-you) before assuming
it transfers to your setup.

```
┌─────────────────────────────────────────────┐
│  Safari → http://127.0.0.1:3080             │
│    dsh web UI, workspace picker, sessions   │
├─────────────────────────────────────────────┤
│  dsh                                       │
│    plugins · agent loop · tools             │
├─────────────────────────────────────────────┤
│  Node 22 (stock iphoneos-arm64 build)       │
│    --jitless · preloaded JS shims           │
├─────────────────────────────────────────────┤
│  iOS 17 / jailbroken                        │
└─────────────────────────────────────────────┘
```

Verified on **iPhone 15 (A16), iOS 17.1.1, Relaxin (rootHide)** with
**Node 22.19.0**.

<table>
<tr>
<td width="50%"><img src="docs/screenshots/dsh-web-ui.png" alt="The DSH web UI running in Safari on iOS"></td>
<td width="50%"><img src="docs/screenshots/settings.png" alt="DSH settings showing the permission mode set to full access"></td>
</tr>
<tr>
<td align="center"><em>DSH's own web UI, in Safari on the device. Session<br>list, workspace picker, model selector — the real<br>thing, not a mock-up.</em></td>
<td align="center"><em>Settings, with the permission mode on full<br>access. That is required here: <code>workspace-write</code><br>has no sandbox backend able to start.</em></td>
</tr>
</table>

Served from `127.0.0.1:3080`, loopback only. On desktop DSH opens a browser for
you; here `--no-open` is passed and the URL printed, with a fresh token each
launch.

### Read this before assuming it will work for you

Developed and verified against **exactly one configuration**. Nothing else has
been tried:

| | |
|---|---|
| Device | iPhone 15 (A16) |
| iOS | **17.1.1 — and nothing else** |
| Jailbreak | Relaxin (rootHide) |
| Node | 22.19.0 (`iphoneos-arm64`) |

The mechanisms this port depends on — the jbroot namespace split, the `mmap`
restriction on native modules, `--jitless` behaviour, the absent `gzip` — are
properties of the platform rather than of one iOS release, so the approach
should carry over. **But that is reasoning, not evidence.** On a different iOS
version, device or jailbreak, expect to re-derive the details. Treat
[`docs/ios-constraints.md`](docs/ios-constraints.md) as a checklist of things to
verify, not a guarantee that they hold.

In particular, a **rootless** jailbreak (Dopamine and relatives) will not have
the jbroot split described here in the same form — the namespace section is
specific to rootHide's layout.

### Practical notes

**A terminal on the device is required.** [NewTerm](https://repo.chariz.com/) is
what this was built and used with. Any POSIX shell should do; the scripts assume
nothing beyond `sh`.

**SSH from a computer is not required, but it is the single biggest time saver.**
Everything works from NewTerm alone. What SSH changes is how fast you can debug:
copy files with `pscp`/`scp` instead of retyping, run commands and read their
output directly instead of transcribing by hand, and iterate without switching
apps. This port was debugged over SSH, and the difference is not marginal.

**An SSH server must be installed on the device** — OpenSSH from the jailbreak
repos. There is no way around this: any client, including i4Tools' channel, ends
up talking to `sshd` *on the device*. i4Tools is convenient because it forwards
a local port over USB (usbmuxd), so no device IP or Wi-Fi is needed — but it is
a forwarder, not a server. Uninstalling OpenSSH makes it return
`Connection refused` while the i4Tools UI still cheerfully reports success, since
that dialog only reports that the tunnel was created, not that anything answered.

**The token is only needed once.** Safari keeps the cookie that
`?token=…` sets, so after opening the full URL a single time, plain
`127.0.0.1:3080` works from then on. Worth knowing, because the token changes on
every launch and is long enough to be genuinely annoying to retype — and it is
also why a stale bookmark can look like "the server is down".

---

## Install

Two entry points. **The commands are in [Quick start](#quick-start) above** —
this section is what has to be true before they will work, and what each script
actually does.

### One command, from a desktop

`bootstrap.sh` checks the phone, fetches Node, builds the DSH tree here (npm and
the network are on this side, not there), copies it all over, adapts it, and
starts it.

It is idempotent: anything already present is left alone. Run `--help` for the
rest (`--key`, `--hostkey`, `--install-dir`, `--skip-node`, `--skip-dsh`, …).

#### Getting the pieces in place

**On the device** — these come first, and nothing here can install them for you:

1. **A jailbreak.** See [Credits](#credits) for the projects this was tested against.
2. **[NewTerm](https://repo.chariz.com/)** — the terminal you will actually run things from.
3. **OpenSSH** — `openssh-server` from Sileo. **Not optional for remote work**:
   every SSH client, including i4Tools' channel, ends up talking to `sshd` *on
   the device*. Removing it makes the channel fail with `Connection refused`
   while the i4Tools dialog still reports success.
4. **`ldid`** and **`tar`** — almost every bootstrap ships both. Check with
   `which ldid tar`.

**Space on the phone:** a full install measured **423 MB** on the test device,
71 MB of that the Node binary. Budget 450 MB.

**On your computer** — one SSH client:

| Platform | Use | Notes |
|---|---|---|
| **Windows, with PuTTY** | `plink.exe` + `pscp.exe` ([download](https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html), or from *Alternative binary files*) | **Preferred when present** — the password goes in as an argument, with nothing in between. |
| **Windows, without PuTTY** | the `ssh`/`scp` that are **already installed** — Git Bash has them, and so does Windows 10/11, in `C:\Windows\System32\OpenSSH` | **Nothing to download.** Git Bash is what runs this script anyway. |
| Linux / macOS | `ssh` + `scp`, plus `sshpass` if you want to pass a password | Or use an SSH key with `--key`. |
| WSL | as Linux | |

Either one is fine — PuTTY is used when it is installed, the built-in `ssh` when
it is not.

**⚠️ But if a proxy or VPN is running on this computer, use PuTTY.** Transparent
proxies — Clash, Surge, Meta, sing-box, TUN mode generally — take over the route
to the local network too, and the built-in `ssh` is the transport that suffers
first. Measured on one machine, 20 sequential connections gave **plink 20/20**
and **`ssh` 17/20**, run twice — once with no proxy and once with one up — and it
failed at exactly the same three positions each time, always
`Connection timed out during banner exchange`, i.e. before authenticating at all.
So the weakness is not the proxy's doing; a proxy is just one more thing that can
sit on the route to the phone. Being on the built-in `ssh` *and* behind a proxy
is the combination worth avoiding.

The script looks for a running proxy (a Wintun/TAP adapter, or a fake-IP DNS
server such as `198.18.x.x`) and warns you when you are on the built-in `ssh`; it
also retries every failed connection twice before giving up on it.

How the password reaches `ssh`, which is the only thing that differs:
it never goes on the command line, and Windows has no `sshpass`, so the script
writes a tiny `SSH_ASKPASS` helper (in a temporary directory, removed on exit —
the password itself is passed in the environment, never written to the file) and
points OpenSSH at it. That needs OpenSSH 8.4 or newer for
`SSH_ASKPASS_REQUIRE=force`; Git for Windows and Windows 10/11 are both well past
it. On anything older the script says so, and the password is simply asked for
once per connection.

PuTTY is looked for on `PATH`, in the usual install locations, and in a `plink/`
folder under `%TEMP%`, `%USERPROFILE%` or `~/Desktop` — which is where it ends up
if you extract the PuTTY zip rather than running the installer. To point at it
explicitly, or to force one of the two:

```sh
PLINK=/path/to/plink PSCP=/path/to/pscp ./bootstrap.sh --device ...
./bootstrap.sh --transport openssh --device ...    # or: --transport putty
```

**Reaching the device.** Two options:

* **i4Tools' "open SSH channel"** — forwards a local port over USB, so no device
  IP or Wi-Fi is needed. It listens on `127.0.0.1:22`, which is the default this
  script assumes. Re-open it after reinstalling OpenSSH.
* **Wi-Fi** — `--device mobile@<device-ip>` using the address shown in
  Settings → Wi-Fi.

### Already have Node + DSH? Just adapt

Requirements: a **jailbroken** device with **Node 22 already present**, `ldid`,
and `tar`.

```sh
git clone https://github.com/XLPOISTOP-prog/dsh-ios.git
cd dsh-ios
sh install.sh
```

`install.sh` is idempotent and dry-runnable (`--dry-run`). It will:

1. locate the DSH tree and refuse to guess if it cannot find it,
2. install the native-module shims,
3. overlay the pure-JS image codec into `node_modules/sharp`,
4. install the pure-JS ripgrep replacement,
5. copy the three patched DSH files,
6. rewrite the Mach-O platform byte on the native addons (`pty.node`, and
   `system.node` where a tree has one) and re-sign,
7. inject the browser polyfills into the frontend's `index.html`.

Then:

```sh
sh scripts/start.sh          # prints a Safari URL
```

`scripts/start.sh` handles the parts that are easy to get wrong here — see
[`docs/jbroot-namespaces.md`](docs/jbroot-namespaces.md) for why it does what it
does. `scripts/stop.sh` stops it.

### `start.sh` flags

```sh
sh scripts/start.sh 3081        # different port
DSH_SAFE=1 sh scripts/start.sh  # do not kill unrelated node processes
```

### The rest of `bootstrap.sh`'s flags

`--help` lists every one. These are the ones not in the quick-start table:

| Flag | Meaning |
|---|---|
| `--install-dir <dir>` | Where to install on the phone. Default `/var/mobile/Documents/dsh-ios`. |
| `--dsh-version <v>` | Pin `@deepseek-ai/dsh` instead of taking the latest. |
| `--node-url <url>` | Fetch the Node build from somewhere else. |
| `--skip-node` / `--skip-dsh` / `--skip-start` | Leave that stage out. |
| `--push-only` | Copy the repo across and stop — no install, no restart. |

---

## When it does not work

A failed run is always safe to repeat: `bootstrap.sh` and `install.sh` are both
idempotent, and every file `install.sh` replaces is kept as
`<name>.dsh-ios.bak` first. Add `--dry-run` to see the plan without writing
anything.

The script's last line is usually the answer — it names what failed instead of
just stopping. The ones worth recognising:

| What you see | What it means | What to do |
|---|---|---|
| `no usable SSH transport found` | There is neither PuTTY nor `ssh`/`scp` on `PATH`. | Install PuTTY, or run the script from Git Bash, which has `ssh`. |
| `cannot reach mobile@…` | The connection failed. The text above it is the SSH client's own words, and the four usual causes are listed. | Test the connection on its own — `ssh mobile@127.0.0.1 "echo ok"`, or the `plink` equivalent. Nothing here will work until that does. |
| `found no SSH server on port 22 in: …` | Nothing answered anywhere it looked. | Phone on another network (guest SSID, mobile data)? Non-default port (`--port`)? A LAN larger than a `/24`? Pass `--device mobile@<ip>` yourself. |
| `Several hosts answered on port 22` | More than one SSH server replied and it refuses to guess. | Pick the phone out of the list and pass it: `--device mobile@<ip>`. |
| `checksum mismatch for …` | The downloaded Node does not match the pinned hash. | Do not continue. Re-run; if it repeats, the source is wrong or changed — `--node-url` points elsewhere. |
| `no npm on this machine` | The phone has no DSH tree and the computer has no npm to build one. | Install Node.js on the computer, or copy a tree over — [from scratch](docs/install-from-scratch.md). |
| `install.sh failed on the phone` | The adapt step stopped; the phone's output just above says where. | Re-run. Backups make it safe, and the second run usually shows a real cause rather than a first-run one. |
| The URL opens, but the page is blank or the picker keeps reverting | Token, or permission mode. | Open the full `?token=…` URL once — Safari keeps the cookie — and set the permission mode to **full access**. |
| `EADDRINUSE`, or "started" but nothing answers | A stale server still holds the port, and `pkill -f` does not work on this platform. | `sh scripts/start.sh` kills it by pidfile and falls back to `killall -9 node`. `DSH_SAFE=1` makes it refuse instead of killing. |
| It worked, then you re-jailbroke | The install lives inside jbroot, which a re-jailbreak replaces. | Re-run `bootstrap.sh`. |

### Rolling back, or starting over

* **Undo the adaptation:** every file `install.sh` replaces has a
  `<name>.dsh-ios.bak` next to it, including the patched native addon. Copy them
  back and restart.
* **Remove it entirely:** delete the install directory (default
  `/var/mobile/Documents/dsh-ios`) and stop the server. Everything the install
  writes on the phone lives inside that directory — the DSH tree, `dsh-home` with
  your sessions, and the browser polyfills.
* **Start clean without re-downloading anything:** `--push-only` re-copies the
  repo; add `--skip-node --skip-dsh` to leave the big pieces alone.

---

## Why this port is different

There is at least one other iOS port of DSH, and it is a serious piece of work:
it cross-compiles Node with a patched V8 so that **full JIT works**, compiles
`node-pty` natively, and ships proper `.deb` packages. If you have a Mac and a
CI pipeline, **use that one** — it is faster and more complete.

This port makes the opposite trade. It takes a **stock** iOS Node build and
adapts at runtime, so the entire port is a set of JavaScript shims, one
byte-level binary patch, and three small edits to DSH itself. **Anyone can
reproduce it with a jailbroken phone and an SSH connection** — no build toolchain
on your computer at all. The one piece of native code, the optional image
accelerator, is compiled by the `clang` that is already *on the phone*.

That constraint is the whole design:

| | This port | Cross-compiled port |
|---|---|---|
| Build toolchain | **none** for the install — and for the native accelerator, a compiler *on the phone* (`clang` from the jailbreak), never a Mac | macOS + Xcode (+ CI) |
| JIT | no (`--jitless`) | **yes** |
| Node | stock `iphoneos-arm64` build | custom build, V8 W^X patch |
| `node-pty` | macOS prebuild, one byte rewritten | compiled for iOS |
| ICU / Unicode regex | depends on the build | small-icu, `\p{...}` works |
| Images (`sharp`) | **pure-JS codec (works)** | shim (stated unavailable) |
| Delivery | scripts | `.deb` packages |

The two are complementary, not competing. Notes for anyone wanting to combine
them are in [`docs/ios-constraints.md`](docs/ios-constraints.md).

---

## What works

| Capability | Status |
|---|---|
| Web UI in Safari (workspaces, sessions, multi-turn, trajectory view) | ✅ |
| Live DeepSeek API, streaming SSE | ✅ |
| `bash` — real command execution | ✅ |
| `read` / `write` / `edit` | ✅ |
| `glob` / `grep` | ✅ pure-JS ripgrep, called in-process |
| **Image attachments — upload and read** | ✅ **`sharp` replacement: pure JS, plus an optional native accelerator (45–80× on decode/resize/PNG encode)** |
| Session persistence (`jsonl.zstd`) | ✅ |
| Subagents, workflows, goals, todos, web search | ✅ |

## What does not

| Limitation | Why |
|---|---|
| No JIT | `--jitless`; expect an order of magnitude more CPU per unit of work |
| No WebAssembly | stubbed out; libraries built on wasm will not run |
| Sandboxing / FFI subprocess | `koffi` has no iOS build; stubbed |
| `worker_threads` | unavailable under the flags this build needs |
| Native npm addons | need an iOS build; the two DSH requires are handled specially |

---

## Pitfalls this port exists to document

These cost the most time and are the least written down elsewhere. Each one is
expanded — with the commands to observe it and the wrong turns taken — in
[`docs/ios-constraints.md`](docs/ios-constraints.md) and
[`docs/jbroot-namespaces.md`](docs/jbroot-namespaces.md). **Read this table
before debugging anything on this platform.**

### Filesystem

| Pitfall | What actually happens |
|---|---|
| **`/var/mobile` means two different things** | A jailbreak shell resolves it *inside* jbroot; Node — a stock binary with no rootHide interposition — resolves it to the **real** root. Both are correct; they disagree. Absolute `/var/mobile/...` paths handed to Node therefore resolve to a directory that does not contain your files. **`cd` first and pass relative paths.** This one alone caused failures in `--import`, module resolution, config paths and UI behaviour, and was misdiagnosed as a sandbox problem for days. |
| **Native `.node` modules must live inside jbroot** | The same file, same signature, loads from jbroot and fails from the real `/var/mobile/Documents` with `file system sandbox blocked mmap()`. Adding `no-sandbox` to the entitlements does **not** help — the restriction is on the process, not the request. This is why the install cannot be placed somewhere that survives an un-jailbreak. |
| **A symlinked addon directory does not work** | `prebuilds/ios-arm64 → darwin-arm64` is followed by the loader, which then refuses the macOS file anyway. It has to be a real copy. |
| **`ENOENT` from `spawn` does not mean spawning is blocked** | It means **the path does not exist in this process's view**. The real `/bin` contains `df` and `ps`, nothing else — every jailbreak binary is under jbroot. `child_process` works fine once `PATH` points at real paths. This errno was misread as a sandbox denial and led to an entire wrong architecture for a while. |
| **`exec`ing a *script* is unreliable** | Spawning a binary works. Spawning a script whose `#!/…` interpreter the kernel must resolve did not — not as a shell path, not as Node's realpath, not via `#!/usr/bin/env node` with `node` on `PATH`. The kernel's view and the process's view cannot both be satisfied. **If the answer involves exec'ing a script, look for an in-process answer.** |
| **No `gzip`** | `tar` is present, `gzip` is not. `tar -xzf` fails with `gzip: cannot exec`. Decompress with Node's `zlib`. |

### Process management

| Pitfall | What actually happens |
|---|---|
| **`pkill -f` silently does nothing** | It returns success and kills nothing. A stale server keeps the port and the next launch dies with `EADDRINUSE`, having *appeared* to start. Use a pidfile; use `killall node` as a deliberately indiscriminate last resort; test a port by trying to bind it, since there is no `lsof`, `ss`, `netstat` or even `ps`. |
| **`su` is the BSD one** | No `-c`. Root SSH login was refused by default. |

### DSH behaviour that is easy to misread

| Pitfall | What actually happens |
|---|---|
| **Disabling `shell-env` breaks session creation** | The `standard` agent preset declares a `tool-bash` row that injects `shellEnv`. With `shell-env` off the preset cannot mount, so session creation fails — and the workspace picker just quietly reverts, with **nothing in the server log**. Profile boot does not catch it because presets mount lazily. |
| **Disabling a row can silently remove a service** | The boot audit *skips* disabled entries, so `subprocess` vanished without complaint and later dependents hung. |
| **Errors are swallowed** | The picker's handler threw and something caught the rejection: no log line, no on-screen message. [`tools/diag-overlay.js`](tools/diag-overlay.js) exists because of this — it found the real cause in one page load after several rounds of guessing. **Build the instrument before forming the hypothesis.** |
| **The request-image cache ignores the pixel budget** | Raising the budget has no effect on an image already sent once; the old, smaller encoding is reused. Clear `dsh-home/attachments/v1/request-images/`. Very easy to read as "the change didn't work". |
| **The cache version marker does not cover everything** | It was bumped for the WebP→PNG fix and still does not cover the budget change. Do not assume a config change invalidates anything. |

### Runtime

| Pitfall | What actually happens |
|---|---|
| **No JIT, and therefore no WebAssembly** | Undici — Node's `fetch` — compiles its HTTP parser from WebAssembly *at import*, so `fetch` cannot be loaded at all. |
| **Assigning `globalThis.fetch` loads undici** | The global is a lazy getter; the read-before-write is what triggers the import and the crash. Define the property instead. On the device tested, both preloads in order were needed. |
| **Ripgrep cannot be spawned, and its package does not exist** | `ripgrep-ios-arm64` is never published, and the `darwin-arm64` build links `libiconv.2.dylib`. Replaced with a pure-JS implementation called **in-process**. |
| **`sharp` has no path to working on iOS** | No iOS libvips. Replaced with a pure-JS codec — and this is the one capability a cross-compiled port reports as unavailable. |
| **A self-test can pass while the output is malformed** | Our own decoder ignored the JPEG `SOF0` segment length, so it read back the encoder's own bug without complaint while the API rejected every file. **Check produced bytes against the spec, not against your own reader.** [`fixtures/verify-image-codec.mjs`](fixtures/verify-image-codec.mjs) does this. |

---

## How the hard parts are solved

Everything below is load-bearing; the reasoning and the things that did *not*
work are in [`docs/ios-constraints.md`](docs/ios-constraints.md).

### V8 without JIT, and `fetch`

`--jitless` means no WebAssembly, and Node's `fetch` is undici, whose HTTP
parser is a WebAssembly module compiled **at import**. So `fetch` cannot be
loaded at all.

Two preloads, in order:

1. **`preload/wasm-polyfill.js`** — supplies a `WebAssembly` global so undici can
   finish importing.
2. **`preload/fetch-https-shim.js`** — replaces `globalThis.fetch` with an
   implementation over `node:http`/`node:https`, using the native parser.

Both are needed. Note the shim installs via `Object.defineProperty`, not
assignment — `globalThis.fetch = …` triggers Node's lazy getter, which loads
undici, which is the crash.

### Images: a `sharp` replacement — pure JS, with an optional native fast path

There is no iOS libvips, so `sharp` cannot work. `sharp-ios/` is a from-scratch
replacement for the subset DSH uses:

```
exif.cjs     EXIF orientation
png.cjs      PNG decode + encode (zlib, de-filtering, CRC)
jpeg.cjs     JPEG decode (Huffman; baseline, extended-sequential,
             progressive; restart intervals) and encode
resize.cjs   resampling
sharp.cjs    the chainable sharp-shaped entry point
```

Five files, no dependencies beyond `node:fs` and `node:zlib`, and fully
self-contained. It is installed as an *overlay*: `npm install sharp` provides
the package, and the file that matters — `dist/index.cjs` — is redirected:

```js
// Package entry (CommonJS). Pure-JS implementation; see ./ios/sharp.cjs.
module.exports = require('./ios/sharp.cjs');
```

Verified by blind test: an image with randomly generated content was read back
correctly — the exact string, the shape, and both colours. Colour reporting
matters as evidence here, because a text-based representation cannot carry
colour, so the model must have received the actual image.

**Then the interpreter turned out to be the bottleneck.** Under `--jitless`
nothing is ever compiled, so a 1254×1254 screenshot took about 21 seconds to
decode, resize and re-encode. `sharp-ios/native/` is a ~180-line C addon that
takes over exactly those three steps — and it is **compiled on the phone**, by
the jailbreak's own clang, with no Mac involved:

| Step | pure JS | native | |
|---|---|---|---|
| decode | 2,910 ms | **65 ms** | 44.8× |
| resize | 6,921 ms | **86 ms** | 80.5× |
| PNG encode | 11,298 ms | **262 ms** | 43.1× |

Correctness was the whole problem, not speed:

* the C resampler is a **bit-exact port of `resize.cjs`**, because any other
  kernel shifts edges — stb's own filters were tried and rejected for that reason;
* PNG decode is byte-identical, and JPEG decode differs only by JPEG's own
  rounding (measured: max ±2 per channel, 0.8% of pixels);
* native PNG output is **larger** than the JS encoder's — same pixels, worse
  compression (+34% on the test image). That is the one real cost.

It is an optimisation, never a dependency. `sharp.cjs` falls back to pure JS
whenever the addon is missing, unsigned, unloadable, or disabled with
`DSH_NATIVE_CODEC=0` — so a device without a compiler is simply a device that
runs the slower path. Details, including the two platform traps in building it
(`TMPDIR`, and no `gzip` to unpack the headers), are in
[`sharp-ios/native/README.md`](sharp-ios/native/README.md).

### `glob` / `grep` without ripgrep

`dsh-tool-fs-search` resolves `@vscode/ripgrep-<platform>-<arch>` and spawns it.
`ripgrep-ios-arm64` is never published, and the `darwin-arm64` build links
`/usr/lib/libiconv.2.dylib`, which iOS does not have.

`rg-ios/` is a pure-JS implementation of the two invocation shapes the plugin
actually uses — `--files` for glob and `--json` for grep, in ripgrep's documented
JSON schema — so the existing parser is untouched. It is called **in-process**
rather than spawned: spawning a script here is unreliable, because the kernel
resolves the shebang against a different filesystem view than the process that
created it (see the namespace doc).

### `node-pty`: one byte

The shipped macOS prebuild is refused by dyld with `have 'macOS', need 'iOS'` —
decided by the `LC_BUILD_VERSION` `platform` field, not by signature or
architecture. `tools/patch-macho-ios.mjs` rewrites that single byte (`1` → `2`)
and re-signs with `ldid`. No compilation, bit-exact, trivially reversible.

### The filesystem namespace

The single biggest source of lost time, and the one least documented elsewhere:
**the shell and Node disagree about what `/var/mobile` means.** Covered in full,
with the commands to observe it, in
[`docs/jbroot-namespaces.md`](docs/jbroot-namespaces.md).

Two consequences worth repeating up front:

* pass **relative** paths to Node, after `cd`-ing; do not pass `/var/mobile/...`
* native `.node` modules **must live inside jbroot** — iOS's sandbox blocks
  `mmap()` of executable code from the real `/var/mobile/Documents`

### The iOS keyboard, and the visual viewport

Mobile Safari does not shrink the *layout* viewport when the keyboard opens. It
keeps it at full height and pans the **visual** viewport instead — so an app that
sizes its shell against the layout viewport puts the composer below the band you
can actually see. Measured on the device this targets: the composer was off
screen by up to **186 px on every backspace**.

`preload/keyboard-inset.js` publishes `visualViewport.height` and `.offsetTop` as
custom properties, plus a `data-dsh-vv` attribute, and
`preload/keyboard-inset.css` sizes the shell from them. The CSS uses a `transform`
on `body` on purpose: any non-`none` transform makes that element the containing
block for `position: fixed` descendants, so a shell that would otherwise size
against the viewport starts sizing against the body box instead.

The same layer stops the composer's toolbar buttons from raising the keyboard, by
intercepting `mousedown` in the capture phase: the app wires `keepFocus` (which
re-focuses the editor) onto commands, attach, stop and send, which on a phone
means tapping *attach* pops the keyboard up. The `click` event is left alone, so
the buttons still work.

Two approaches were tried and reverted, and are worth not re-deriving:
`html { overflow: hidden }` stops the layout viewport shrinking and pushes iOS
into panning instead, and `position: relative; top` participates in layout, so iOS
re-pans and the two undo each other — a 142 px oscillation.

This one is version-coupled in a small way: the button interception matches
`[class*="composerSeat"]`, so if the web frontend renames that class the
interception silently stops applying. The viewport part is unaffected.

---

## Layout

```
install.sh                  idempotent installer
sharp-ios/                  image codec: pure-JS implementation, plus an
                            optional native accelerator (native/)
rg-ios/                     pure-JS ripgrep replacement
preload/                    runtime shims (WebAssembly, fetch), browser
                            polyfills, and the iOS keyboard layer
shims/                      native-module stand-ins: koffi, win32-process, flock
patched/                    the three modified DSH files + what changed and why
tools/                      Mach-O patcher, browser diagnostic overlay
scripts/                    start / stop / per-fix installers
docs/                       the two long-form design notes
```

---

## Known gaps

* **`no User-Agent` may be rejected.** `node:http` sends none, and some API
  gateways treat a UA-less call as a bot. The cross-compiled port reports
  `401 governor` responses fixed by adding `user-agent: node` to its fetch
  shim. **This port's shim does not do that.** If you hit unexplained 401s on
  calls that work elsewhere, that is the first thing to try.
* **The request-image cache ignores the pixel budget.** Changing
  `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` does not affect images already sent once;
  clear `dsh-home/attachments/v1/request-images/`.
* **No `npm` CLI in most jailbreak Node packages** — you may need to copy
  `node_modules` from a development machine.
* Raising the image budget roughly doubles image token cost. It is a trade.

## Credits

Standing on:

* **The jailbreak.** Everything here is downstream of it. This port exists only
  because it is possible to run an unsandboxed binary on a device you own, and
  that is the work of people who gave their time to make it so:
  * **[Relaxin](https://github.com/owngoal-dev/Relaxin)** (MIT) — the jailbreak
    this was built and verified against (iOS 17.1.1). The repository holds the
    reference sources.
  * **[roothide Bootstrap](https://github.com/roothide/Bootstrap)** (MIT) — the
    `roothide` bootstrap for iOS 15–17. It provides the jbroot mechanism that
    [`docs/jbroot-namespaces.md`](docs/jbroot-namespaces.md) spends 200 lines
    untangling. Every note in this repo about paths, `mmap` and `dlopen` is a
    consequence of that design — and it is a design that holds up once
    understood. Its [developer documentation](https://github.com/roothide/Developer)
    is worth reading before writing anything that has to survive a re-jailbreak.
  * **[Dopamine](https://github.com/opa334/Dopamine)** (opa334) and the rootless
    lineage it established — the approach most of the ecosystem now builds on,
    including the roothide work above.
  * **[Procursus](https://github.com/ProcursusTeam/Procursus)** — the bootstrap
    userland supplying the `ldid`, `tar` and `zsh` this installer depends on.

  None of this is a small thing to have done, and none of it is paid for.
* [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — MIT
* [Cordis](https://github.com/cordiverse/cordis) — the plugin framework DSH is built on
* **[`j0shua-SYSON/node-ios`](https://github.com/j0shua-SYSON/node-ios)** (MIT) —
  without this there is no port. It describes itself as *"the first public
  Node >=20 build for iOS"*, and it is the Node this port ran on for most of its
  life. Its release notes recommend `--jitless`, and for that build the advice was
  correct: V8 could not JIT on iOS. This port has since built its own Node and
  fixed that — see [`node-ios/`](node-ios/) — so `--jitless` is no longer needed
  and the binary now comes from this repository's own release. Credited all the
  same, and still the reason any of this exists.
  Pinned by checksum in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
* The **cross-compiled iOS port** ([`ddddddedcds/deepseek-harness-ios`](https://github.com/ddddddedcds/deepseek-harness-ios),
  branch `ios-port`, and its companion [`Node.js-for-ios`](https://github.com/ddddddedcds/Node.js-for-ios)).
  Its `docs/ios-port.md` is the most useful single document on this problem, and
  several of the notes in `docs/ios-constraints.md` exist because of it. This
  port takes the opposite approach to building Node, but the diagnosis of what
  iOS forbids overlaps heavily and is owed to that work.
* [`everettjf/dsh-ios`](https://github.com/everettjf/dsh-ios) — a different and
  equally valid strategy: run DSH inside an iSH-emulated Linux on the device.
  GPL-3.0; **no code from it is used here.**

## License

MIT — see [`LICENSE`](LICENSE). Third-party components and their terms are
listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
