# Legacy scripts — historical, do not run

These are the original per-fix installers, kept because their comments explain
*why* each step exists, not because they should be used.

**They are superseded by [`../../install.sh`](../../install.sh)**, which performs
all of the same steps idempotently and without hard-coded paths.

They also carry hard-coded paths from an earlier layout
(`/var/mobile/Documents/dsh/...`) and will write to the wrong place on any
current install. Read them; do not run them.

| Script | What it did | Now in `install.sh` as |
|---|---|---|
| `deploy-and-run.sh` | first one-shot deploy: shims, node-pty prebuild copy, launch | steps 1, 6 |
| `deploy-koffi-stub.sh` | install the `koffi` stand-in | step 1 |
| `install-flock-fix.sh` | two attempts at `flock`: guard patch, then stub | step 1 |
| `install-iterator-shim.sh` | inject `iterator-polyfill.js` into the frontend | step 7 |
| `install-late-shim.sh` | inject `es-late-polyfill.js` | step 7 |
| `install-rg-wrapper.sh` | create `@vscode/ripgrep-ios-arm64` | step 3 |

Worth reading in particular:

* **`install-flock-fix.sh`** — documents the two-stage failure honestly: the
  guard patch gets past the platform check, and the addon then still fails to
  `dlopen`. Its conclusion (stub it) is the one carried forward, and the reason
  is stated rather than glossed.
* **`deploy-and-run.sh`** — the original ordering of operations, before the
  jbroot namespace behaviour was understood. Comparing it with `install.sh`
  shows exactly which assumptions turned out to be wrong.
