#!/usr/bin/env bash
# HITL loop: reproduce "app shutdown when the phone is locked".
#
# Drives a human through the steps only they can perform (unlock a real device
# and start playback), while this script captures the evidence Android emits
# when it kills the process. The logcat dump is the red-capable signal.
#
# Usage:
#   ./scripts/hitl-android-background-loop.sh [seconds-to-watch] [package]
#   e.g. ./scripts/hitl-android-background-loop.sh 120 com.maverock24.mobilemediaapp
#
# Redact anything that looks like a token before sharing the output.

set -u
SECS="${1:-120}"
PKG="${2:-com.maverock24.mobilemediaapp}"

log() { echo "[loop] $*"; }
die() { echo "[loop] ERROR: $*" >&2; exit 1; }

command -v adb >/dev/null 2>&1 || die "adb not found on PATH"
adb get-state >/dev/null 2>&1 || die "no device/emulator connected (adb devices)"

log "clearing logcat..."
adb logcat -c 2>/dev/null

log "=== STEP 1 (you): open the app, start playing a track (MP3 or podcast), "
log "    then LOCK the screen. Keep it locked. "
log "=== The script polls for ${SECS}s and dumps the kill reason if the process dies."
read -r -p "[loop] Press ENTER once audio is playing AND the screen is locked..." _

log "watching process '${PKG}' for ${SECS}s..."
start=$(date +%s)
dead_at=""
last_alive="unknown"
while (( $(date +%s) - start < SECS )); do
    if adb shell "pidof $PKG" >/dev/null 2>&1; then
        last_alive=alive
        printf "[loop] t=%ss process ALIVE\n" "$(( $(date +%s) - start ))"
    else
        if [ -z "$dead_at" ]; then
            dead_at=$(( $(date +%s) - start ))
            log "PROCESS DIED at t=${dead_at}s"
        fi
        printf "[loop] t=%ss process DEAD\n" "$(( $(date +%s) - start ))"
    fi
    sleep 5
done

echo ""
echo "=== RESULT ==="
if [ -n "$dead_at" ]; then
    echo "App was killed after ~${dead_at}s with the screen locked."
    echo "=== Why (logcat, filtered to the kill/FGS signals) ==="
    adb logcat -d 2>/dev/null | grep -iE \
        "am_proc_died|am_kill|Force stopping|BackgroundServiceStart|ForegroundService|lowmemorykiller|lru|killing|Process.*(died|killed|crash)|ANR|ActivityManager: Killing|Freezing|freezer|no longer in use|MediaPlaybackService" \
        | tail -80
else
    echo "Process stayed alive the whole ${SECS}s. If audio kept playing, background playback works;"
    echo "if audio stopped but the process lived, it's a pause/resume bug, not a shutdown."
fi

echo ""
echo "=== Last 40 lines mentioning the package or service ==="
adb logcat -d 2>/dev/null | grep -iE "$PKG|MediaPlayback|MediaSession|MediaControls" | tail -40

log "Done. If the dump contains tokens/secrets, redact them before sharing."
