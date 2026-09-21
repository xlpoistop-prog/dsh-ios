#!/var/jb/usr/bin/zsh
# Install the Iterator availability shim into the served frontend and restart.
#
# The frontend HTML loads its module entry directly, so the shim is inserted as
# a classic script before it. Classic scripts in <head> execute before deferred
# module scripts, which is what makes the helpers present by the time any
# client bundle runs its feature detection.
#
# Idempotent: the marker comment prevents a second insertion.

DSH_DIR=/var/mobile/Documents/dsh
FRONTEND="$DSH_DIR/node_modules/@deepseek-ai/dsh-web-frontend/dist"
HTML="$FRONTEND/index.html"

cd "$DSH_DIR" || exit 1

[ -f ./iterator-polyfill.js ] || { echo "ERROR: iterator-polyfill.js missing in $DSH_DIR"; exit 1 }
[ -f "$HTML" ] || { echo "ERROR: index.html missing at $HTML"; exit 1 }

cp ./iterator-polyfill.js "$FRONTEND/iterator-polyfill.js"
echo "installed shim at $FRONTEND/iterator-polyfill.js"

if grep -q 'iterator-polyfill' "$HTML"; then
  echo "index.html already references the shim"
else
  cp "$HTML" "$HTML.orig"
  # Insert before the first module script tag.
  sed -i '' -e 's#<script type="module"#<script src="./iterator-polyfill.js"></script>\n    <script type="module"#' "$HTML" 2>/dev/null \
    || sed -i -e 's#<script type="module"#<script src="./iterator-polyfill.js"></script>\n    <script type="module"#' "$HTML"
  echo "patched $HTML"
fi

echo
echo "=== head of the served HTML ==="
head -16 "$HTML"

echo
echo "=== restarting dsh web ==="
pkill -f 'dsh/lib/bin.js web' 2>/dev/null
sleep 2
cd /var/mobile/Documents/ios-test || exit 1
./start-and-url.sh
