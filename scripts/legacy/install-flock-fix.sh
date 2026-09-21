#!/var/jb/usr/bin/zsh
# Make dsh's session file-locking work on iOS.
#
# Two independent obstacles:
#
#  1. node-addon-system/lib/flock.js rejects any platform that is not linux or
#     darwin. iOS IS Darwin and flock(2) is a libSystem call available on the
#     device, so the guard is the only problem — hence flock-ios.js.
#
#  2. That module resolves @deepseek-ai/node-addon-system-darwin-arm64, whose
#     bin/system.node declares platform = macOS in LC_BUILD_VERSION. iOS's dyld
#     refuses to map a macOS Mach-O, so its platform field is rewritten to iOS
#     (a single byte) and the binary is re-signed.
#
# Idempotent: *.orig backups are written once, and the Mach-O rewriter reports
# "already iOS" on a second run.

DSH_DIR=/var/mobile/Documents/dsh
NODE=/var/mobile/Documents/node22/node
FIX=/var/mobile/Documents/ios-test/flock-ios.js
TARGET="$DSH_DIR/node_modules/@deepseek-ai/node-addon-system/lib/flock.js"
ADDON_DIR="$DSH_DIR/node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin"
ADDON="$ADDON_DIR/system.node"
PATCHER="$DSH_DIR/patch-macho-ios.mjs"

cd "$DSH_DIR" || exit 1

echo "=== 1. patched flock.js ==="
if [ ! -f "$FIX" ]; then
  echo "ERROR: $FIX missing"
  exit 1
fi
if [ ! -f "$TARGET" ]; then
  echo "ERROR: $TARGET missing"
  exit 1
fi
[ -f "$TARGET.orig" ] || cp "$TARGET" "$TARGET.orig"
cp "$FIX" "$TARGET"
echo "installed patched flock.js"

echo
echo "=== 2. darwin addon ==="
ls -la "$ADDON_DIR" 2>/dev/null
if [ ! -f "$ADDON" ]; then
  echo "ERROR: $ADDON missing"
  exit 1
fi
if [ ! -f "$PATCHER" ]; then
  echo "ERROR: $PATCHER missing; copy patch-macho-ios.mjs into $DSH_DIR"
  exit 1
fi

cp "$ADDON" "$ADDON.orig"
"$NODE" --jitless "$PATCHER" "$ADDON"
ldid -S "$ADDON"
echo "re-signed $ADDON"

echo
echo "=== 3. load check ==="
"$NODE" --jitless -e "import('@deepseek-ai/node-addon-system/flock').then(m=>console.log('FLOCK_MODULE_OK exports=',Object.keys(m).length)).catch(e=>console.log('FLOCK_LOAD_FAIL', e.message))"

"$NODE" --jitless -e "
import('node:fs').then(async fs=>{
  const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock');
  const fh = fs.openSync('/var/mobile/Documents/dsh/dsh-home/.flock-test','w');
  try { await tryLockExclusive(fh); console.log('FLOCK_ACQUIRE_OK'); }
  catch(e){ console.log('FLOCK_ACQUIRE_FAIL', e.code||e.message); }
  finally { fs.closeSync(fh); }
})"
