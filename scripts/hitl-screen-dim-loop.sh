#!/usr/bin/env bash
# HITL loop: reproduce/verify the screen dimmer's inactivity timing.
#
# Requires the instrumented APK (ScreenDimPlugin logs tagged "DEBUG-dim").
# Drives you through two scenarios and dumps the logcat timing so we can see
# whether the dim fires at the right time, while active, or not at all.
#
# Usage: ./scripts/hitl-screen-dim-loop.sh [delay-seconds]
set -u
DELAY_SEC="${1:-30}"

log() { echo "[dim-loop] $*"; }
die() { echo "[dim-loop] ERROR: $*" >&2; exit 1; }

command -v adb >/dev/null 2>&1 || die "adb not on PATH"
adb get-state >/dev/null 2>&1 || die "no device connected (adb devices)"

log "1) Install the INSTRUMENTED APK (ScreenDimPlugin logs DEBUG-dim)."
log "2) In the app: Settings -> Screen dim -> pick ${DELAY_SEC}s."
log "3) Navigate away from Settings (e.g. to Music)."
read -r -p "[dim-loop] Press ENTER when the ${DELAY_SEC}s delay is set and you're on another screen..."

adb logcat -c
log "logcat cleared at $(date +%H:%M:%S)."

echo ""
echo "=== SCENARIO A (inactivity should DIM) ==="
log "Do NOT touch the screen for at least ${DELAY_SEC}s. Watch whether it dims."
read -r -p "[dim-loop] Press ENTER after you observed dim-or-not (did the screen dim?)... "

echo ""
echo "=== SCENARIO B (activity should NOT dim) ==="
log "Now tap the screen every few seconds for ${DELAY_SEC}s (keep it active)."
read -r -p "[dim-loop] Press ENTER after ${DELAY_SEC}s of active tapping..."

echo ""
echo "=== DEBUG-dim logcat (timestamps = the signal) ==="
adb logcat -d 2>/dev/null | grep -i "DEBUG-dim" | tail -60

echo ""
echo "=== Interpretation ==="
echo "Look at the scheduleDim / DIM FIRED lines and their timestamps:"
echo " - Correct: DIM FIRED appears ~${DELAY_SEC}s after the last touch DOWN, and"
echo "   NOT while you were tapping in Scenario B."
echo " - If DIM FIRED fires while actively tapping => the touch interceptor is NOT"
echo "   resetting the timer (native measurement bug)."
echo " - If DIM FIRED never appears => the dim overlay never shows, or enable was"
echo "   not called (check for 'enable delayMs=' and 'disable' lines)."
log "Redact any tokens before sharing. Done."
