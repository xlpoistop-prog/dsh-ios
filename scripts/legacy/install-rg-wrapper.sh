#!/var/jb/usr/bin/zsh
# Install the JavaScript `rg` replacement and re-enable glob/grep.
#
# Background: dsh-tool-fs-search resolves `@vscode/ripgrep-<platform>-<arch>` at
# import time, which is `ripgrep-ios-arm64` here — never published. The npm
# darwin-arm64 build is a macOS Mach-O linking /usr/lib/libiconv.2.dylib, which
# iOS does not have. This creates the missing package wrapping a JavaScript
# implementation of the two shapes dsh uses (`--files` for glob, `--json` for
# grep), so its parser is unchanged.
#
# Files are copied from the payload rather than generated with heredocs, which
# is both easier to verify and avoids nested-heredoc quoting hazards.

DSH_DIR=/var/mobile/Documents/dsh
SRC=/var/mobile/Documents/ios-test
NODE=/var/mobile/Documents/node22/node
PKG="$DSH_DIR/node_modules/@vscode/ripgrep-ios-arm64"
PATCH="$DSH_DIR/ios.patch.yml"

cd "$DSH_DIR"
if [ $? -ne 0 ]; then echo "cannot cd to $DSH_DIR"; exit 1; fi

for f in rg-impl.mjs rg-launcher.tmpl rg-package.json ios.patch.yml; do
  if [ ! -f "$SRC/$f" ]; then echo "ERROR: missing $SRC/$f"; exit 1; fi
done

JB=$(jbroot 2>/dev/null)
if [ -z "$JB" ]; then echo "ERROR: cannot determine jbroot"; exit 1; fi
echo "jbroot: $JB"

echo "=== 1. create @vscode/ripgrep-ios-arm64 ==="
rm -rf "$PKG"
mkdir -p "$PKG/bin"
cp "$SRC/rg-package.json" "$PKG/package.json"
cp "$SRC/rg-impl.mjs" "$PKG/bin/rg-impl.mjs"

# The launcher runs under the bundled Node directly (no bash stub), so its
# shebang is the only absolute path and no substitution is needed.
cp "$SRC/rg-launcher.tmpl" "$PKG/bin/rg"
chmod 755 "$PKG/bin/rg"
ls -la "$PKG" "$PKG/bin"
head -1 "$PKG/bin/rg"

echo
echo "=== 2. does @vscode/ripgrep resolve it? ==="
"$NODE" --jitless -e "import('@vscode/ripgrep').then(m=>{const fs=require('node:fs');console.log('rgPath:',m.rgPath);console.log('exists:',fs.existsSync(m.rgPath))}).catch(e=>console.log('RESOLVE_FAIL',e.message))"

echo
echo "=== 3. does the launcher run? ==="
"$PKG/bin/rg" --files --hidden --no-ignore "$DSH_DIR/workspace" 2>&1 | head -5
echo "files_done"
"$PKG/bin/rg" --json --no-ignore 'node' "$DSH_DIR/package.json" 2>&1 | head -3

echo
echo "=== 4. enable tool-fs-search in the overlay ==="
cp "$SRC/ios.patch.yml" "$PATCH"
cat "$PATCH"

echo
echo "=== done: restart dsh web ==="
