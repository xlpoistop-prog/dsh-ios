#!/var/jb/usr/bin/zsh
# Install the late-ES API shim into the served frontend and restart dsh web.
#
# The shim is copied next to index.html and referenced with a classic script tag
# placed before the module entry, so it has run by the time any bundle touches
# AbortSignal.any or the other late APIs.
#
# Idempotent: a marker check prevents duplicate insertions (an earlier script
# inserted twice because it ran both the BSD and GNU sed forms).

DSH_DIR=/var/mobile/Documents/dsh
FRONTEND="$DSH_DIR/node_modules/@deepseek-ai/dsh-web-frontend/dist"
HTML="$FRONTEND/index.html"
PORT="${1:-3081}"

echo "=== installing late-ES shim into $FRONTEND ==="

if [ ! -f "$DSH_DIR/es-late-polyfill.js" ]; then
  echo "ERROR: $DSH_DIR/es-late-polyfill.js is missing"
  exit 1
fi
if [ ! -f "$HTML" ]; then
  echo "ERROR: $HTML is missing"
  exit 1
fi

cp "$DSH_DIR/es-late-polyfill.js" "$FRONTEND/es-late-polyfill.js"
echo "copied shim"

# Strip any previous copies of this tag, then insert exactly one before the
# first module script. Doing the delete first makes the operation idempotent no
# matter how many times it has run.
grep -v 'es-late-polyfill' "$HTML" > "$HTML.tmp"
sed -e 's#<script type="module"#<script src="./es-late-polyfill.js"></script>\n    <script type="module"#' "$HTML.tmp" > "$HTML"
rm -f "$HTML.tmp"

echo "--- resulting head ---"
head -16 "$HTML"
echo "--- shim references in index.html (expect 1) ---"
grep -c 'es-late-polyfill' "$HTML"

echo
echo "=== restarting dsh web on port $PORT ==="
pkill -f 'bin.js web' 2>/dev/null
sleep 3

cd /var/mobile/Documents/ios-test || exit 1
./start-and-url.sh "$PORT"
