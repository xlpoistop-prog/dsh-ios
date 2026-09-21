#!/var/jb/usr/bin/zsh
# Install the koffi iOS stub over the real koffi entry point.
#
# Path notes: everything here is relative to the app directory on purpose.
# Under roothide the shell and Node resolve absolute /var/mobile paths through
# different namespaces (Node reported an absolute --import path missing while
# the shell could read it), whereas a relative specifier resolves against the
# same base as the entry point. So the script cds into the app dir and works
# relatively from there.

NODE=/var/mobile/Documents/node22/node
DSH_DIR=/var/mobile/Documents/dsh

cd "$DSH_DIR" || { echo "cannot cd to $DSH_DIR"; exit 1; }

STUB=./koffi-ios-stub.js
TARGET=./node_modules/koffi/src/koffi/index.js

[ -f "$STUB" ] || { echo "stub missing at $STUB"; exit 1; }
[ -f "$TARGET" ] || { echo "koffi entry missing at $TARGET"; exit 1; }

# Keep one backup of the original entry, then install the stub.
[ -f "${TARGET}.orig" ] || cp "$TARGET" "${TARGET}.orig"
cp "$STUB" "$TARGET"

echo "installed stub over $TARGET"
echo "--- head of installed file ---"
head -5 "$TARGET"
echo "--- backup present ---"
ls -la "${TARGET}.orig"

# Load-check koffi by itself before booting the whole app.
echo "=== koffi load check ==="
"$NODE" --jitless -e "import('koffi').then(m=>console.log('KOFFI_STUB_OK exports=', Object.keys(m).length)).catch(e=>console.log('KOFFI_LOAD_FAIL', e.message))"
