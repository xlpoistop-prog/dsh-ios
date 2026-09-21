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
DEVICE=""
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
ASKPASS_DIR=""

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
# cleanup
#
# The scratch directory and the askpass helper both have to disappear however
# the script ends. One trap for both, so that neither can displace the other --
# a second `trap ... EXIT` would silently replace the first.
# ---------------------------------------------------------------------------
cleanup() {
  if [ -n "$ASKPASS_DIR" ]; then rm -rf "$ASKPASS_DIR" 2>/dev/null || true; fi
  if [ -n "$WORK" ];        then rm -rf "$WORK"        2>/dev/null || true; fi
  return 0
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# arguments
# ---------------------------------------------------------------------------
usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --device USER@HOST      SSH target. Omit it and the script looks for the
                          phone itself: 127.0.0.1 first, then this computer's
                          own subnet on port 22
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
# PuTTY first, when it is installed. Not merely precedence -- measured, and the
# numbers are why this order matters. On the machine this was written for, 20
# sequential connections gave:
#
#     plink   20/20
#     ssh     17/20   twice, failing at the same three positions (6, 12, 18)
#                     both times, always "Connection timed out during banner
#                     exchange" -- before authenticating at all. Periodic, then,
#                     rather than random noise.
#
# The two runs were not in the same network state: the first had no proxy adapter
# up, the second had Meta Tunnel running. Identical results -- so the ssh
# weakness is not the proxy's doing. A proxy is just one more thing that can end
# up on the route to the phone, which is why it is worth warning about (below).
#
# plink also takes the password as an argument (-pw), so there is no helper
# program and no environment variable in the middle of it. It is frequently
# installed somewhere off-PATH, so look in the usual places rather than trusting
# PATH alone.
#
# OpenSSH is the fallback, and now a real one rather than an error message: Git
# Bash has it, Windows 10 and 11 have one in System32\OpenSSH, and Linux and
# macOS have had one forever -- so nobody has to install PuTTY to use this. The
# two differ only in how the password is supplied: `ssh` takes none on the
# command line, so sshpass is used where it exists (Linux, macOS) and the
# SSH_ASKPASS helper below where it does not (Windows). --transport forces one.
# ---------------------------------------------------------------------------
step "transport"

RUN=""; PUT=""; MODE=""

# Find a tool on PATH, then at the given paths, then with .exe appended -- the
# last two matter on Windows, where these binaries are rarely on PATH.
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
   Install OpenSSH (in Git Bash or WSL, or Windows' own: Settings -> System ->
   Optional features -> OpenSSH Client), or PuTTY, or point at the binaries:
     PLINK=/path/to/plink PSCP=/path/to/pscp $0 ..."
fi

if [ "$MODE" = "putty" ]; then note "transport: putty ($PLINK_BIN)"; else note "transport: openssh"; fi

# A password with OpenSSH, and no sshpass to feed it in (which is the normal
# case on Windows -- Git for Windows ships no sshpass, and neither does Windows
# itself). SSH_ASKPASS_REQUIRE=force arrived in OpenSSH 8.4, and without it ssh
# ignores the helper while a terminal is attached and asks the person instead,
# once per connection. Worth a warning rather than an error: it still works,
# it is just tedious.
if [ "$MODE" = "openssh" ] && ! command -v sshpass >/dev/null 2>&1; then
  _ver="$(ssh -V 2>&1 | sed -n 's/^OpenSSH_\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')"
  _maj="${_ver%% *}"
  _min="${_ver##* }"
  if [ -n "$_ver" ] && { [ "$_maj" -lt 8 ] || { [ "$_maj" -eq 8 ] && [ "$_min" -lt 4 ]; }; }; then
    warn "this OpenSSH ($(ssh -V 2>&1 | cut -d, -f1)) predates SSH_ASKPASS_REQUIRE (8.4):
     the password will be asked for once per connection. PuTTY (--transport putty)
     or an SSH key (--key) avoids that."
  fi
fi

# ---------------------------------------------------------------------------
# a running proxy is the case where the OpenSSH path is worst
#
# Transparent proxies and VPNs take over the route to the local network as well,
# so a connection to the phone can be accepted locally by the proxy and then
# never answered -- which is the banner-exchange timeout measured above, and the
# reason PuTTY is tried first. Anyone who has no PuTTY deserves to be told this
# before a run fails halfway, so look for the usual signs: a Wintun/TAP adapter
# from Clash, Mihomo, Surge, sing-box, Meta, WireGuard or OpenVPN, or a fake-IP
# DNS server (Clash and friends hand out 198.18.x.x/198.19.x.x).
#
# A warning, never an error: it does work, connections are retried.
# ---------------------------------------------------------------------------
if [ "$MODE" = "openssh" ] && { command -v powershell.exe >/dev/null 2>&1 || command -v powershell >/dev/null 2>&1; }; then
  _ps="$(command -v powershell.exe 2>/dev/null || command -v powershell)"
  _tmp="$(mktemp -t proxycheck.XXXXXX).ps1"
  cat > "$_tmp" <<'PSEOF'
$pattern = 'Wintun|TAP-Win32|TAP-Windows|Clash|Mihomo|Surge|sing-box|WireGuard|OpenVPN|Meta Tunnel'
$hits = @()
$hits += Get-NetAdapter -ErrorAction SilentlyContinue |
         Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -match $pattern } |
         ForEach-Object { $_.InterfaceDescription }
$hits += Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
         Where-Object { $_.ServerAddresses -match '^198\.(18|19)\.' } |
         ForEach-Object { "fake-IP DNS $($_.ServerAddresses -join ', ')" }
if ($hits.Count -gt 0) { $hits[0] }
PSEOF
  _proxy="$( "$_ps" -NoProfile -ExecutionPolicy Bypass -File "$_tmp" 2>/dev/null | tr -d '\r' | head -1 )"
  rm -f "$_tmp"
  if [ -n "$_proxy" ]; then
    warn "a proxy or VPN appears to be running ($_proxy).
     Those take over the route to the local network too, and that is exactly
     where this ssh is weak: measured on this machine, plink completed 20 of 20
     connections and ssh 17 of 20, every failure a banner-exchange timeout
     before authenticating. Connections are retried, so it usually still works
     -- but while a proxy is on, PuTTY is the better tool. Install it and re-run
     (it is found automatically), or pass --transport putty."
  fi
fi

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
  # Keepalives, so that a middlebox with a short idle timeout cannot cut a long
  # step (tar -xf, install.sh) in half and make it look like a failure.
  _o="$_o -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
  if [ -n "$KEYFILE" ]; then _o="$_o -i $KEYFILE"; fi
  printf '%s' "$_o"
}

# Run a connection command, and try it twice more if it fails.
#
# Not belt-and-braces -- measured. See the transport section above: on the
# network this was written for, the OpenSSH path dropped 3 of 20 connections in
# "banner exchange" before authenticating at all (a transparent proxy sits in
# front of everything here, and the phone's Wi-Fi sleeps). Retried a moment
# later, the same connection succeeds. A run makes about a dozen connections, so
# without this the OpenSSH fallback fails most of the time on exactly the network
# that needs the fallback.
#
# Running a remote command twice is safe here: everything this script sends is
# idempotent. The probes only read; mkdir -p, rm -f and tar -x converge on the
# same state; install.sh says so at the top of itself, and start.sh replaces
# whatever is already running.
retry() {  # retry <command and arguments...>
  _try=1
  while [ "$_try" -le 3 ]; do
    _rc=0
    "$@" || _rc=$?
    if [ "$_rc" -eq 0 ]; then return 0; fi
    if [ "$_try" -eq 3 ]; then return "$_rc"; fi
    _try=$((_try + 1))
    warn "the connection dropped; retrying ($_try/3)"
    sleep 2
  done
  return 1
}

ssh_cmd() {  # ssh_cmd "<remote command>"
  # shellcheck disable=SC2086
  retry auth ssh $(ssh_opts) "$DEVICE" "$1"
}

# scp_cmd <local> <remote> -- the OpenSSH counterpart of pscp, password included.
scp_cmd() {
  # shellcheck disable=SC2086
  retry auth scp $(ssh_opts) "$@"
}

# Supply the password to OpenSSH by whichever route this machine has.
#
# sshpass is the obvious one and is used when it exists, but there is none on
# Windows. SSH_ASKPASS is the way round that: it names a program whose stdout is
# the password. The password is handed over in the environment rather than
# written into the helper, so it never lands on disk, and the whole directory is
# removed on exit by the cleanup trap.
#
# ssh runs the helper once per connection, and each of those needs the DISPLAY
# variable to be set, even on Windows where there is no display.
setup_askpass() {
  if [ -n "$ASKPASS_DIR" ]; then return 0; fi
  ASKPASS_DIR="$(mktemp -d)" || die "cannot create a temporary directory for the askpass helper"
  cat > "$ASKPASS_DIR/askpass.sh" <<'EOF'
#!/bin/sh
printf '%s\n' "$DSH_ASKPASS_PASSWORD"
EOF
  chmod 700 "$ASKPASS_DIR/askpass.sh"
  DSH_ASKPASS_PASSWORD="$PASSWORD"
  SSH_ASKPASS="$ASKPASS_DIR/askpass.sh"
  DISPLAY=:0
  export DSH_ASKPASS_PASSWORD SSH_ASKPASS SSH_ASKPASS_REQUIRE=force DISPLAY
}

auth() {  # auth <command and arguments...>
  if [ -n "$PASSWORD" ] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$PASSWORD" "$@"
  else
    if [ -n "$PASSWORD" ]; then setup_askpass; fi
    "$@"
  fi
}

plink_cmd() {  # plink_cmd "<remote command>"
  # shellcheck disable=SC2086
  retry "$PLINK_BIN" $(putty_opts) "$DEVICE" "$1"
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
    retry "$PSCP_BIN" $(putty_opts) "$_local" "$DEVICE:/rootfs$_dir/$_name"
  else
    scp_cmd "$_local" "$DEVICE:/rootfs$_dir/$_name"
  fi
}

STAGE="/var/mobile/Documents/.dsh-ios-stage"

# ---------------------------------------------------------------------------
# password, if it was not given
#
# Asked for before looking for the phone, because the search itself needs to
# authenticate -- there is no point finding a host you cannot log in to.
#
# Only prompted when stdin is a terminal: with stdin redirected, `read` would
# consume the redirect rather than wait for a person.
# ---------------------------------------------------------------------------
if [ -z "$PASSWORD" ] && [ -z "$KEYFILE" ]; then
  if [ -t 0 ]; then
    say ""
    printf '%sPassword for the phone (mobile account): %s' "$B" "$R"
    stty -echo 2>/dev/null || true
    read -r PASSWORD
    stty echo 2>/dev/null || true
    printf '\n'
  fi
fi

if [ -z "$PASSWORD" ] && [ -z "$KEYFILE" ]; then
  die "no password and no SSH key.

   This script needs one or the other to log in to the phone. Either:
     --password <pw>    the password the jailbreak asked you to set
                        (OpenSSH's default is alpine if you never set one)
     --key <file>       an SSH private key, if you have set one up"
fi

# Set the OpenSSH password helper up now, in the main shell, rather than on the
# first connection. Most of the probes run inside `$( )`, and a subshell's
# variables never come back -- setting it up lazily there would leave the trap
# with no directory to remove, and one directory per connection behind it.
if [ -n "$PASSWORD" ] && [ "$MODE" = "openssh" ] && ! command -v sshpass >/dev/null 2>&1; then
  setup_askpass
fi

# ---------------------------------------------------------------------------
# find the phone, if it was not given
#
# The fastest route for most people is: phone and computer on the same Wi-Fi,
# run this, type the password. No IP to look up and no extra tools -- so when
# --device is omitted, try the obvious things before giving up.
#
#   1. mobile@127.0.0.1 -- instant, and correct when i4Tools' USB channel is
#      open. Worth trying first because it costs nothing.
#   2. scan this machine's own subnet for hosts with port 22 open.
#
# The scan is deliberately narrow: it only looks at the subnet the computer is
# already on, and only at port 22. It is not a general port scanner.
# ---------------------------------------------------------------------------
DEVICE_GIVEN=0
if [ -n "$DEVICE" ]; then DEVICE_GIVEN=1; fi

# The local /24, from whichever interface owns the default route.
local_subnet() {
  if command -v powershell.exe >/dev/null 2>&1 || command -v powershell >/dev/null 2>&1; then
    _ps="$(command -v powershell.exe 2>/dev/null || command -v powershell)"
    "$_ps" -NoProfile -Command "
      Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { \$_.IPAddress -match '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))\.' -and
                       \$_.InterfaceAlias -notmatch 'VMware|VirtualBox|Loopback|vEthernet' } |
        Select-Object -First 1 -ExpandProperty IPAddress" 2>/dev/null | tr -d '\r' |
      awk -F. '{print $1"."$2"."$3}'
  else
    # Linux / macOS / WSL
    if command -v ip >/dev/null 2>&1; then
      ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | awk '{print $2}' | awk -F. '{print $1"."$2"."$3}'
    else
      route -n get default 2>/dev/null | grep -o 'interface: .*' | awk '{print $2}' |
        xargs -I{} ifconfig {} 2>/dev/null | grep -o 'inet [0-9.]*' | head -1 |
        awk '{print $2}' | awk -F. '{print $1"."$2"."$3}'
    fi
  fi
}

# Print the addresses on a subnet that are running an SSH server.
#
# Not "that answer on port 22" -- that test is not good enough. With a
# transparent/TUN proxy active (Clash, Surge and friends), every TCP connect
# succeeds against every address, because the proxy accepts locally and resolves
# upstream afterwards. A plain port scan then reports all 254 addresses as live.
#
# Reading the server's banner fixes it: a real sshd sends "SSH-2.0-..." the
# instant the connection opens, and a proxy fronting nothing sends nothing.
# Measured on the machine this was written for: 2.8 s for a /24, one hit.
scan_ssh_hosts() {
  _base="$1"
  [ -n "$_base" ] || return 0

  if command -v powershell.exe >/dev/null 2>&1 || command -v powershell >/dev/null 2>&1; then
    _ps="$(command -v powershell.exe 2>/dev/null || command -v powershell)"
    _tmp="$(mktemp -t sshscan.XXXXXX).ps1"
    # A quoted heredoc, so nothing in the PowerShell needs shell escaping.
    cat > "$_tmp" <<'PSEOF'
param([string]$Base, [string]$User)
$tasks = 1..254 | ForEach-Object {
  $ip = "$Base.$_"
  $c = New-Object Net.Sockets.TcpClient
  [pscustomobject]@{ Ip = $ip; Client = $c; Task = $c.ConnectAsync($ip, 22) }
}
[void][Threading.Tasks.Task]::WaitAll($tasks.Task, 1200)

$live = @($tasks | Where-Object { $_.Client.Connected })
$reads = foreach ($l in $live) {
  try {
    $s = $l.Client.GetStream()
    $buf = New-Object byte[] 64
    [pscustomobject]@{ Ip = $l.Ip; Buf = $buf; Task = $s.ReadAsync($buf, 0, 64) }
  } catch {}
}
if ($reads) { [void][Threading.Tasks.Task]::WaitAll(@($reads.Task), 900) }

@($reads) |
  Where-Object { $_.Task.Status -eq 'RanToCompletion' -and $_.Task.Result -gt 0 } |
  ForEach-Object {
    $line = [Text.Encoding]::ASCII.GetString($_.Buf, 0, $_.Task.Result).Trim()
    if ($line -like 'SSH-*') { "$($_.Ip) $line" }
  }

@($tasks) | ForEach-Object { try { $_.Client.Close() } catch {} }
PSEOF
    "$_ps" -NoProfile -ExecutionPolicy Bypass -File "$_tmp" -Base "$_base" 2>/dev/null | tr -d '\r'
    rm -f "$_tmp"

  elif command -v nc >/dev/null 2>&1; then
    # Sequential and slower, but the same banner test.
    for _i in $(seq 1 254); do
      _b="$(nc -w 1 "$_base.$_i" 22 </dev/null 2>/dev/null | head -1 | tr -d '\r')"
      case "$_b" in SSH-*) echo "$_base.$_i $_b" ;; esac
    done
  fi
}

if [ "$DEVICE_GIVEN" = "0" ]; then
  say ""
  say "${B}No --device given, looking for the phone.${R}"
  note "fastest route: phone and computer on the same Wi-Fi"

  # 1. the USB-forwarded channel, if one is open.
  #
  # This is a liveness probe, not an authentication attempt: at this point the
  # host key has not been learned yet, so a real connection would fail on that
  # and tell us nothing. Instead, read what plink says -- "Connection refused"
  # means nothing is listening, anything else means something is.
  _p127="$("$PLINK_BIN" -ssh -batch -pw "$PASSWORD" mobile@127.0.0.1 "exit" 2>&1 || true)"
  case "$_p127" in
    *"Connection refused"*|*"connection refused"*)
      _have127=0 ;;
    *) _have127=1 ;;
  esac

  if [ "$_have127" = "1" ]; then
    DEVICE="mobile@127.0.0.1"
    note "something is listening on 127.0.0.1:22 — assuming that is the phone"
  else
    note "nothing on 127.0.0.1; scanning the local network for port 22..."
    _subnet="$(local_subnet)"
    if [ -z "$_subnet" ]; then
      die "could not work out this computer's subnet.
   Pass the phone's address explicitly:  --device mobile@<phone ip>
   The phone's IP is in Settings -> Wi-Fi on the phone."
    fi
    note "subnet $_subnet.0/24"

    # Each line is "ip SSH-2.0-OpenSSH_x.y"; only the address is needed here.
    _found="$(scan_ssh_hosts "$_subnet" | awk 'NF {print $1}')"
    _count="$(printf '%s\n' "$_found" | grep -c . || true)"

    if [ "$_count" = "0" ]; then
      die "found no SSH server in $_subnet.0/24.

   Check that:
     * the phone is on the same Wi-Fi as this computer
     * OpenSSH is installed on the phone (openssh-server from Sileo)
     * the jailbreak is active

   Or give the address yourself:  --device mobile@<phone ip>"
    elif [ "$_count" = "1" ]; then
      DEVICE="mobile@$_found"
      note "found $_found"
    else
      say ""
      say "Several hosts answered on port 22:"
      printf '%s\n' "$_found" | sed 's/^/     /'
      say ""
      die "pick one and pass it explicitly:
     $0 --device mobile@<address> ...
   The phone is usually identifiable as a device you do not recognise; its IP
   is also shown in Settings -> Wi-Fi on the phone itself."
    fi
  fi
fi

# ---------------------------------------------------------------------------
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
if [ -z "$HAS_TAR" ]; then
  die "the phone stopped answering (empty reply to the tar check).
   The connection dropped mid-run; start the script again."
fi
[ "$HAS_TAR" = "yes" ] || die "no tar on the phone — it ships with the base jailbreak;
   install it from Sileo if it is missing."

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

  [ -n "$WORK" ] || WORK="$(mktemp -d)"

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
