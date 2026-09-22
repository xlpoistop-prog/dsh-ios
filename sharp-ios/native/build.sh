#!/usr/bin/env sh
#
# build.sh — compile the native image accelerator, on the device.
#
#   sh build.sh [output.node]
#
# Everything happens on the phone: the jailbreak's own clang is the compiler
# (Procursus clang 14 on the device this was written for) and the Node headers
# are unpacked beside this script. There is no cross-compilation step and no Mac
# anywhere in it — which is the point, because the other iOS port's native code
# needs Xcode and a CI pipeline.
#
#   NODE_INC=<dir>            use headers from here, skip the download
#   NODE_HEADERS_VERSION=vX   which headers to fetch   (default below)
#   CC=clang                  compiler to use
#
# The default output is ../imgaddon.node, which is where install.sh looks for it
# and where sharp.cjs requires it. The codec falls back to pure JS whenever the
# addon is absent, unsigned, or fails to load, so a failed build here costs
# nothing but the speed-up.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
OUT="${1:-$HERE/../imgaddon.node}"
SRC="$HERE/imgaddon.c"
NODE_HEADERS_VERSION="${NODE_HEADERS_VERSION:-v22.23.2}"

[ -f "$SRC" ] || { echo "error: $SRC is missing" >&2; exit 1; }

say() { printf '   %s\n' "$*"; }

# ---------------------------------------------------------------------------
# temp directory
#
# clang has no usable default here. With TMPDIR unset it dies immediately with
# "unable to make temporary file: No such file or directory", because Darwin's
# default temp directory (_CS_DARWIN_USER_TEMP_DIR) does not exist on iOS. /tmp
# does, and one line here is the difference between a working compiler and a
# confusing error that says nothing about temp directories.
# ---------------------------------------------------------------------------
if [ -z "${TMPDIR:-}" ] || [ ! -d "${TMPDIR:-}" ]; then
  TMPDIR=/tmp
  export TMPDIR
fi
say "tmpdir:   $TMPDIR"

# ---------------------------------------------------------------------------
# compiler
# ---------------------------------------------------------------------------
CC="${CC:-clang}"
command -v "$CC" >/dev/null 2>&1 || {
  echo "error: no '$CC' on PATH." >&2
  echo "   The jailbreak bootstrap ships one (Procursus clang, /usr/bin/clang);" >&2
  echo "   install 'clang' from Sileo if it is missing, or set CC=<path>." >&2
  exit 1
}

# ---------------------------------------------------------------------------
# headers
#
# There is no gzip on this platform — tar -xzf fails with "gzip: cannot exec" —
# so a .tar.gz has to be inflated first. Node is the one decompressor guaranteed
# to be here, since installing Node is the whole point of this repository. It is
# usually not on PATH in a non-interactive shell, so look where it actually is:
# this script lives in <install>/sharp-ios/native, so ../../node is the binary.
# ---------------------------------------------------------------------------
node_bin() {
  if [ -n "${NODE:-}" ] && [ -x "${NODE}" ]; then printf '%s' "$NODE"; return 0; fi
  if [ -x "$HERE/../../node" ]; then printf '%s' "$HERE/../../node"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  return 1
}

gunzip_to() {  # gunzip_to <in.tar.gz> <out.tar>
  if command -v gzip >/dev/null 2>&1; then
    gzip -dc "$1" > "$2"
  elif NODE_BIN="$(node_bin)"; then
    "$NODE_BIN" --jitless -e 'const z=require("node:zlib"),f=require("node:fs");f.writeFileSync(process.argv[1],z.gunzipSync(f.readFileSync(process.argv[2])))' "$2" "$1"
  else
    echo "error: no gzip and no node to inflate $1" >&2
    echo "   Pass NODE=<path to the node binary>, or set NODE_INC=<dir>" >&2
    return 1
  fi
}

INC="${NODE_INC:-}"
if [ -z "$INC" ]; then
  for d in "$HERE"/inc/node-*/include/node; do
    [ -f "$d/node_api.h" ] && INC="$d"
  done
fi

if [ -z "$INC" ]; then
  TARBALL="$HERE/node-$NODE_HEADERS_VERSION-headers.tar.gz"
  PLAIN="$HERE/node-$NODE_HEADERS_VERSION-headers.tar"
  if [ ! -f "$TARBALL" ]; then
    URL="https://nodejs.org/dist/$NODE_HEADERS_VERSION/node-$NODE_HEADERS_VERSION-headers.tar.gz"
    say "headers:  fetching $NODE_HEADERS_VERSION"
    if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 -o "$TARBALL" "$URL"
    elif command -v wget >/dev/null 2>&1; then wget -O "$TARBALL" "$URL"
    else
      echo "error: need curl or wget for the Node headers." >&2
      echo "   Or copy an include/node directory here and set NODE_INC=<dir>" >&2
      exit 1
    fi
  fi
  say "headers:  inflating (no gzip on this platform; node does it)"
  gunzip_to "$TARBALL" "$PLAIN"
  mkdir -p "$HERE/inc"
  tar -xf "$PLAIN" -C "$HERE/inc"
  rm -f "$PLAIN"
  for d in "$HERE"/inc/node-*/include/node; do
    [ -f "$d/node_api.h" ] && INC="$d"
  done
fi

[ -n "$INC" ] && [ -f "$INC/node_api.h" ] || {
  echo "error: no node_api.h found. Pass NODE_INC=<dir containing node_api.h>" >&2
  exit 1
}
say "headers:  $INC"

# ---------------------------------------------------------------------------
# compile
#
# -shared plus -undefined dynamic_lookup is how Node addons link everywhere
# else: the N-API symbols are resolved by the host process at dlopen time, so
# nothing here links against libnode.
# ---------------------------------------------------------------------------
say "compiling $SRC"
"$CC" -shared -undefined dynamic_lookup -fPIC -O2 -I"$INC" -o "$OUT" "$SRC"

# ---------------------------------------------------------------------------
# sign
#
# iOS will not map unsigned executable code, and this addon has to live inside
# jbroot for the same reason every other native module does — see
# ../docs/jbroot-namespaces.md. install.sh signs the prebuilt copy the same way.
# ---------------------------------------------------------------------------
if command -v ldid >/dev/null 2>&1; then
  ldid -S "$OUT" && say "signed:   ldid -S"
else
  echo "   warning: no ldid on PATH — iOS may refuse to map this addon." >&2
  echo "            It will fall back to pure JS rather than crash." >&2
fi

ls -l "$OUT"
say "done. install.sh picks this up from ../imgaddon.node"
