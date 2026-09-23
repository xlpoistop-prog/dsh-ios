#!/usr/bin/env sh
#
# dsh-ios installer — adapts an existing DSH tree to run on a jailbroken iOS
# device with a stock Node build.
#
#   sh install.sh [--dry-run] [--dsh-tree <path>] [--all-backups]
#
# Idempotent: running it twice is the same as running it once. Everything it
# overwrites is backed up first (*.dsh-ios.bak) unless it is already a backup.
#
# It does NOT download anything and does NOT need network access. Get Node and
# the DSH tree in place first; see docs/install-from-scratch.md.
#
# Two device facts drive the shape of this script:
#   * there is no ps / pkill / lsof here, and no gzip
#   * the shell and Node disagree about what /var/mobile means  (see
#     docs/jbroot-namespaces.md) — so the script does its own path handling and
#     never asks Node to resolve an absolute /var/mobile path

set -eu

# The device's coreutils are localised -- a `cp` failure here came back in
# Chinese, which is hard to match against this script. Error text is what ends
# up in bug reports, so pin it to one language.
LC_ALL=C
export LC_ALL

# --jitless is mandatory on this platform, and its absence does not produce a
# useful error: V8's code generator faults on iOS and the process dies with
# SIGBUS, so the shell prints only "Bus error: 10". start.sh exports this for the
# server; install.sh calls node itself (the Mach-O patcher) and did not, which is
# why step 6 failed with no explanation at all.
case " ${NODE_OPTIONS:-} " in
  *" --jitless "*) : ;;
  *) NODE_OPTIONS="${NODE_OPTIONS:-} --jitless"; export NODE_OPTIONS ;;
esac

# ---------------------------------------------------------------------------
# arguments
# ---------------------------------------------------------------------------
DRY_RUN=0
DSH_TREE="${DSH_TREE:-}"
ALL_BACKUPS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     DRY_RUN=1 ;;
    --dsh-tree)    shift; DSH_TREE="$1" ;;
    --all-backups) ALL_BACKUPS=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

HERE="$(cd "$(dirname "$0")" && pwd)"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
run()  {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------
step "preflight"

[ "$(uname -s)" = "Darwin" ] || die "this installer is for iOS/Darwin"

# A non-interactive SSH session gets /usr/bin:/bin:/usr/sbin:/sbin from sshd and
# nothing else, and on a jailbroken device node is normally not installed
# system-wide -- it sits next to this script. Accept it from either place, so
# that `ssh phone 'cd ... && sh install.sh'` works as well as typing it in a
# terminal whose profile already put it on PATH.
if ! command -v node >/dev/null 2>&1 && [ -x "$HERE/node" ]; then
  PATH="$HERE:$PATH"; export PATH
fi
command -v node >/dev/null 2>&1 || die "node not found on PATH, and no ./node next to $0"
NODE_BIN="$(command -v node)"
NODE_VERSION="$(node --version 2>/dev/null || echo unknown)"
say "   node      $NODE_BIN ($NODE_VERSION)"

case "$NODE_VERSION" in
  v2[2-9].*|v[3-9][0-9].*) : ;;
  *) say "   note: DSH requires Node ^22.19.0 || >=24. Found $NODE_VERSION." ;;
esac

# ldignore: ldid is only needed if we have to patch a Mach-O (§ node-pty).
HAVE_LDID=0
if command -v ldid >/dev/null 2>&1; then
  HAVE_LDID=1
  say "   ldid      $(command -v ldid)"
else
  say "   ldid      NOT FOUND — Mach-O re-signing will be skipped"
fi

# Locate the DSH tree. The only reliable marker is the CLI entry point; a bare
# "node_modules" directory could belong to anything.
find_dsh_tree() {
  for candidate in \
      "${DSH_TREE:-}" \
      "$HERE/dsh" \
      "$HERE/../dsh" \
      "$PWD" \
      "$PWD/dsh" \
      "/var/mobile/Documents/dsh-ios/dsh" \
      "/var/mobile/Documents/dsh" ; do
    [ -n "$candidate" ] || continue
    if [ -f "$candidate/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
      (cd "$candidate" && pwd) && return 0
    fi
  done
  return 1
}

DSH_TREE="$(find_dsh_tree)" || die "could not find a DSH tree.
   Pass one explicitly:  sh install.sh --dsh-tree /path/to/tree
   A DSH tree is a directory containing
     node_modules/@deepseek-ai/dsh/lib/bin.js"

NM="$DSH_TREE/node_modules"
say "   dsh tree  $DSH_TREE"
[ -d "$NM/@deepseek-ai" ] || die "no @deepseek-ai packages under $NM"

FRONTEND="$NM/@deepseek-ai/dsh-web-frontend/dist"
BACKUP_SUFFIX="dsh-ios.bak"

# Back up once; never overwrite an existing backup with a newer modified file,
# or a second run would destroy the pristine copy.
#
# These variables are named per function on purpose. POSIX sh has no `local`
# here, so every assignment is global: a plain `src` in backup() overwrote the
# caller's `src`, and install_file then copied the destination onto itself --
# "cp: 'X' and 'X' are the same file", which is how this was found.
backup() {
  _bak_src="$1"
  [ -e "$_bak_src" ] || return 0
  [ -e "$_bak_src.$BACKUP_SUFFIX" ] && { say "   backup exists: $(basename "$_bak_src")"; return 0; }
  run cp -p "$_bak_src" "$_bak_src.$BACKUP_SUFFIX"
  say "   backed up  $(basename "$_bak_src")"
}

install_file() {
  _ins_src="$1"; _ins_dst="$2"
  [ -f "$_ins_src" ] || { say "   MISSING SOURCE: $_ins_src"; return 1; }
  run mkdir -p "$(dirname "$_ins_dst")"
  backup "$_ins_dst"
  run cp -p "$_ins_src" "$_ins_dst"
  say "   installed  $_ins_dst"
}

# ---------------------------------------------------------------------------
step "1/7  native-module shims"

# koffi and win32-process throw during import; they cannot be configured away.
# flock ships a prebuilt that will not dlopen here. The base classes DSH
# actually needs are pure JS, so inert stand-ins keep every service registered.
install_file "$HERE/shims/koffi.js" \
             "$NM/koffi/src/koffi/index.js"
install_file "$HERE/shims/win32-process.js" \
             "$NM/@deepseek-ai/dsh-win32-process/lib/index.js"
install_file "$HERE/shims/flock-stub.js" \
             "$NM/@deepseek-ai/node-addon-system/lib/flock.js"

# ---------------------------------------------------------------------------
step "2/7  pure-JS image codec  (overlay into sharp)"

SHARP="$NM/sharp"
if [ ! -d "$SHARP" ]; then
  say "   sharp is not installed — skipping."
  say "   install it first:  npm install sharp"
else
  install_file "$HERE/sharp-ios/exif.cjs"   "$SHARP/dist/ios/exif.cjs"
  install_file "$HERE/sharp-ios/png.cjs"    "$SHARP/dist/ios/png.cjs"
  install_file "$HERE/sharp-ios/jpeg.cjs"   "$SHARP/dist/ios/jpeg.cjs"
  install_file "$HERE/sharp-ios/resize.cjs" "$SHARP/dist/ios/resize.cjs"
  install_file "$HERE/sharp-ios/sharp.cjs"  "$SHARP/dist/ios/sharp.cjs"
  install_file "$HERE/sharp-ios/IOS-PURE-JS.md" "$SHARP/dist/ios/IOS-PURE-JS.md"

  # The native accelerator. sharp.cjs requires it from its own directory and
  # falls back to pure JS whenever it is absent, unsigned, or fails to load — so
  # this is an optimisation, never a dependency, and a missing file here is not
  # an error. The prebuilt copy in this repo was produced by
  # sharp-ios/native/build.sh, which can equally be run on the device to build it
  # from source.
  if [ -f "$HERE/sharp-ios/imgaddon.node" ]; then
    install_file "$HERE/sharp-ios/imgaddon.node" "$SHARP/dist/ios/imgaddon.node"
    # iOS will not map unsigned executable code — the same reason every other
    # native module here is re-signed, and the same reason they must live inside
    # jbroot.
    if [ "$HAVE_LDID" != "1" ]; then
      say "   warning: no ldid — imgaddon.node stays unsigned and will be ignored"
    elif [ "$DRY_RUN" = "1" ]; then
      say "   [dry-run] ldid -S $SHARP/dist/ios/imgaddon.node"
    else
      ldid -S "$SHARP/dist/ios/imgaddon.node" \
        || say "   warning: ldid failed on imgaddon.node — the codec will use pure JS"
    fi
  else
    say "   no imgaddon.node in the repo — the codec runs in pure JS"
  fi

  # The one file that makes the overlay take effect.
  install_file "$HERE/sharp-ios/index.cjs"  "$SHARP/dist/index.cjs"
fi

# ---------------------------------------------------------------------------
step "3/7  pure-JS ripgrep replacement"

RG="$NM/@vscode/ripgrep-ios-arm64"
install_file "$HERE/rg-ios/package.json"    "$RG/package.json"
install_file "$HERE/rg-ios/rg-impl.mjs"     "$RG/bin/rg-impl.mjs"
# bin/rg exists so that `@vscode/ripgrep`'s resolver succeeds, but the patched
# dsh-tool-fs-search calls rg-impl.mjs directly and never execs this.
install_file "$HERE/rg-ios/rg-launcher.tmpl" "$RG/bin/rg"
run chmod 755 "$RG/bin/rg" 2>/dev/null || true

# ---------------------------------------------------------------------------
step "4/7  patched DSH files"

install_file "$HERE/patched/dsh-tool-fs-search.lib.index.js" \
             "$NM/@deepseek-ai/dsh-tool-fs-search/lib/index.js"
install_file "$HERE/patched/dsh-attachment-local.lib.index.js" \
             "$NM/@deepseek-ai/dsh-attachment-local/lib/index.js"
install_file "$HERE/patched/dsh-llm-deepseek.lib.index.js" \
             "$NM/@deepseek-ai/dsh-llm-deepseek/lib/index.js"

# ---------------------------------------------------------------------------
step "5/7  profile overlay"

install_file "$HERE/scripts/ios.patch.yml" "$DSH_TREE/ios.patch.yml"
say "   note: this overlay disables tool-pwsh ONLY."
say "         Do not disable shell-env (breaks agent presets) or tool-bash"
say "         (silently drops the subprocess service). See docs/ios-constraints.md §15."

# ---------------------------------------------------------------------------
step "6/7  native addon platform byte  (node-pty, node-addon-system)"

# dyld refuses these with \"have 'macOS', need 'iOS'\" because of the
# LC_BUILD_VERSION platform field. One byte, in place, then re-sign.
# A path Node can actually open.
#
# The shell resolves /var/mobile inside jbroot; Node — a stock binary with no
# rootHide interposition — resolves it against the real root, and on iOS a path
# it cannot find does not produce a clean ENOENT: the process dies with SIGBUS and
# prints nothing at all. The shell reports only "Bus error: 10", which says
# nothing about paths.
#
# That is exactly what happened here: the Mach-O patcher was handed
# /var/mobile/... and crashed, so step 6 failed on every install.
#
# `pwd -P` comes back as /rootfs/private/var/..., which is the form Node wants
# once the /rootfs prefix is dropped. On a rootless jailbreak there is no /rootfs
# and this is simply the path itself.
real_for_node() {  # real_for_node <absolute path in the shell's view>
  ( cd "$(dirname "$1")" 2>/dev/null &&
    printf '%s/%s' "$(pwd -P | sed 's|^/rootfs||')" "$(basename "$1")" )
}

patch_macho() {
  _pm_target="$1"
  [ -f "$_pm_target" ] || { say "   not present: $_pm_target"; return 0; }

  if [ "$DRY_RUN" = "1" ]; then
    say "   [dry-run] patch + sign $_pm_target"
    return 0
  fi

  "$NODE_BIN" "$(real_for_node "$HERE/tools/patch-macho-ios.mjs")" "$(real_for_node "$_pm_target")" || {
    say "   patch failed: $_pm_target"; return 1; }

  # The patcher rewrote the platform slot, which invalidates the code signature —
  # that is expected, and dyld will refuse the file until this re-signs it.

  if [ "$HAVE_LDID" = "1" ]; then
    ldid -S "$_pm_target" 2>/dev/null || ldid -S"$HERE/scripts/entitlements.plist" "$_pm_target" 2>/dev/null \
      || say "   warning: ldid failed on $_pm_target"
  fi
}
patch_macho "$NM/node-pty/prebuilds/darwin-arm64/pty.node"
patch_macho "$NM/node-pty/prebuilds/ios-arm64/pty.node"
patch_macho "$NM/@deepseek-ai/node-addon-system/prebuilds/ios-arm64/system.node"

# A symlinked addon directory does not work: require follows it and dlopens the
# macOS file, which is refused for the reason above. It has to be a real copy.
PTY_PRE="$NM/node-pty/prebuilds"
if [ -d "$PTY_PRE/ios-arm64" ] && [ ! -d "$PTY_PRE/ios-arm64.real" ]; then
  if [ -L "$PTY_PRE/ios-arm64" ]; then
    say "   replacing symlinked ios-arm64 with a real copy"
    run rm -f "$PTY_PRE/ios-arm64"
    run cp -R "$PTY_PRE/darwin-arm64" "$PTY_PRE/ios-arm64"
    patch_macho "$PTY_PRE/ios-arm64/pty.node"
  fi
fi

# ---------------------------------------------------------------------------
step "7/7  browser polyfills"

if [ ! -d "$FRONTEND" ]; then
  say "   frontend dist not found — skipping ($FRONTEND)"
else
  install_file "$HERE/preload/iterator-polyfill.js" "$FRONTEND/iterator-polyfill.js"
  install_file "$HERE/preload/es-late-polyfill.js"  "$FRONTEND/es-late-polyfill.js"
  if [ -f "$HERE/preload/settings-mobile.css" ]; then
    install_file "$HERE/preload/settings-mobile.css" "$FRONTEND/settings-mobile.css"
  fi
  # The keyboard layer. Mobile Safari keeps the layout viewport at full height
  # when the keyboard opens, so the composer ends up below the visible band; this
  # binds the shell to the visual viewport instead. Both files are needed — the
  # JS publishes the custom properties the CSS consumes.
  if [ -f "$HERE/preload/keyboard-inset.js" ]; then
    install_file "$HERE/preload/keyboard-inset.js"  "$FRONTEND/keyboard-inset.js"
    install_file "$HERE/preload/keyboard-inset.css" "$FRONTEND/keyboard-inset.css"
  fi

  # Inject them ahead of the module bundle. Idempotent: strip any previous
  # injection before adding it back, which is what makes a second run safe.
  if [ -f "$FRONTEND/index.html" ]; then
    backup "$FRONTEND/index.html"
    if [ "$DRY_RUN" = "1" ]; then
      say "   [dry-run] inject polyfill <script> tags into index.html"
    else
      tmp="$FRONTEND/index.html.dsh-ios.tmp"
      grep -v 'iterator-polyfill\|es-late-polyfill\|settings-mobile.css\|keyboard-inset' \
        "$FRONTEND/index.html" > "$tmp"
      sed -e 's#<script type="module"#<script src="./iterator-polyfill.js"></script>\n    <script src="./es-late-polyfill.js"></script>\n    <script src="./keyboard-inset.js"></script>\n    <script type="module"#' \
          -e 's#</head>#  <link rel="stylesheet" href="./settings-mobile.css">\n    <link rel="stylesheet" href="./keyboard-inset.css">\n  </head>#' \
          "$tmp" > "$FRONTEND/index.html"
      rm -f "$tmp"
      say "   injected   $(grep -c 'iterator-polyfill\.js\|es-late-polyfill\.js\|keyboard-inset\.js' "$FRONTEND/index.html") script(s), $(grep -c 'settings-mobile\.css\|keyboard-inset\.css' "$FRONTEND/index.html") stylesheet(s)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "done"

if [ "$DRY_RUN" = "1" ]; then
  say "Dry run only. Nothing was changed."
  exit 0
fi

cat <<EOF

Next: restart DSH so the new modules are loaded.

    sh $(printf '%s' "$HERE")/scripts/start.sh

The running process holds the old modules in memory; copying files over a live
install changes nothing until it restarts.

If image or session behaviour looks stale, clear the request-image cache —
it is not invalidated by the pixel-budget change:

    rm -rf "$DSH_TREE/../dsh-home/attachments/v1/request-images"

Roll back with the *.${BACKUP_SUFFIX} copies next to each replaced file.
EOF
