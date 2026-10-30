#!/bin/bash
# Starts the virtual display, a VNC server (localhost only) and noVNC, then the sync worker (which starts Chromium itself).
set -euo pipefail

if [ -z "${NOVNC_PASSWORD:-}" ]; then
  echo "NOVNC_PASSWORD is not set (see .env). Refusing to start an unauthenticated remote browser." >&2
  exit 1
fi

export DISPLAY="${DISPLAY:-:99}"
W="${SCREEN_WIDTH:-1366}"; H="${SCREEN_HEIGHT:-850}"

# leftovers from a previous run of this container
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
rm -f /profile/SingletonLock /profile/SingletonCookie /profile/SingletonSocket

Xvfb "$DISPLAY" -screen 0 "${W}x${H}x24" -nolisten tcp &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.2; done
openbox >/dev/null 2>&1 &

# VNC listens on localhost inside the container only; noVNC (websockify) is the single entry point. Only the first 8 characters of the VNC password count.
x11vnc -storepasswd "$NOVNC_PASSWORD" /tmp/vncpass >/dev/null
x11vnc -display "$DISPLAY" -rfbauth /tmp/vncpass -localhost -forever -shared -rfbport 5900 -quiet -bg -o /tmp/x11vnc.log
websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

exec node_modules/.bin/tsx scripts/browser-worker.ts
