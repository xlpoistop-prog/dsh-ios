#!/usr/bin/zsh
#
# Stop the DSH web server started by start.sh.
#
# Also useful right after a re-jailbreak: the pidfile can name a process from
# the previous boot, and kill simply reports "no such process" — harmless.

# Where the install lives, not where this file lives — the pidfile sits at the
# install root. Same reasoning as in start.sh: the repo keeps this under
# scripts/, and callers invoke it as `sh scripts/stop.sh`.
HERE="$(cd "$(dirname "$0")" && pwd)"
case "$(basename "$HERE")" in
  scripts) BASE="$(cd "$HERE/.." && pwd)" ;;
  *)       BASE="$HERE" ;;
esac

if [ ! -f "$BASE/server.pid" ]; then
  echo "no server.pid — nothing recorded as running"
  exit 0
fi

PID="$(cat "$BASE/server.pid" 2>/dev/null)"
if [ -z "$PID" ]; then
  echo "server.pid is empty; removing it"
  rm -f "$BASE/server.pid"
  exit 0
fi

if kill -9 "$PID" 2>/dev/null; then
  echo "stopped dsh (pid $PID)"
else
  echo "pid $PID was not running (already stopped, or stale after a reboot)"
fi
rm -f "$BASE/server.pid"
