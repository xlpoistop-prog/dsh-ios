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
# The patches in patches/ are what make this build different from the published
# recipes; each is described at length in its own file. In short:
#   01 the base port: gyp/toolchain conditions so an iOS target is actually built
#      as iOS (see the GYP_DEFINES note below -- it needs OS=ios to take effect)
#   02 makes V8's wasm decisions agree instead of requiring the launcher to pass
#      --wasm-enforce-bounds-checks
#   04 implements V8's W^X write-protect hook for iOS, and 05 repairs a code page
#      on the fault. These replace an earlier approach (03, kept for the record)
#      that mapped the code space twice and claimed to remove the need for
#      --jitless; measurement showed the second mapping is incompatible with
#      V8's memory layout -- the heap writes page headers into pages that must
#      also be executable -- and the build still faulted.
#
# With 04+05, JIT runs: measured on the device, a 20M-iteration loop went from
# ~1060 ms (--jitless) to ~300 ms, and cold boot to first token from 45 s to 17 s.
# scripts/start.sh therefore no longer exports --jitless; DSH_JITLESS=1 restores it.
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
# Extract *over* whatever is there rather than wiping first. `out/` restored from
# the cache is the difference between a three-hour rebuild and a few minutes:
# tar restores the archive's own mtimes, so only the files the patches then touch
# end up newer than their object files, and make rebuilds exactly those.
#
# This does mean the patches run against a tree they may already have modified,
# so check for a leftover marker first and start over if one is there. The
# scripts are anchor-checked and would abort on a mismatch anyway, but a stale
# tree should not be the reason a build fails.
mkdir -p "$WORK"
tar xzf "$TARBALL" -C "$WORK"
[ -d "$SRC" ] || { say "   expected $SRC after extracting the tarball"; exit 1; }
if grep -q "V8_HAS_IOS_CODE_ALIAS" "$SRC/deps/v8/src/base/build_config.h" 2>/dev/null; then
  say "   a patch marker survived the overlay; rebuilding the tree from scratch"
  rm -rf "$SRC"
  tar xzf "$TARBALL" -C "$WORK"
fi
say "   $(wc -c < "$TARBALL" | tr -d ' ') bytes, extracted over $SRC"

# ---------------------------------------------------------------- 2. patches
say "== [2/6] iOS patches"
python3 "$HERE/patches/01-ios-base.py" "$SRC"
python3 "$HERE/patches/02-fix-trap-handler.py" "$SRC"
# 03 is deliberately NOT applied. Its double mapping is incompatible with V8's
# memory layout -- the heap writes page headers into pages that must also be
# executable -- and the resulting build still faults. It is kept in the tree for
# the record, not for use.
# python3 "$HERE/patches/03-fix-wx-alias.py" "$SRC"
python3 "$HERE/patches/04-ios-jit-wx-hook.py" "$SRC"
python3 "$HERE/patches/05-ios-jit-fault-repair.py" "$SRC"

# ---------------------------------------------------------------- 3. configure
say "== [3/6] configure for iphoneos-arm64, min iOS $IOS_MIN"
cd "$SRC"
SDK=$(xcrun --sdk iphoneos --show-sdk-path)
say "   SDK $(xcrun --sdk iphoneos --show-sdk-version) at $SDK"
# Deliberately NOT `export IPHONEOS_DEPLOYMENT_TARGET=$IOS_MIN`. clang selects an
# iOS target when that variable is in the environment, and gyp's host toolset
# inherits the environment -- so the macOS host objects get compiled as iOS. Node
# 22 tolerated that; Node 24 defines pthread_jit_write_protect_np behind a guard
# that is false for iOS but true for that host compile, and the result is
# "'pthread_jit_write_protect_np' is unavailable: not available on iOS" for a
# translation unit that was meant to be plain macOS. The minimum version is
# passed to the target compiles explicitly instead, where it belongs.
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
# host_arch has to describe the machine doing the build, not the target. Getting
# this wrong on an Intel runner (hardcoding arm64, as the reference workflow
# does for its arm64 runner) builds host tools for the wrong architecture.
case "$(uname -m)" in
  arm64) HOST_ARCH=arm64 ;;
  x86_64) HOST_ARCH=x64 ;;
  *) HOST_ARCH="$(uname -m)" ;;
esac
# OS=ios is not optional and it is not implied by --dest-os=ios: gyp also reads
# GYP_DEFINES from the environment, and the environment wins. Without it gyp
# evaluates OS as the *build host* -- "mac" here, "linux" on the Linux path --
# every OS=="ios" condition in node and v8 silently fails, and the build dies
# later with Linux headers pulled into the iOS target (deps/zlib's
# <asm/hwcap.h>, cares' <sys/random.h>) or links host tools against target
# symbols. This one word was the root cause of that entire error family, and it
# is why the iOS-only branches in patches 01 and 04 were dead code until it was
# added.
export GYP_DEFINES="OS=ios target_arch=arm64 host_arch=$HOST_ARCH host_os=${HOST_OS:-mac} target_os=ios"
say "   host arch: $HOST_ARCH"
# --with-intl=small-icu is not optional: DSH's plugin chain uses Unicode property
# escapes (\p{...}) in hundreds of places and they throw without ICU data.
# --without-node-snapshot avoids running mksnapshot, which is a cross-compile
# complication and a large memory consumer for no benefit here.
#
# Skipped when a configured tree came back from the cache. The one case that
# needs a fresh configure is a patch that changes a gyp file: the build files in
# out/ would then be stale. Bump CACHE_REV in the workflow when that happens.
if [ -f "$SRC/out/Release/Makefile" ]; then
  say "   reusing the configured tree restored from cache (out/Release exists)"
else
  python3 configure \
    --dest-os=ios --dest-cpu=arm64 --cross-compiling \
    --with-intl=small-icu --without-npm \
    --without-node-snapshot --without-node-code-cache --without-inspector \
    --openssl-no-asm
fi

# ---------------------------------------------------------------- 4. build
# Parallelism from the machine, not from a guess. The constraint is memory, not
# cores: a cold -O3 V8 translation unit peaks at roughly 2.5-3.5 GB, and the
# 3-core/7 GB standard macOS runner gets OOM-killed (silent SIGKILL, no clang
# diagnostic) at -j3. The Intel standard runner has twice the RAM, so it can
# take -j3 or -j4.
CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 2)
RAM_GB=$(echo "$(sysctl -n hw.memsize 2>/dev/null || echo 4294967296) / 1073741824" | bc)
BY_RAM=$(( RAM_GB / 3 ))          # ~3 GB per concurrent cold V8 TU
JOBS="${JOBS:-$(( CORES < BY_RAM ? CORES : BY_RAM ))}"
[ "$JOBS" -lt 2 ] && JOBS=2
[ "$JOBS" -gt 8 ] && JOBS=8
say "== [4/6] build (make -j$JOBS on $CORES cores / ${RAM_GB} GB)"
# Record the machine in the log itself. The log is the published artefact, and
# which machine produced a binary is part of what the binary is: the CPU model
# answers whether a given runner label is the free 4-core standard one or the
# billed 12-core "large" one, and the Xcode/SDK versions are what anyone
# re-running this needs to match.
{
  echo "== machine that built this"
  echo "   cpu:     $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -p)"
  echo "   arch:    $(uname -m)   cores: $CORES   ram: ${RAM_GB} GB"
  echo "   make -j: $JOBS"
  echo "   xcode:   $(xcodebuild -version 2>/dev/null | head -2 | tr '\n' ' ')"
  echo "   ios sdk: $(xcrun --sdk iphoneos --show-sdk-version 2>/dev/null) at $SDK"
  echo "   node:    v$NODE_VERSION   ios min: $IOS_MIN"
  echo
} > "$LOG"
if ! make -j"$JOBS" >> "$LOG" 2>&1; then
  say "   BUILD FAILED. Errors:"
  grep -nE "error:|fatal error|Error [0-9]|ld: |Undefined symbols|clang: error" "$LOG" \
    | grep -viE "no newline|Wnewline-eof|#warning|_GLIBCXX" | tail -60
  # copy the log before leaving, so a failing run still publishes something to
  # read -- without this the failure output exists only in the CI job's own log,
  # which cannot be fetched without a token.
  cp "$LOG" "$DIST/build.log" 2>/dev/null || true
  say "   full log: $LOG (also copied to $DIST/build.log)"
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
