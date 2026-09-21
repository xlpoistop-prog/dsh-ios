#!/usr/bin/env sh
#
# bootstrap.sh — get dsh-ios running on a jailbroken device, from a desktop,
# in one command.
#
#   ./bootstrap.sh --device mobile@127.0.0.1 --password <pw>
#
# install.sh adapts an existing Node + DSH install. This is the part before it:
# it checks what is already on the device, fetches whatever is missing, and
# then hands over. It does the fetching from the desktop on purpose — npm and
# the network are here, not there, and a 265 MB tree is much easier to build
# once and copy than to assemble on a phone.
#
# What it will NOT do, because it cannot: install the jailbreak, a terminal, or
# an SSH server. Those are manual and come first. See
# docs/install-from-scratch.md.
#
# Idempotent: anything already present is left alone. --dry-run prints the plan
# without touching the device.

set -eu

# ---------------------------------------------------------------------------
# defaults
# ---------------------------------------------------------------------------
DEVICE="mobile@127.0.0.1"
PORT=""
PASSWORD=""
KEYFILE=""
HOSTKEY=""
INSTALL_DIR="/var/mobile/Documents/dsh-ios"
NODE_URL="https://github.com/j0shua-SYSON/node-ios/releases/download/v22.19.0/node-v22.19.0-iphoneos-arm64"
NODE_SHA256="1f0975217902badb1919b6d6f5dfd9e1083e765f090766dab6d50f562044fbcc"
DSH_VERSION=""
SKIP_NODE=0
SKIP_DSH=0
SKIP_START=0
TRANSPORT=""
DRY_RUN=0
WORK=""

# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------
if [ -t 1 ]; then B=$(printf '\033[1m'); D=$(printf '\033[2m'); R=$(printf '\033[0m'); else B=; D=; R=; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s== %s%s\n' "$B" "$*" "$R"; }
note() { printf '%s   %s%s\n' "$D" "$*" "$R"; }
warn() { printf '   ! %s\n' "$*" >&2; }
die()  { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# arguments
# ---------------------------------------------------------------------------
usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --device USER@HOST      SSH target                (default mobile@127.0.0.1)
  --port N                SSH port
  --password PASS         Password for the phone's mobile account
                          (the one the jailbreak asked you to set);
                          otherwise SSH keys are used
  --key FILE              SSH private key
  --hostkey FINGERPRINT   Expected host key, e.g. SHA256:abc...
  --install-dir DIR       Phone install location   (default /var/mobile/Documents/dsh-ios)
  --dsh-version V         @deepseek-ai/dsh version  (default: latest)
  --node-url URL          Fetch Node from here instead
  --skip-node             Do not install Node
  --skip-dsh              Do not install the DSH tree
  --skip-start            Install but do not launch
  --transport T           Force 'putty' or 'openssh'
  --dry-run               Print the plan, change nothing
  -h, --help
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --device)       shift; DEVICE="$1" ;;
    --port)         shift; PORT="$1" ;;
    --password)     shift; PASSWORD="$1" ;;
    --key)          shift; KEYFILE="$1" ;;
    --hostkey)      shift; HOSTKEY="$1" ;;
    --install-dir)  shift; INSTALL_DIR="$1" ;;
    --dsh-version)  shift; DSH_VERSION="$1" ;;
    --node-url)     shift; NODE_URL="$1" ;;
    --skip-node)    SKIP_NODE=1 ;;
    --skip-dsh)     SKIP_DSH=1 ;;
    --skip-start)   SKIP_START=1 ;;
    --transport)    shift; TRANSPORT="$1" ;;
    --dry-run)      DRY_RUN=1 ;;
    -h|--help)      usage ;;
    *) die "unknown argument: $1  (try --help)" ;;
  esac
  shift
done

HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/install.sh" ] || die "install.sh not found next to $0 — run this from the repo checkout"

# ---------------------------------------------------------------------------
# transport
#
# Windows almost always has PuTTY rather than OpenSSH; Linux and macOS the
# reverse. Rather than require one, detect whichever is present.
# ---------------------------------------------------------------------------
step "transport"

RUN=""; PUT=""; MODE=""

# Windows ships OpenSSH but almost always lacks sshpass, so a password cannot be
# handed to `ssh` non-interactively. PuTTY's plink takes -pw directly, which is
# why it is preferred when present. It is frequently installed somewhere
# off-PATH, so look in the usual places rather than trusting PATH alone.
find_tool() {  # find_tool <name> [candidate paths...]
  _n="$1"; shift
  if command -v "$_n" >/dev/null 2>&1; then command -v "$_n"; return 0; fi
  for _p in "$@"; do
    [ -n "$_p" ] || continue
    if [ -x "$_p" ]; then printf '%s' "$_p"; return 0; fi
    if [ -x "$_p.exe" ]; then printf '%s' "$_p.exe"; return 0; fi
  done
  return 1
}

# Candidate directories, built from only the variables that are actually set.
# `set -u` is on and on Windows several of these do not exist, so a direct
# expansion would abort the script before it printed anything useful.
putty_candidates() {  # putty_candidates <toolname>
  _t="$1"
  _out=""
  for _b in "${TEMP:-}" "${TMPDIR:-}" "${USERPROFILE:-}" "${HOME:-}" \
            "/c/Program Files/PuTTY" "/c/Program Files (x86)/PuTTY"; do
    [ -n "$_b" ] || continue
    case "$_b" in
      */PuTTY) _out="$_out $_b/$_t" ;;
      *)       _out="$_out $_b/plink/$_t" ;;
    esac
  done
  printf '%s' "$_out"
}

if [ -z "$TRANSPORT" ] || [ "$TRANSPORT" = "putty" ]; then
  PLINK_BIN="$(find_tool plink "${PLINK:-}" $(putty_candidates plink) 2>/dev/null || true)"
  PSCP_BIN="$(find_tool pscp  "${PSCP:-}"  $(putty_candidates pscp)  2>/dev/null || true)"
  if [ -n "$PLINK_BIN" ] && [ -n "$PSCP_BIN" ]; then MODE="putty"; fi
fi

if [ -z "$MODE" ] && { [ -z "$TRANSPORT" ] || [ "$TRANSPORT" = "openssh" ]; }; then
  if command -v ssh >/dev/null 2>&1 && command -v scp >/dev/null 2>&1; then MODE="openssh"; fi
fi

if [ -z "$MODE" ]; then
  die "no usable SSH transport found.
   Install PuTTY (plink + pscp, which take a password directly), or OpenSSH, or
   point at the binaries explicitly:
     PLINK=/path/to/plink PSCP=/path/to/pscp $0 ..."
fi

if [ -n "$PASSWORD" ] && [ "$MODE" = "openssh" ] && ! command -v sshpass >/dev/null 2>&1; then
  die "only OpenSSH is available, sshpass is not installed, and --password was given.
   Windows OpenSSH cannot take a password non-interactively. Options:
     * install PuTTY and use plink/pscp      (recommended on Windows)
     * use an SSH key                        (--key ~/.ssh/id_ed25519)
     * install sshpass                       (Linux / macOS / WSL)"
fi

if [ "$MODE" = "putty" ]; then note "transport: putty ($PLINK_BIN)"; else note "transport: openssh"; fi

# Common options per transport.
#
# Built with `if` rather than `[ ... ] && printf`: under `set -e` a failing test
# at the end of a function makes the function return non-zero, and these are
# called from command substitutions where that is easy to miss.
putty_opts() {
  _o="-batch"
  if [ -n "$PASSWORD" ]; then _o="$_o -pw $PASSWORD"; fi
  if [ -n "$HOSTKEY" ];  then _o="$_o -hostkey $HOSTKEY"; fi
  if [ -n "$KEYFILE" ];  then _o="$_o -i $KEYFILE"; fi
  printf '%s' "$_o"
}

ssh_opts() {
  _o=""
  if [ -n "$PORT" ]; then _o="-p $PORT"; fi
  _o="$_o -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
  if [ -n "$KEYFILE" ]; then _o="$_o -i $KEYFILE"; fi
  printf '%s' "$_o"
}

ssh_cmd() {  # ssh_cmd "<remote command>"
  if [ -n "$PASSWORD" ]; then
    # shellcheck disable=SC2086
    sshpass -p "$PASSWORD" ssh $(ssh_opts) "$DEVICE" "$1"
  else
    # shellcheck disable=SC2086
    ssh $(ssh_opts) "$DEVICE" "$1"
  fi
}

plink_cmd() {  # plink_cmd "<remote command>"
  # shellcheck disable=SC2086
  "$PLINK_BIN" $(putty_opts) "$DEVICE" "$1"
}

# Run a command on the device. This goes through the device's own shell, so
# /var/mobile there means jbroot — see docs/jbroot-namespaces.md.
#
# Always executes, even under --dry-run: these are the read-only probes that
# decide what needs doing, and a dry run that cannot see the device state is
# useless. Use mutate() for anything that changes something.
dev() {
  if [ "$MODE" = "putty" ]; then plink_cmd "$1"; else ssh_cmd "$1"; fi
}

# Same, for the short value probes.
#
# plink announces the keyboard-interactive exchange on stderr for every single
# call -- two lines each time. Across a dozen probes that is most of the output,
# and it buries the lines that matter. stderr is dropped only here, and kept
# everywhere else, because a failing install.sh reports on stderr.
dev_q() {
  dev "$1" 2>/dev/null
}

# Run a command that changes something. Skipped under --dry-run.
mutate() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] device: %s\n' "$1"
    return 0
  fi
  dev "$1"
}

# Copy a file to the device.
#
# Targets a path under /rootfs on purpose. pscp and scp write to the *real*
# filesystem, while the device shell's /var/mobile is inside jbroot — so a
# transfer aimed at /var/mobile/... either fails or lands where the shell
# cannot see it. Staging under /rootfs and moving it from the shell with `cp`
# is the only sequence that works in both views.
push() {  # push <local> <dirname-under-/rootfs> [newname]
  _local="$1"; _dir="$2"; _name="${3:-$(basename "$1")}"
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] push %s → %s/%s\n' "$_local" "$_dir" "$_name"
    return 0
  fi
  if [ "$MODE" = "putty" ]; then
    # shellcheck disable=SC2086
    "$PSCP_BIN" $(putty_opts) "$_local" "$DEVICE:/rootfs$_dir/$_name"
  else
    # shellcheck disable=SC2086
    scp $(ssh_opts) "$_local" "$DEVICE:/rootfs$_dir/$_name"
  fi
}

STAGE="/var/mobile/Documents/.dsh-ios-stage"

# ---------------------------------------------------------------------------
# host key
#
# plink -batch refuses an unknown host outright -- "The host key is not cached
# for this server" -- and it does not cache a key that was supplied via
# -hostkey, so every call has to carry one. Its interactive prompt cannot be
# answered from piped stdin either (it wants a terminal), so the only workable
# approach is to read the fingerprint out of plink's own complaint and pin that
# for the rest of the run.
#
# This is trust-on-first-use, which is what ssh(1) does by default. Being
# explicit that the first connection is therefore unverified, the fingerprint is
# printed, and --hostkey exists for pinning one out of band.
#
# OpenSSH needs none of this; ssh_opts already passes accept-new.
# ---------------------------------------------------------------------------
if [ "$MODE" = "putty" ] && [ -z "$HOSTKEY" ]; then
  # -batch makes this fail fast (about half a second) instead of prompting.
  HOSTKEY="$( "$PLINK_BIN" -ssh -batch -pw "$PASSWORD" "$DEVICE" "exit" 2>&1 \
              | grep -o 'SHA256:[A-Za-z0-9+/=]*' | head -1 )"
  if [ -n "$HOSTKEY" ]; then
    note "host key: $HOSTKEY"
    note "  (learned on first contact; pin it with --hostkey to verify it)"
  fi
fi

# ---------------------------------------------------------------------------
# preflight
#
# The connection is the first thing that can fail and the one failure a reader is
# least equipped to diagnose, so it is probed first and reported explicitly --
# success included. Someone who already had SSH working should be able to see
# that the script noticed and moved on, rather than inferring it from silence.
# ---------------------------------------------------------------------------
step "connection"

# Capture the client's own words on failure. 'cannot reach' alone is not
# actionable -- 'Connection refused', 'host key is not cached' and 'access
# denied' have entirely different fixes, and plink says which one it is.
#
# The status has to be caught on the same line. Under `set -e`, a bare
# `VAR="$(failing command)"` terminates the script at the assignment, so
# `CONN_RC=$?` on the following line would never run and the diagnosis would
# never print.
#
# plink's keyboard-interactive announcement is filtered here as everywhere else,
# or it would bury the real message.
CONN_RC=0
CONN_OUT="$(dev "uname -s" 2>&1)" || CONN_RC=$?
CONN_OUT="$(printf '%s\n' "$CONN_OUT" | grep -v -e 'Keyboard-interactive')"

if [ "$CONN_RC" -ne 0 ]; then
  die "cannot reach $DEVICE.

   The SSH client said:

$(printf '%s\n' "$CONN_OUT" | sed 's/^/     /')

   This script requires an SSH connection to the phone that already works — it
   does not set one up. The usual causes, most common first:

     1. OpenSSH is not installed on the phone.
        Install openssh-server from Sileo. Every SSH client -- including
        i4Tools' 'open SSH channel' -- ends up talking to sshd *on the phone*;
        i4Tools only forwards the port. Its dialog reports success either way,
        so it is not evidence that anything is listening.

     2. The channel was opened before OpenSSH was installed.
        Re-open it now that sshd exists.

     3. Wrong address or password.
        --device is USER@HOST. Over i4Tools' USB channel that is
        mobile@127.0.0.1; over Wi-Fi it is the phone's IP. The password is the
        one the jailbreak asked you to set for the mobile account.

     4. The phone is not jailbroken, or the jailbreak is not active.

   Test the connection on its own first -- if this fails, nothing here will work:

     plink -ssh -pw <pw> mobile@127.0.0.1 \"echo ok\"
     ssh -o StrictHostKeyChecking=accept-new mobile@127.0.0.1 \"echo ok\""
fi

note "connected to $DEVICE — skipping straight to the install"

OS_NAME="$(dev 'uname -s' 2>/dev/null | tr -d '\r')"
[ "$OS_NAME" = "Darwin" ] || die "the phone reports uname -s = '$OS_NAME'; expected Darwin (iOS).
   You are probably connected to something that is not the phone."

JB="$(dev_q 'jbroot 2>/dev/null || echo NONE' | tr -d '\r')"
if [ "$JB" = "NONE" ] || [ -z "$JB" ]; then
  die "no jbroot on the phone — it does not look jailbroken, or the shell is not
   the jailbreak's. Note this checks the phone's shell, not the computer's."
fi
note "jbroot: $JB"

HAS_LDID="$(dev_q 'command -v ldid >/dev/null 2>&1 && echo yes || echo no' | tr -d '\r')"
if [ "$HAS_LDID" = "yes" ]; then
  note "ldid: present"
else
  warn "ldid missing — the native addons cannot be re-signed and the terminal will not load"
fi

HAS_TAR="$(dev_q 'command -v tar >/dev/null 2>&1 && echo yes || echo no' | tr -d '\r')"
[ "$HAS_TAR" = "yes" ] || die "no tar on the phone"

mutate "mkdir -p '$STAGE'" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 1. Node
# ---------------------------------------------------------------------------
step "1/4  Node"

NODE_OK="$(dev_q "[ -x '$INSTALL_DIR/node' ] && NODE_OPTIONS=--jitless '$INSTALL_DIR/node' --version 2>/dev/null || echo MISSING" | tr -d '\r')"

if [ "$SKIP_NODE" = "1" ]; then
  note "skipped (--skip-node)"
elif [ "$NODE_OK" != "MISSING" ] && [ -n "$NODE_OK" ]; then
  note "already installed: $NODE_OK"
else
  NODE_BIN="$(basename "$NODE_URL")"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT INT TERM

  say "   fetching $NODE_BIN"
  if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 -o "$WORK/$NODE_BIN" "$NODE_URL"
  elif command -v wget >/dev/null 2>&1; then wget -O "$WORK/$NODE_BIN" "$NODE_URL"
  else die "need curl or wget to fetch Node"; fi

  say "   verifying checksum"
  if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$WORK/$NODE_BIN" | cut -d' ' -f1)"
  elif command -v shasum  >/dev/null 2>&1; then GOT="$(shasum -a 256 "$WORK/$NODE_BIN" | cut -d' ' -f1)"
  else GOT=""; warn "no sha256sum/shasum available — skipping verification"; fi

  if [ -n "$GOT" ] && [ "$GOT" != "$NODE_SHA256" ]; then
    die "checksum mismatch for $NODE_BIN
     expected $NODE_SHA256
     got      $GOT
   Stop and check the source before continuing."
  fi
  if [ -n "$GOT" ]; then note "sha256 ok"; fi

  say "   pushing to phone"
  push "$WORK/$NODE_BIN" "/var/mobile/Documents" "$NODE_BIN"
  mutate "mkdir -p '$INSTALL_DIR' && cp '/rootfs/var/mobile/Documents/$NODE_BIN' '$INSTALL_DIR/node' && chmod 755 '$INSTALL_DIR/node'"

  VER="$(dev_q "NODE_OPTIONS=--jitless '$INSTALL_DIR/node' --version" | tr -d '\r')"
  case "$VER" in
    v2[2-9].*|v[3-9][0-9].*) note "installed: $VER" ;;
    *) die "Node installed but reports '$VER'; expected v22.x or newer" ;;
  esac
fi

# ---------------------------------------------------------------------------
# 2. DSH tree
# ---------------------------------------------------------------------------
step "2/4  DSH tree"

TREE_OK="$(dev_q "[ -f '$INSTALL_DIR/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' ] && echo yes || echo no" | tr -d '\r')"
# Also accept a tree that install.sh would find on its own.
if [ "$TREE_OK" = "no" ]; then
  TREE_OK="$(dev_q "[ -f '/var/mobile/Documents/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' ] && echo here || echo no" | tr -d '\r')"
fi

if [ "$SKIP_DSH" = "1" ]; then
  note "skipped (--skip-dsh)"
elif [ "$TREE_OK" != "no" ]; then
  note "already present"
else
  command -v npm >/dev/null 2>&1 || die "no npm on this machine, and the phone has no DSH tree.
   Install Node.js on the desktop (which brings npm), or copy a tree over by
   hand — see docs/install-from-scratch.md."

  [ -n "$WORK" ] || { WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT INT TERM; }

  say "   npm install @deepseek-ai/dsh${DSH_VERSION:+@$DSH_VERSION}"
  note "this is ~265 MB and takes a while; it is done here because the phone"
  note "has no npm and a much slower network"
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] npm install in %s\n' "$WORK/dsh-tree"
  else
    mkdir -p "$WORK/dsh-tree"
    ( cd "$WORK/dsh-tree" && npm install --no-audit --no-fund "@deepseek-ai/dsh${DSH_VERSION:+@$DSH_VERSION}" ) \
      || die "npm install failed"
  fi

  say "   packing"
  if [ "$DRY_RUN" != "1" ]; then
    ( cd "$WORK/dsh-tree" && tar -cf "$WORK/dsh-tree.tar" node_modules ) || die "tar failed"
  fi

  say "   pushing (~40 MB compressed, a few hundred MB unpacked)"
  push "$WORK/dsh-tree.tar" "/var/mobile/Documents" "dsh-tree.tar"
  # No gzip on the device, so the archive is plain tar and extracts with tar
  # alone. Verified on the target: `tar -xzf` fails with "gzip: cannot exec".
  mutate "mkdir -p '$INSTALL_DIR/dsh' && cd '$INSTALL_DIR/dsh' && tar -xf '/rootfs/var/mobile/Documents/dsh-tree.tar' && rm -f '/rootfs/var/mobile/Documents/dsh-tree.tar'"

  CHECK="$(dev_q "[ -f '$INSTALL_DIR/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' ] && echo ok || echo missing" | tr -d '\r')"
  [ "$CHECK" = "ok" ] || die "the DSH tree did not land where expected under $INSTALL_DIR/dsh"
  note "tree in place"
fi

# ---------------------------------------------------------------------------
# 3. the port itself
# ---------------------------------------------------------------------------
step "3/4  port files"

push_tar() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] push repo → %s\n' "$INSTALL_DIR"
    return 0
  fi
  _t="$(mktemp -t dsh-ios.XXXXXX.tar)"
  ( cd "$HERE" && tar --exclude='.git' -cf "$_t" . ) || die "tar failed"
  push "$_t" "/var/mobile/Documents" "dsh-ios-repo.tar"
  mutate "mkdir -p '$INSTALL_DIR' && cd '$INSTALL_DIR' && tar -xf '/rootfs/var/mobile/Documents/dsh-ios-repo.tar' && rm -f '/rootfs/var/mobile/Documents/dsh-ios-repo.tar'"
  rm -f "$_t"
}
push_tar
note "repo contents copied to $INSTALL_DIR"

# ---------------------------------------------------------------------------
# 4. adapt
# ---------------------------------------------------------------------------
step "4/4  install.sh"

if [ "$DRY_RUN" = "1" ]; then
  printf '   [dry-run] device: cd %s && sh install.sh --dry-run\n' "$INSTALL_DIR"
else
  dev "cd '$INSTALL_DIR' && sh install.sh" || die "install.sh failed on the phone"
fi

# ---------------------------------------------------------------------------
# done
# ---------------------------------------------------------------------------
if [ "$SKIP_START" = "1" ]; then
  step "done"
  say "Installed. Start it on the phone with:"
  say ""
  say "    cd $INSTALL_DIR && sh scripts/start.sh"
  exit 0
fi

step "starting"

if [ "$DRY_RUN" = "1" ]; then
  printf '   [dry-run] device: cd %s && sh scripts/start.sh\n' "$INSTALL_DIR"
  exit 0
fi

# start.sh polls for the banner and prints the URL, so capture it as-is.
dev "cd '$INSTALL_DIR' && sh scripts/start.sh" || die "start.sh failed on the phone"

cat <<EOF

$(printf '%s' "$B")Open the printed URL in Safari on the phone.$(printf '%s' "$R")

The token is only needed once — Safari keeps the cookie, so plain
127.0.0.1:3080 works afterwards.

On first use set the permission mode to full access in the UI: workspace-write
has no sandbox backend able to start on iOS.
EOF
