#!/bin/sh
# Cross-compile Node.js for jailbroken iOS (arm64) and package the result.
#
# Runs on a macOS machine or runner with Xcode. (No Mac is needed to *use* the
# binary; this is only the build side, and it is here because the alternative --
# trusting a third-party binary -- is what this port kept running into. Of the
# four published iOS Node builds, the only one with a clear licence has an
# intermittent SIGABRT unless the launcher remembers four flags, the newest one
# ships no licence and a broken JIT, and the most-starred one is older than the
# Node version this project requires.)
#
#   NODE_VERSION=24.21.0 sh node-ios/build-node-ios.sh
#
# Produces, in dist/:
#   node-v<VERSION>-iphoneos-arm64          the binary, signed with node-ios/entitlements.plist
#   node-v<VERSION>-iphoneos-arm64.sha256   its checksum
#   entitlements.plist                      a copy of the entitlements it was signed with
#   build.log                               the full build output
#
# The two fixes in patches/ are what make this build different from the published
# recipes; both are described at length in the patch files themselves. In short:
# 02 makes V8's wasm decisions agree instead of requiring the launcher to pass
# --wasm-enforce-bounds-checks, and 03 maps the code space twice instead of
# flipping protection on one mapping, so JIT no longer needs --predictable
# --single-threaded and no longer aborts.
set -eu

NODE_VERSION="${NODE_VERSION:-24.21.0}"
IOS_MIN="${IOS_MIN:-15.0}"
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
CACHE="${CACHE_DIR:-$HOME/node-ios-cache}"
# The tree is deliberately NOT under CACHE: only the tarball and ccache are worth
# caching, and a cached tree would be deleted and re-extracted anyway (see below).
# The tarball extracts as node-v<VERSION>, so SRC is exactly that directory.
WORK="${SRC_DIR:-${RUNNER_TEMP:-/tmp}}"
SRC="$WORK/node-v$NODE_VERSION"
SHIM="$HERE/ios-sdk-shim"
DIST="$REPO/dist"
LOG="$CACHE/build.log"

say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------- 1. source
say "== [1/6] source: Node v$NODE_VERSION"
mkdir -p "$CACHE" "$DIST"
TARBALL="$CACHE/node-v$NODE_VERSION.tar.gz"
if [ ! -f "$TARBALL" ]; then
  curl -fsSL -o "$TARBALL" \
    "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION.tar.gz"
fi
# Always extract a pristine tree. The patches are anchor-checked and fail loudly
# if an anchor is missing, so re-applying a *changed* patch over an already
# patched tree would abort the build rather than do something quiet and wrong.
rm -rf "$SRC"
mkdir -p "$WORK"
tar xzf "$TARBALL" -C "$WORK"
[ -d "$SRC" ] || { say "   expected $SRC after extracting the tarball"; exit 1; }
say "   $(wc -c < "$TARBALL" | tr -d ' ') bytes, extracted to $SRC"

# ---------------------------------------------------------------- 2. patches
say "== [2/6] iOS patches"
python3 "$HERE/patches/01-ios-base.py" "$SRC"
python3 "$HERE/patches/02-fix-trap-handler.py" "$SRC"
python3 "$HERE/patches/03-fix-wx-alias.py" "$SRC"

# ---------------------------------------------------------------- 3. configure
say "== [3/6] configure for iphoneos-arm64, min iOS $IOS_MIN"
cd "$SRC"
SDK=$(xcrun --sdk iphoneos --show-sdk-path)
say "   SDK $(xcrun --sdk iphoneos --show-sdk-version) at $SDK"
export IPHONEOS_DEPLOYMENT_TARGET="$IOS_MIN"
export CCACHE_DIR="${CCACHE_DIR:-$HOME/.ccache}"
export CCACHE_MAXSIZE=4G
export CCACHE_SLOPPINESS=time_macros
# -I$SHIM supplies mach/mach_vm.h; the iOS SDK ships it as an unsupported stub,
# and the dual mapping needs mach_vm_remap / mach_vm_protect declared.
export CC="ccache clang -arch arm64 -isysroot $SDK -miphoneos-version-min=$IOS_MIN -I$SHIM"
export CXX="ccache clang++ -std=gnu++20 -arch arm64 -isysroot $SDK -miphoneos-version-min=$IOS_MIN -I$SHIM"
export CC_host="ccache clang"
export CXX_host="ccache clang++ -std=gnu++20"
export LDFLAGS="-arch arm64 -isysroot $SDK -miphoneos-version-min=$IOS_MIN"
export GYP_DEFINES="target_arch=arm64 host_arch=arm64 host_os=mac target_os=ios"
# --with-intl=small-icu is not optional: DSH's plugin chain uses Unicode property
# escapes (\p{...}) in hundreds of places and they throw without ICU data.
# --without-node-snapshot avoids running mksnapshot, which is a cross-compile
# complication and a large memory consumer for no benefit here.
python3 configure \
  --dest-os=ios --dest-cpu=arm64 --cross-compiling \
  --with-intl=small-icu --without-npm \
  --without-node-snapshot --without-node-code-cache --without-inspector \
  --openssl-no-asm

# ---------------------------------------------------------------- 4. build
say "== [4/6] build (make -j2)"
# -j2 on purpose. The patches touch build_config.h, which every V8 translation
# unit includes, so a first build is a full rebuild; three concurrent cold -O3
# V8 compiles have OOM-killed the 3-core runner with a silent SIGKILL and no
# clang diagnostic at all.
if ! make -j2 > "$LOG" 2>&1; then
  say "   BUILD FAILED. Errors:"
  grep -nE "error:|fatal error|Error [0-9]|ld: |Undefined symbols|clang: error" "$LOG" \
    | grep -viE "no newline|Wnewline-eof|#warning|_GLIBCXX" | tail -60
  say "   full log: $LOG"
  exit 1
fi
grep -cE "warning:" "$LOG" | sed 's/^/   warnings: /'
ls -l out/Release/node | sed 's/^/   /'

# ---------------------------------------------------------------- 5. sign
say "== [5/6] verify and sign"
NAME="node-v$NODE_VERSION-iphoneos-arm64"
OUT="$DIST/$NAME"
cp out/Release/node "$OUT"
chmod 755 "$OUT"
file "$OUT"
# Guard against ever shipping a macOS binary by mistake.
if ! otool -l "$OUT" | grep -A5 "LC_BUILD_VERSION" | grep -q "platform IOS"; then
  say "   REFUSING: the binary does not declare platform IOS"
  otool -l "$OUT" | grep -A5 "LC_BUILD_VERSION" | sed 's/^/     /'
  exit 1
fi
ldid -S"$HERE/entitlements.plist" "$OUT"
# Verify rather than assume: ldid can fail after having written the file, and an
# unsigned binary at the deploy path is a SIGKILL, not an error message.
ldid -e "$OUT" | grep -q dynamic-codesigning \
  || { say "   REFUSING: signing did not take"; exit 1; }
cp "$HERE/entitlements.plist" "$DIST/entitlements.plist"
cp "$LOG" "$DIST/build.log"

# ---------------------------------------------------------------- 6. checksum
say "== [6/6] checksum"
cd "$DIST"
shasum -a 256 "$NAME" > "$NAME.sha256"
cat "$NAME.sha256"
say ""
ls -l "$DIST" | sed 's/^/   /'
say ""
say "done. Install with: ldid -S<entitlements> <binary>  (already signed here)"
