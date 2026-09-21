#!/var/jb/usr/bin/zsh
# Make the dsh dependency tree loadable on iOS, then launch dsh web.
#
# Everything below exists because one of these holds on this device:
#   * `process.platform` is 'ios', so any dependency that resolves a path or a
#     package name from the platform string looks for an iOS build.
#   * Koffi publishes no iOS prebuild, and several packages touch it at module
#     evaluation time.
#   * Sharp publishes no iOS prebuild.
#
# All edits are idempotent: originals are copied to <file>.orig exactly once.
# Relative paths throughout, because under roothide the shell and Node resolve
# absolute /var/mobile paths through different namespaces.

DSH_DIR=/var/mobile/Documents/dsh
NODE=/var/mobile/Documents/node22/node

cd "$DSH_DIR" || { echo "cannot cd to $DSH_DIR"; exit 1; }

install_stub() {
  stub="$1"; target="$2"; label="$3"
  [ -f "$stub" ]   || { echo "ERROR: stub missing: $stub"; return 1 }
  [ -f "$target" ] || { echo "ERROR: target missing: $target"; return 1 }
  [ -f "${target}.orig" ] || cp "$target" "${target}.orig"
  cp "$stub" "$target"
  echo "  stubbed $label"
}

echo "=== installing iOS stubs ==="
install_stub ./koffi-ios-stub.js         ./node_modules/koffi/src/koffi/index.js                   "koffi"
install_stub ./win32-process-ios-stub.js ./node_modules/@deepseek-ai/dsh-win32-process/lib/index.js "dsh-win32-process"
# sharp's real entry points (from its package.json exports map): the ESM one is
# what attachment-local's static import resolves to, the CJS one covers
# require() callers, and dist/sharp.mjs is the implementation both re-export.
for entry in ./node_modules/sharp/dist/index.mjs ./node_modules/sharp/dist/index.cjs ./node_modules/sharp/dist/sharp.mjs; do
  [ -f "$entry" ] && install_stub ./sharp-ios-stub.js "$entry" "sharp ${entry##*/}"
done

# Point node-pty's platform-derived prebuild lookup at the darwin binaries.
# Its loader builds `prebuilds/${process.platform}-${process.arch}`, which is
# `prebuilds/ios-arm64` here; the shipped darwin-arm64 payload links only
# libc++/libSystem, so an alias is enough.
PTY_PRE=./node_modules/node-pty/prebuilds
if [ -d "$PTY_PRE/darwin-arm64" ] && [ ! -e "$PTY_PRE/ios-arm64" ]; then
  ln -sfn darwin-arm64 "$PTY_PRE/ios-arm64"
  echo "  aliased node-pty prebuilds/ios-arm64 -> darwin-arm64"
fi

# @img/colour is pure JS (sharp's dependency) and must exist for sharp's other
# dist modules to resolve, even with the entry stubbed.
if [ ! -d ./node_modules/@img/colour ]; then
  mkdir -p ./node_modules/@img
  ( cd ./node_modules/@img && tar -xzf /var/mobile/Documents/ios-test/imgcolour.tgz && mv package colour ) \
    && echo "  installed @img/colour"
fi

echo
echo "=== module load checks ==="
check() {
  "$NODE" --jitless -e "import('$1').then(m=>console.log('  OK   $1  exports=',Object.keys(m).length)).catch(e=>console.log('  FAIL $1:',e.message))"
}
check koffi
check @deepseek-ai/dsh-win32-process
check sharp
check node-pty

echo
echo "=== launching dsh web ==="
export DSH_HOME=./dsh-home
export NODE_OPTIONS=--jitless
mkdir -p "$DSH_HOME"

# --expose-internals: the HMR service (cordis-plugin-hmr) refuses to construct
# without it, and the web profile's live-patch reload mounts that service.
exec "$NODE" --expose-internals --import ./wasm-polyfill.js \
  ./node_modules/@deepseek-ai/dsh/lib/bin.js web \
  --patch ./ios.patch.yml \
  --host 127.0.0.1 --port 3080
