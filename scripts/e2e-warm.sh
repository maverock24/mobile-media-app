#!/usr/bin/env bash
# Run the Playwright suite against a preview server that is built only when the
# source is newer than the last build. The production build is ~35 s of the ~60 s
# cold gate, so repeating a run, or running a subset, drops to the test time.
#
#   pnpm test:e2e:warm                       # whole suite, builds only if stale
#   pnpm test:e2e:warm tests/e2e/pairs.test.ts
#   pnpm test:e2e:warm --stop                # stop the preview this script started
#
# The preview is left running between invocations, which is what makes the next
# run cheap. A stale build is rebuilt, and the server restarted, so a warm run
# never tests code you have already replaced. Playwright reuses a server that is
# already listening on the port, so plain `pnpm test:e2e` also skips its build
# while this one is up.
set -euo pipefail

PORT="${PW_PORT:-4177}"
BASE="http://127.0.0.1:${PORT}"
PIDFILE="${TMPDIR:-/tmp}/e2e-warm-${PORT}.pid"
BUILD_MARKER="build/index.html"
VITE="node_modules/.bin/vite"
export PUBLIC_GOOGLE_CLIENT_ID="${PUBLIC_GOOGLE_CLIENT_ID:-playwright-google-client-id.apps.googleusercontent.com}"

listening() {
	curl -sf -o /dev/null "${BASE}/"
}

stop_server() {
	if [ -f "$PIDFILE" ]; then
		pid="$(cat "$PIDFILE")"
		kill "$pid" 2>/dev/null || true
		rm -f "$PIDFILE"
		echo "[e2e:warm] stopped the preview on ${BASE}."
	else
		echo "[e2e:warm] no preview recorded in ${PIDFILE}; nothing to stop."
	fi
}

start_server() {
	# Run the vite binary directly: `pnpm preview` leaves an unkillable wrapper
	# behind and the port stays occupied after the script exits.
	setsid "$VITE" preview --host 127.0.0.1 --port "$PORT" >/tmp/e2e-warm-preview.log 2>&1 &
	echo $! >"$PIDFILE"
	for _ in $(seq 1 60); do
		if listening; then return 0; fi
		sleep 1
	done
	echo "[e2e:warm] preview did not come up; see /tmp/e2e-warm-preview.log" >&2
	return 1
}

case "${1:-}" in
--stop)
	stop_server
	exit 0
	;;
esac

stale=1
if [ -f "$BUILD_MARKER" ] && ! find src static package.json svelte.config.js vite.config.ts \
	-newer "$BUILD_MARKER" -print -quit 2>/dev/null | grep -q .; then
	stale=0
fi

if [ "$stale" -eq 1 ]; then
	echo "[e2e:warm] source is newer than ${BUILD_MARKER}; building."
	pnpm build
fi

if listening && [ "$stale" -eq 1 ]; then
	if [ -f "$PIDFILE" ]; then
		echo "[e2e:warm] restarting the preview so it serves the new build."
		stop_server
		sleep 1
	else
		echo "[e2e:warm] WARNING: the preview on ${BASE} was not started by this script and" >&2
		echo "[e2e:warm] WARNING: may predate the build just made. Restart it yourself." >&2
	fi
fi

if ! listening; then
	echo "[e2e:warm] starting the preview on ${BASE}."
	start_server
else
	echo "[e2e:warm] reusing the preview on ${BASE}; the build is up to date."
fi

PW_BASE_URL="$BASE" pnpm exec playwright test "$@"
