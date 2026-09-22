#!/usr/bin/zsh
#
# DSH on iOS — one-command launcher.
#
#   sh /var/mobile/Documents/dsh-ios/start.sh [port]
#
# Everything it needs already lives next to it in dsh-ios (node, the DSH tree,
# the two preloads, the patch overlay). This script only handles the parts that
# are easy to get wrong on this device:
#
#   * jbroot paths — the shell resolves /var/mobile/... inside jbroot, but the
#     node process has no roothide interposition and sees the real filesystem.
#     So: cd into the shell-visible directory and pass *relative* paths to node.
#     Absolute /var/mobile/... arguments reach node as paths that do not exist.
#
#   * no ps, no pkill, no curl on this device. Process management is the pidfile
#     plus killall, and readiness is polled from the log.
#
#   * --jitless is mandatory (V8 codegen faults on iOS), which is why the
#     WebAssembly polyfill is imported before anything else can need it.
#
#   * glob/grep no longer spawn a helper: the tool calls a JS ripgrep
#     implementation in-process, so no PATH/shebang concerns apply to it.

set -u

# Where the install lives, not where this file lives.
#
# The repo keeps this under scripts/, but everything it needs — node, the DSH
# tree, the preloads — is at the install root, and every caller (bootstrap.sh,
# install.sh, both READMEs) invokes it as `sh scripts/start.sh`. Taking dirname
# literally therefore looked for <install>/scripts/node, which does not exist, so
# a fresh install died on its last step. If this file sits in a scripts/
# directory, the root is its parent.
HERE="$(cd "$(dirname "$0")" && pwd)"
case "$(basename "$HERE")" in
  scripts) BASE="$(cd "$HERE/.." && pwd)" ;;
  *)       BASE="$HERE" ;;
esac
PORT="${1:-3080}"

# DSH_SAFE=1 keeps this from killing unrelated node processes. By default the
# kill is indiscriminate on purpose: an orphan holding the port has no pidfile
# and there is no ps/lsof on this device to find it, so `killall node` is the
# only reliable way out of EADDRINUSE. Use `DSH_SAFE=1 sh start.sh` when
# something else is running under node that must survive.
SAFE="${DSH_SAFE:-0}"

JB="$(jbroot 2>/dev/null)"
if [ -z "$JB" ]; then
  echo "ERROR: cannot determine jbroot — is the jailbreak active?"
  exit 1
fi

NODE="$BASE/node"
if [ ! -x "$NODE" ]; then
  echo "ERROR: $NODE is missing or not executable"
  exit 1
fi

ENTRY="$BASE/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [ ! -f "$ENTRY" ]; then
  echo "ERROR: $ENTRY is missing — the DSH tree is not installed"
  exit 1
fi

cd "$BASE" || exit 1

# Relative on purpose: node resolves these against its own (real) cwd.
export NODE_OPTIONS=--jitless
export DSH_HOME=./dsh-home
export DSH_PERMISSION_MODE=danger-full-access
# jbroot's bin directories carry the jailbreak's userland (tar, sed, ...).
export PATH="${JB}usr/bin:${JB}bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
mkdir -p dsh-home

# --- stop whatever is already running -------------------------------------
if [ -f server.pid ]; then
  OLD="$(cat server.pid 2>/dev/null)"
  if [ -n "$OLD" ]; then
    kill -9 "$OLD" 2>/dev/null && echo "stopped previous instance (pid $OLD)"
  fi
  rm -f server.pid
fi

# Ask node whether the port is actually free. This is the only port probe
# available here — no lsof, no ss, no netstat.
port_busy() {
  ./node --jitless -e "
    const net = require('node:net')
    const server = net.createServer()
    server.once('error', () => { console.log('busy'); process.exit(0) })
    server.once('listening', () => { server.close(); console.log('free') })
    server.listen($PORT, '127.0.0.1')
  " 2>/dev/null | tail -1
}

if [ "$SAFE" = "1" ]; then
  if [ "$(port_busy)" = "busy" ]; then
    echo "ERROR: port $PORT is in use and DSH_SAFE=1 forbids killing other node"
    echo "       processes. Stop it yourself, or run without DSH_SAFE to force."
    exit 1
  fi
else
  if killall -9 node 2>/dev/null; then
    echo "killed node process(es) (indiscriminate; DSH_SAFE=1 to disable)"
    sleep 2
  fi
fi

rm -f server.log

# The two preloads and the patch overlay live in subdirectories of this repo
# (preload/, and inside the DSH tree), while a hand-assembled install tends to
# have copies of everything at the root — which is what the device this was
# written for actually has. Accept either, or a fresh install dies on its last
# step looking for ./wasm-polyfill.js, which the repo never puts there.
first_of() {  # first_of <path...>
  for _p in "$@"; do
    if [ -e "$_p" ]; then printf '%s' "$_p"; return 0; fi
  done
  return 1
}

WASM="$(first_of ./preload/wasm-polyfill.js ./wasm-polyfill.js)" || {
  echo "ERROR: wasm-polyfill.js not found (looked in ./preload and ./)"; exit 1; }
SHIM="$(first_of ./preload/fetch-https-shim.js ./fetch-https-shim.js)" || {
  echo "ERROR: fetch-https-shim.js not found (looked in ./preload and ./)"; exit 1; }
PATCH="$(first_of ./dsh/ios.patch.yml ./ios.patch.yml)" || PATCH=""

echo "jbroot:    $JB"
echo "base:      $BASE"
echo "workspace: $BASE/workspace"
echo "preloads:  $WASM  +  $SHIM"
if [ -n "$PATCH" ]; then echo "patch:     $PATCH"; else echo "patch:     none found"; fi
echo "starting dsh web on port $PORT"

# Relative paths on purpose: node resolves them against its own (real) cwd.
if [ -n "$PATCH" ]; then
  nohup ./node --expose-internals \
    --import "$WASM" --import "$SHIM" \
    ./dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web \
    --patch "$PATCH" --no-open \
    --host 127.0.0.1 --port "$PORT" </dev/zero >server.log 2>&1 &
else
  nohup ./node --expose-internals \
    --import "$WASM" --import "$SHIM" \
    ./dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web \
    --no-open \
    --host 127.0.0.1 --port "$PORT" </dev/zero >server.log 2>&1 &
fi
echo $! > server.pid
PID="$(cat server.pid)"

# Poll for the startup banner. Loading the plugin tree takes a while under
# --jitless, so allow a generous window rather than declaring failure early.
i=0
while [ "$i" -lt 60 ]; do
  sleep 3
  i=$((i + 1))

  URL="$(grep -o "http://127.0.0.1:${PORT}/?token=[A-Za-z0-9_-]*" server.log 2>/dev/null | head -1)"
  if [ -n "$URL" ]; then
    # Also drop it where the Files app can reach it.
    echo "$URL" > /rootfs/var/mobile/Documents/dsh-url.txt 2>/dev/null
    echo ""
    echo "=== open this in Safari ==="
    echo "$URL"
    echo ""
    echo "(also written to /var/mobile/Documents/dsh-url.txt)"
    exit 0
  fi

  # kill -0 is the portable liveness check here — there is no ps.
  if ! kill -0 "$PID" 2>/dev/null; then
    echo ""
    echo "ERROR: dsh exited during startup. Log tail:"
    echo "-------------------------------------------"
    tail -30 server.log
    exit 1
  fi
done

echo ""
echo "TIMEOUT: no banner after 180s. Log tail:"
echo "-------------------------------------------"
tail -30 server.log
exit 1
