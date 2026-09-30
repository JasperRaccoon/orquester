#!/bin/sh
# Orquester desktop host (desktop spec §5.2). Runs as the `host` window of the
# desktop's tmux service session:
#
#   desktop-host.sh <dir> <width> <height> [audio 0|1] [socket-dir]
#
# Starts the desktop's D-Bus session bus, its PulseAudio server (audio=1), the
# Xvnc display and Openbox, all as background jobs of this non-interactive
# shell, so they share its process group. The traps take that whole group down
# with the script (a killed tmux session would otherwise orphan pulseaudio and
# dbus-daemon), wait for the direct children, then record `host.exit` for the
# daemon's watcher. `<socket-dir>` is where the Unix sockets go (the desktop
# dir unless its paths are too long for sun_path, §5.3).

dir=$1
width=$2
height=$3
audio=${4:-0}
sock=${5:-$dir}

# stdout and stderr go to the log; stdin stays on the pane's pty. tmux treats a
# pane whose pty nobody holds open any more as dead and closes the window,
# which would hang up this script at once.
exec >>"$dir/host.log" 2>&1

# Temp file + rename, so a watcher never reads a half-written value.
atomic_write() {
  printf '%s\n' "$2" >"$1.tmp" && mv -f "$1.tmp" "$1"
}

finish() {
  trap '' HUP INT TERM
  trap - EXIT
  kill -TERM 0 2>/dev/null
  wait
  echo "desktop host exited ($1)"
  atomic_write "$dir/host.exit" "$1"
  exit "$1"
}
trap 'finish $?' EXIT
trap 'finish 129' HUP
trap 'finish 130' INT
trap 'finish 143' TERM

echo "desktop host starting: ${width}x${height}, audio=$audio"
export XDG_RUNTIME_DIR="$dir/run"

dbus-daemon --session --address="unix:path=$sock/bus" --nofork --nopidfile &

if [ "$audio" = 1 ]; then
  # Runtime, state and config under the desktop dir: nothing touches the
  # service user's own ~/.config/pulse, and two desktops never share a server.
  PULSE_RUNTIME_PATH="$sock/pulse" PULSE_STATE_PATH="$dir/pulse-state" XDG_CONFIG_HOME="$dir/config" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$sock/bus" pulseaudio -n -F "$dir/default.pa" --daemonize=no --exit-idle-time=-1 --use-pid-file=no \
    --system=no --log-target=stderr &
fi

# -displayfd: Xvnc picks a free display number and writes it to fd 3 once it
# accepts connections. Through a FIFO, `read` blocks until then (no polling);
# if Xvnc dies first, the writer closes and `read` sees EOF.
fifo="$dir/displayfd"
rm -f "$fifo"
mkfifo -m 600 "$fifo" || exit 1
Xvnc -displayfd 3 -auth "$dir/Xauthority" -rfbunixpath "$sock/vnc.sock" -rfbunixmode 0600 -rfbport -1 \
  -SecurityTypes None -AlwaysShared -nolisten tcp -geometry "${width}x${height}" -depth 24 3>"$fifo" &
xvnc=$!
display=
read -r display <"$fifo"
rm -f "$fifo"
case $display in
  '' | *[!0-9]*)
    echo "Xvnc did not report a display"
    exit 1
    ;;
esac
atomic_write "$dir/ready" "$display"
echo "display :$display ready"

DISPLAY=":$display" XAUTHORITY="$dir/Xauthority" DBUS_SESSION_BUS_ADDRESS="unix:path=$sock/bus" openbox &

wait "$xvnc"
exit $?
