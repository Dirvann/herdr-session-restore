#!/bin/sh
# session-restore saver for Linux and macOS (POSIX sh, standard tools only).
#   sh save.sh [save]   save a snapshot to ~/.herdr-sessions/auto when something changed
#   sh save.sh print    print a fresh snapshot (the popup's view of "now"), store nothing
#   sh save.sh enable   run the saver every 5 minutes (systemd user timer, LaunchAgent or cron)
#   sh save.sh disable  remove that schedule
#   sh save.sh status   {"enabled":..,"lastRun":..,"lastError":".."}
# Records raw facts only (hc output, processes, Claude session files); plan.js decides.
set -u

STORE="$HOME/.herdr-sessions"
AUTO="$STORE/auto"
KEEP=50
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
UNIT=herdr-session-save
LABEL=dev.herdr.session-restore
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CRON_TAG="# herdr-session-restore"

log() {
  mkdir -p "$STORE"
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$STORE/log.txt"
}

find_hc() {
  if command -v hc >/dev/null 2>&1; then command -v hc; return 0; fi
  for p in "$HOME/.local/bin/hc" /opt/homebrew/bin/hc /usr/local/bin/hc; do
    if [ -x "$p" ]; then printf '%s\n' "$p"; return 0; fi
  done
  return 1
}

json_escape() { sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r'; }

# snapshot OUT SIG: writes the snapshot JSON to OUT and its change signature to SIG.
# Prints the reason and returns 1 when hc can't be reached.
snapshot() {
  out=$1
  sig=$2
  hc_bin=$(find_hc) || { echo "hc not found"; return 1; }
  ls_json=$("$hc_bin" ls --json 2>/dev/null) || { echo "hc ls failed (is herdr-core running?)"; return 1; }
  [ -n "$ls_json" ] || { echo "hc ls printed nothing"; return 1; }
  case "$(uname -s)" in Darwin) platform=macos ;; *) platform=linux ;; esac

  work=$(mktemp -d "${TMPDIR:-/tmp}/herdr-save.XXXXXX") || return 1
  : > "$sig"

  # Live processes. One -o per column: BSD ps takes everything after the first "=" as a
  # header. lstart has the same format on Linux and macOS with LC_ALL=C, printed in UTC.
  TZ=UTC0 LC_ALL=C ps -A -o pid= -o ppid= -o lstart= -o comm= > "$work/ps" 2>/dev/null
  awk '{print $1}' "$work/ps" > "$work/pids"

  {
    printf '{"version":2,"savedAt":%s000,"platform":"%s","ls":' "$(date +%s)" "$platform"
    printf '%s' "$ls_json"
    printf ',"get":{'
    first=1
    for a in $(printf '%s' "$ls_json" | grep -o '"address":"[^"/]*"' | sed 's/^"address":"//; s/"$//'); do
      g=$("$hc_bin" get "$a" --json 2>/dev/null) || continue
      [ -n "$g" ] || continue
      [ $first -eq 1 ] || printf ','
      first=0
      printf '"%s":%s' "$a" "$g"
      # Only terminals Herdr shows count as a change: hidden workers come and go all day.
      case "$g" in
        *'"herdr.space"'*) printf '%s %s\n' "$a" "$(printf '%s' "$g" | grep -o '"foreground":{"argv":\[[^]]*\]' | head -n 1)" >> "$sig" ;;
      esac
    done
    printf '},"processes":['
    awk '{
      name = ""
      for (i = 8; i <= NF; i++) name = name (i > 8 ? " " : "") $i
      gsub(/\\/, "\\\\", name); gsub(/"/, "\\\"", name)
      printf "%s{\"pid\":%s,\"ppid\":%s,\"start\":\"%s %s %s %s %s\",\"name\":\"%s\"}", (NR > 1 ? "," : ""), $1, $2, $3, $4, $5, $6, $7, name
    }' "$work/ps"
    printf '],"sessions":['
    first=1
    for f in "$HOME"/.claude/sessions/*.json; do
      [ -f "$f" ] || continue
      pid=$(basename "$f" .json)
      case "$pid" in *[!0-9]*|'') continue ;; esac
      grep -qx "$pid" "$work/pids" || continue
      # Claude rewrites these while it runs, and a crash can leave one cut short:
      # take only what looks like a whole JSON object, or one bad file breaks the snapshot.
      body=$(tr -d '\n\r' < "$f")
      case "$body" in '{'*'}') ;; *) continue ;; esac
      [ $first -eq 1 ] || printf ','
      first=0
      printf '%s' "$body"
      printf 'session %s %s\n' "$pid" "$(printf '%s' "$body" | grep -o '"sessionId":"[^"]*"' | head -n 1)" >> "$sig"
    done
    printf ']}'
  } > "$out"

  sort "$sig" > "$work/sig" && cat "$work/sig" > "$sig"
  rm -rf "$work"
  return 0
}

save() {
  mkdir -p "$AUTO"
  date +%s > "$STORE/last.run"
  # Unique temp files: enable's own save can overlap the scheduler's first run.
  tmp=$(mktemp "$STORE/.snapshot.XXXXXX") || return 1
  tsig=$(mktemp "$STORE/.sig.XXXXXX") || { rm -f "$tmp"; return 1; }
  if ! reason=$(snapshot "$tmp" "$tsig"); then
    printf '%s\n' "$reason" > "$STORE/last.error"
    log "error: $reason"
    rm -f "$tmp" "$tsig"
    return 1
  fi
  : > "$STORE/last.error"
  newest=$(ls "$AUTO" 2>/dev/null | grep '\.json$' | sort -r | head -n 1)
  if [ -n "$newest" ] && [ -f "$STORE/last.sig" ] && cmp -s "$tsig" "$STORE/last.sig"; then
    touch "$AUTO/$newest"
    rm -f "$tmp" "$tsig"
    log "unchanged"
    return 0
  fi
  name="$(date +%Y%m%d-%H%M%S).json"
  mv "$tmp" "$AUTO/$name"
  mv "$tsig" "$STORE/last.sig"
  ls "$AUTO" | grep '\.json$' | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$AUTO/$old"; done
  log "saved $name"
}

print_now() {
  tmp=$(mktemp "${TMPDIR:-/tmp}/herdr-now.XXXXXX") || exit 1
  if ! reason=$(snapshot "$tmp" "$tmp.sig"); then
    echo "$reason" >&2
    rm -f "$tmp" "$tmp.sig"
    exit 1
  fi
  cat "$tmp"
  rm -f "$tmp" "$tmp.sig"
}

has_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

xml_escape() { sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

enable() {
  mkdir -p "$STORE"
  if [ "$(uname -s)" = Darwin ]; then
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$(printf '%s' "$SELF" | xml_escape)</string><string>save</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(printf '%s' "$PATH" | xml_escape)</string></dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || return 1
  elif has_systemd; then
    dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$dir"
    path_unit=$(printf '%s' "$PATH" | sed 's/%/%%/g')
    cat > "$dir/$UNIT.service" <<EOF
[Unit]
Description=Save which Claude Code session runs in which Herdr terminal (session-restore mod)

[Service]
Type=oneshot
Environment="PATH=$path_unit"
ExecStart=/bin/sh "$SELF" save
EOF
    cat > "$dir/$UNIT.timer" <<EOF
[Unit]
Description=Run $UNIT every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload && systemctl --user enable --now "$UNIT.timer" >/dev/null 2>&1 || return 1
  else
    line="*/5 * * * * PATH='$PATH' /bin/sh '$SELF' save $CRON_TAG"
    { crontab -l 2>/dev/null | grep -v "$CRON_TAG"; printf '%s\n' "$line"; } | crontab - || return 1
  fi
  log "autosave enabled"
  # The schedule is on even if this first save fails (say herdr-core is down); status
  # shows that failure as lastError.
  save || true
}

disable() {
  if [ -f "$PLIST" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1
    rm -f "$PLIST"
  fi
  dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  if [ -f "$dir/$UNIT.timer" ]; then
    systemctl --user disable --now "$UNIT.timer" >/dev/null 2>&1
    rm -f "$dir/$UNIT.timer" "$dir/$UNIT.service"
    systemctl --user daemon-reload >/dev/null 2>&1
  fi
  if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
    crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab -
  fi
  log "autosave disabled"
}

status() {
  enabled=false
  if [ -f "$PLIST" ]; then enabled=true
  elif [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT.timer" ] && systemctl --user is-enabled "$UNIT.timer" >/dev/null 2>&1; then enabled=true
  elif command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then enabled=true
  fi
  run=$(cat "$STORE/last.run" 2>/dev/null)
  case "$run" in ''|*[!0-9]*) last=null ;; *) last="${run}000" ;; esac
  err=$(cat "$STORE/last.error" 2>/dev/null | json_escape)
  printf '{"enabled":%s,"lastRun":%s,"lastError":"%s"}\n' "$enabled" "$last" "$err"
}

case "${1:-save}" in
  save) save ;;
  print) print_now ;;
  enable) enable ;;
  disable) disable ;;
  status) status ;;
  *) echo "usage: sh save.sh [save|print|enable|disable|status]" >&2; exit 2 ;;
esac
