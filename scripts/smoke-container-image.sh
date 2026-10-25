#!/usr/bin/env bash
# Disposable stack only; never connect to an existing PI WEB runtime.
set -euo pipefail
root=$(mktemp -d)
# Git Bash otherwise rewrites container paths (including /bin/sh) as host paths.
if command -v cygpath >/dev/null 2>&1; then
  root=$(cygpath -m "$root")
  export MSYS_NO_PATHCONV=1
fi
export PI_WEB_IMAGE=pi-web:smoke
export PI_WEB_DATA_DIR="$root/data"
export PI_WEB_PROJECTS_DIR="$root/projects"
export PI_WEB_BIND_ADDR=127.0.0.1
export PI_WEB_PORT=18504
mkdir -p "$PI_WEB_DATA_DIR" "$PI_WEB_PROJECTS_DIR"
chmod 777 "$PI_WEB_PROJECTS_DIR"
compose=(docker compose -p "pi-web-smoke-${GITHUB_RUN_ID:-$$}" -f docker/compose.image.yml)
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then "${compose[@]}" logs || true; fi
  "${compose[@]}" down --timeout 15
  # Service-created files belong to UID 1000; remove them through the image.
  docker run --rm --user 0:0 -v "$root:/cleanup" --entrypoint /bin/sh "$PI_WEB_IMAGE" -c 'rm -rf /cleanup/*'
  rmdir "$root"
  exit "$result"
}
trap cleanup EXIT
assert_runtime_ready() {
  "${compose[@]}" exec -T web /usr/local/lib/pi-web-node/bin/node --input-type=module -e '
    const response = await fetch("http://127.0.0.1:8504/api/pi-web/runtime");
    const runtime = await response.json();
    if (!response.ok || runtime.components?.web?.available !== true || runtime.components?.sessiond?.available !== true) process.exit(1);
  '
}
assert_service_interpreters() {
  for service in sessiond web; do
    "${compose[@]}" exec -T "$service" bash -ec '
      service_pid=$(cat /proc/1/task/1/children)
      test "$(readlink "/proc/${service_pid% }/exe")" = /usr/local/lib/pi-web-node/bin/node
    '
  done
}
"${compose[@]}" config --quiet
"${compose[@]}" up -d --wait --wait-timeout 180
assert_runtime_ready
assert_service_interpreters
for service in sessiond web; do
  "${compose[@]}" exec -T "$service" bash -ec '
    test "$(id -u)" = 1000
    test "$HOSTEXEC_MODE" = disabled
    test ! -e /var/run/docker.sock
    grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status
    grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
    result=0
    hostexec true >/dev/null 2>&1 || result=$?
    test "$result" = 69
  '
done
"${compose[@]}" exec -T sessiond bash -ec '
  source /etc/os-release
  test "$ID" = ubuntu && test "$VERSION_ID" = 26.04
  mise --version
  gh --version
  python3 --version
  gcc --version
'
"${compose[@]}" exec -T sessiond mise use --global node@24
"${compose[@]}" exec -T sessiond sh -ec 'test "$(id -u)" = 1000; echo persistent > /data/home/image-smoke; echo project > /projects/image-smoke'
"${compose[@]}" up -d --force-recreate --wait --wait-timeout 180
assert_runtime_ready
assert_service_interpreters
for service in sessiond web; do
  "${compose[@]}" exec -T "$service" node -e 'if (process.versions.node.split(".")[0] !== "24") process.exit(1); console.log(`Development Node: ${process.version}`)'
done
"${compose[@]}" exec -T sessiond /usr/local/lib/pi-web-node/bin/node --input-type=module -e '
  import { createRequire } from "node:module";
  const require = createRequire("/usr/local/lib/node_modules/@jmfederico/pi-web/package.json");
  const pty = require("node-pty");
  const terminal = pty.spawn("/bin/sh", ["-c", "printf image-pty-ok"], { name: "xterm", cols: 80, rows: 24 });
  let output = "";
  terminal.onData(data => output += data);
  terminal.onExit(({ exitCode }) => process.exit(exitCode === 0 && output.includes("image-pty-ok") ? 0 : 1));
  setTimeout(() => process.exit(1), 10000).unref();
'
"${compose[@]}" exec -T web sh -ec 'test "$(cat /data/home/image-smoke)" = persistent; test "$(cat /projects/image-smoke)" = project'
# A successful HTTP status must not hide a disconnected session daemon.
"${compose[@]}" stop sessiond
"${compose[@]}" exec -T web /usr/local/lib/pi-web-node/bin/node --input-type=module -e '
  const response = await fetch("http://127.0.0.1:8504/api/pi-web/runtime");
  const runtime = await response.json();
  if (!response.ok || runtime.components?.web?.available !== true || runtime.components?.sessiond?.available !== false) process.exit(1);
'
if assert_runtime_ready; then
  echo 'Readiness accepted an unavailable session daemon' >&2
  exit 1
fi
printf '%s\n' 'Readiness correctly rejected the unavailable session daemon'
