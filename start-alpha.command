#!/bin/zsh
set -euo pipefail

ALPHA_DIR="$(cd "$(dirname "$0")" && pwd)"
ALPHA_WORK_DIR="$ALPHA_DIR/work"
ALPHA_PID_FILE="$ALPHA_WORK_DIR/alpha.pid"
ALPHA_LOG_FILE="/tmp/alpha-web.stdout.log"
ALPHA_ERROR_LOG_FILE="/tmp/alpha-web.stderr.log"
ALPHA_OLLAMA_PID_FILE="$ALPHA_WORK_DIR/ollama.pid"
ALPHA_TOOL_PID_FILE="$ALPHA_WORK_DIR/alpha-tool.pid"
ALPHA_TOOL_LOG_FILE="/tmp/alpha-tool.stdout.log"
ALPHA_TOOL_ERROR_LOG_FILE="/tmp/alpha-tool.stderr.log"
ALPHA_OLLAMA_LOG_FILE="/tmp/alpha-ollama.stdout.log"
ALPHA_OLLAMA_ERROR_LOG_FILE="/tmp/alpha-ollama.stderr.log"
ALPHA_OLLAMA_HOST="127.0.0.1:11435"
ALPHA_OLLAMA_URL="http://$ALPHA_OLLAMA_HOST"
ALPHA_OLLAMA_MODELS_DIR="$ALPHA_DIR/models/ollama"
ALPHA_SHARED_NODE_RUNTIME="/Users/ratchanonsakdamanee/Library/Application Support/Alpha Node Runtime"
ALPHA_SHARED_NODE_MODULES="$ALPHA_SHARED_NODE_RUNTIME/node_modules"
ALPHA_VITE_CACHE_DIR="/Users/ratchanonsakdamanee/Library/Caches/Alpha/vite"
ALPHA_VITE_CACHE_STAMP="$ALPHA_VITE_CACHE_DIR/.alpha-runtime-manifest.sha256"
ALPHA_CODEX_NODE_DIR="/Users/ratchanonsakdamanee/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
ALPHA_CODEX_FALLBACK_DIR="/Users/ratchanonsakdamanee/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback"
ALPHA_URL="http://localhost:3000"
ALPHA_WEB_SERVICE="com.alpha.local.web"
ALPHA_OLLAMA_SERVICE="com.alpha.local.ollama"
ALPHA_TOOL_SERVICE="com.alpha.local.tools"

alpha_health_ready() {
  local health_json
  health_json="$(curl --max-time 5 -fsS "$ALPHA_URL/api/health" 2>/dev/null || true)"
  [[ "$health_json" == *'"ollama_connected":true'* && "$health_json" == *'"tool_service":{"app_version"'* && "$health_json" == *'"storage_connected":true'* && "$health_json" == *'"storage_root":"'"$ALPHA_DIR"'"'* ]]
}

ollama_ready() {
  curl --max-time 5 -fsS "$ALPHA_OLLAMA_URL/api/tags" >/dev/null 2>&1
}

warm_primary_model() {
  curl --max-time 120 -fsS "$ALPHA_OLLAMA_URL/api/generate" \
    -H 'Content-Type: application/json' \
    -d '{"model":"qwen3.5:9b","prompt":"","stream":false,"keep_alive":-1}' >/dev/null 2>&1
}

tool_ready() {
  local health_json
  health_json="$(curl --max-time 5 -fsS -H "Authorization: Bearer $ALPHA_TOOL_TOKEN" http://127.0.0.1:4317/v1/health 2>/dev/null || true)"
  [[ "$health_json" == *'"app_version":"'"$ALPHA_APP_VERSION"'"'* && "$health_json" == *'"storage_connected":true'* && "$health_json" == *'"storage_root":"'"$ALPHA_DIR"'"'* && "$health_json" == *'"tool_supervisor":{"supervised":true'* ]]
}

stop_pid_tree() {
  local target_pid="$1"
  local child_pid
  for child_pid in $(pgrep -P "$target_pid" 2>/dev/null || true); do
    stop_pid_tree "$child_pid"
  done
  kill "$target_pid" 2>/dev/null || true
}

pid_belongs_to_alpha() {
  local target_pid="$1"
  local process_directory
  process_directory="$(lsof -a -p "$target_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  local process_command
  process_command="$(ps -p "$target_pid" -o command= 2>/dev/null || true)"
  [[ "$process_directory" == "$ALPHA_DIR" || "$process_command" == *"$ALPHA_DIR"* ]]
}

cd "$ALPHA_DIR"
ALPHA_APP_VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$ALPHA_DIR/package.json" | head -n 1)"
if [[ -z "$ALPHA_APP_VERSION" ]]; then
  echo "อ่านเวอร์ชัน Alpha จาก package.json ไม่สำเร็จ"
  exit 1
fi
if [[ -f "$ALPHA_DIR/.alpha-external-storage" ]]; then
  ALPHA_EXPECTED_VOLUME_UUID="$(sed -n 's/^volume_uuid=//p' "$ALPHA_DIR/.alpha-external-storage" | head -n 1)"
  ALPHA_VOLUME_DEVICE="$(df -P "$ALPHA_DIR" | awk 'END { print $1 }')"
  ALPHA_CURRENT_VOLUME_UUID="$(diskutil info "$ALPHA_VOLUME_DEVICE" 2>/dev/null | sed -n 's/^[[:space:]]*Volume UUID:[[:space:]]*//p' | head -n 1)"
  if [[ -z "$ALPHA_CURRENT_VOLUME_UUID" || "$ALPHA_CURRENT_VOLUME_UUID" != "$ALPHA_EXPECTED_VOLUME_UUID" ]]; then
    echo "ไม่พบ External HDD petong ตัวที่ใช้เก็บอัลฟ่า กรุณาเสียบใหม่แล้วลองอีกครั้ง"
    read -r "?กด Enter เพื่อปิดหน้าต่าง..."
    exit 1
  fi
fi
mkdir -p "$ALPHA_WORK_DIR" "$ALPHA_OLLAMA_MODELS_DIR"
if [[ ! -w "$ALPHA_DIR" ]]; then
  echo "External HDD เปิดแบบอ่านอย่างเดียว อัลฟ่าไม่สามารถบันทึกข้อมูลได้"
  read -r "?กด Enter เพื่อปิดหน้าต่าง..."
  exit 1
fi
export OLLAMA_HOST="$ALPHA_OLLAMA_HOST"
export OLLAMA_MODELS="$ALPHA_OLLAMA_MODELS_DIR"

if command -v ollama >/dev/null 2>&1; then
  ALPHA_OLLAMA_BIN="$(command -v ollama)"
elif [[ -x "/opt/homebrew/bin/ollama" ]]; then
  ALPHA_OLLAMA_BIN="/opt/homebrew/bin/ollama"
else
  echo "ยังไม่พบ Ollama กรุณาติดตั้งจาก https://ollama.com/download/mac"
  read -r "?กด Enter เพื่อปิดหน้าต่าง..."
  exit 1
fi

if ! ollama_ready; then
  echo "กำลังเปิด Ollama..."
  launchctl remove "$ALPHA_OLLAMA_SERVICE" >/dev/null 2>&1 || true
  launchctl submit -l "$ALPHA_OLLAMA_SERVICE" -o "$ALPHA_OLLAMA_LOG_FILE" -e "$ALPHA_OLLAMA_ERROR_LOG_FILE" -- /bin/zsh -c 'export OLLAMA_HOST="$1" OLLAMA_MODELS="$2"; exec "$3" serve' alpha "$ALPHA_OLLAMA_HOST" "$ALPHA_OLLAMA_MODELS_DIR" "$ALPHA_OLLAMA_BIN"
  for _ in {1..30}; do
    ollama_ready && break
    sleep 1
  done
fi

if ! ollama_ready; then
  echo "เปิด Ollama ไม่สำเร็จ ดูรายละเอียดที่ $ALPHA_OLLAMA_ERROR_LOG_FILE"
  read -r "?กด Enter เพื่อปิดหน้าต่าง..."
  exit 1
fi

if ! "$ALPHA_OLLAMA_BIN" list | awk '{print $1}' | grep -q '^qwen3.5:9b$'; then
  echo "กำลังดาวน์โหลด Qwen3.5 9B รุ่นหลักครั้งแรก (ประมาณ 6.6GB)..."
  "$ALPHA_OLLAMA_BIN" pull qwen3.5:9b
fi

if ! "$ALPHA_OLLAMA_BIN" list | awk '{print $1}' | grep -q '^qwen3:4b-instruct$'; then
  echo "กำลังดาวน์โหลด Qwen3 4B Instruct สำหรับโหมดเร็ว..."
  "$ALPHA_OLLAMA_BIN" pull qwen3:4b-instruct
fi

echo "กำลังเตรียมสมองหลักให้อยู่ในโหมด Standby..."
if ! warm_primary_model; then
  echo "โหลด Qwen3.5 9B เข้า RAM ไม่สำเร็จ กรุณาตรวจ Ollama และพื้นที่ RAM"
  exit 1
fi

if command -v npm >/dev/null 2>&1; then
  ALPHA_PACKAGE_RUNNER=(npm)
  ALPHA_PACKAGE_RUNNER_NAME="npm"
elif [[ -x "$ALPHA_CODEX_NODE_DIR/node" && -x "$ALPHA_CODEX_FALLBACK_DIR/pnpm" ]]; then
  export PATH="$ALPHA_CODEX_NODE_DIR:$ALPHA_CODEX_FALLBACK_DIR:$PATH"
  ALPHA_PACKAGE_RUNNER=(pnpm)
  ALPHA_PACKAGE_RUNNER_NAME="pnpm"
else
  echo "ยังไม่พบ Node.js กรุณาติดตั้งจาก https://nodejs.org"
  read -r "?กด Enter เพื่อปิดหน้าต่าง..."
  exit 1
fi

ALPHA_RUNTIME_NEEDS_INSTALL=false
for ALPHA_MANIFEST in package.json package-lock.json pnpm-lock.yaml pnpm-workspace.yaml; do
  if [[ -f "$ALPHA_DIR/$ALPHA_MANIFEST" ]] && ! cmp -s "$ALPHA_DIR/$ALPHA_MANIFEST" "$ALPHA_SHARED_NODE_RUNTIME/$ALPHA_MANIFEST"; then
    ALPHA_RUNTIME_NEEDS_INSTALL=true
  fi
done
if [[ ! -d "$ALPHA_SHARED_NODE_MODULES" ]]; then
  ALPHA_RUNTIME_NEEDS_INSTALL=true
fi

if [[ "$ALPHA_RUNTIME_NEEDS_INSTALL" == true ]]; then
  echo "กำลังเตรียม Node dependency runtime กลางบน Mac..."
  mkdir -p "$ALPHA_SHARED_NODE_RUNTIME"
  for ALPHA_MANIFEST in package.json package-lock.json pnpm-lock.yaml pnpm-workspace.yaml; do
    [[ -f "$ALPHA_DIR/$ALPHA_MANIFEST" ]] && cp "$ALPHA_DIR/$ALPHA_MANIFEST" "$ALPHA_SHARED_NODE_RUNTIME/$ALPHA_MANIFEST"
  done
  if [[ "$ALPHA_PACKAGE_RUNNER_NAME" == "pnpm" ]]; then
    (cd "$ALPHA_SHARED_NODE_RUNTIME" && CI=true "${ALPHA_PACKAGE_RUNNER[@]}" install --frozen-lockfile)
  else
    (cd "$ALPHA_SHARED_NODE_RUNTIME" && "${ALPHA_PACKAGE_RUNNER[@]}" install)
  fi
fi

if [[ -L "$ALPHA_DIR/node_modules" && "$(readlink "$ALPHA_DIR/node_modules")" != "$ALPHA_SHARED_NODE_MODULES" ]]; then
  unlink "$ALPHA_DIR/node_modules"
fi
if [[ ! -e "$ALPHA_DIR/node_modules" ]]; then
  ln -s "$ALPHA_SHARED_NODE_MODULES" "$ALPHA_DIR/node_modules"
fi
if [[ ! -d "$ALPHA_DIR/node_modules" ]]; then
  echo "Node dependency runtime กลางไม่พร้อมใช้งาน: $ALPHA_SHARED_NODE_RUNTIME"
  read -r "?กด Enter เพื่อปิดหน้าต่าง..."
  exit 1
fi

# Vinext/Vite keeps optimized React Server Component bundles outside the project.
# Reusing those bundles after a dependency change can make the web server fail with
# "A module cannot have multiple default exports". Invalidate only Alpha's derived
# Vite cache when the dependency manifests change; user data and project files are
# never touched.
ALPHA_RUNTIME_MANIFEST_HASH="$({
  for ALPHA_MANIFEST in package.json package-lock.json pnpm-lock.yaml pnpm-workspace.yaml; do
    [[ -f "$ALPHA_DIR/$ALPHA_MANIFEST" ]] && shasum -a 256 "$ALPHA_DIR/$ALPHA_MANIFEST"
  done
} | shasum -a 256 | awk '{print $1}')"
ALPHA_CACHED_MANIFEST_HASH=""
if [[ -f "$ALPHA_VITE_CACHE_STAMP" ]]; then
  ALPHA_CACHED_MANIFEST_HASH="$(<"$ALPHA_VITE_CACHE_STAMP")"
fi
if [[ "$ALPHA_RUNTIME_MANIFEST_HASH" != "$ALPHA_CACHED_MANIFEST_HASH" ]]; then
  if [[ "$ALPHA_VITE_CACHE_DIR" != "/Users/ratchanonsakdamanee/Library/Caches/Alpha/vite" ]]; then
    echo "พาธ cache ของ Alpha ไม่ถูกต้อง จึงหยุดเพื่อป้องกันการลบผิดตำแหน่ง"
    exit 1
  fi
  echo "กำลังรีเฟรช cache ของหน้าเว็บหลัง dependency เปลี่ยน..."
  rm -rf -- "$ALPHA_VITE_CACHE_DIR"
  mkdir -p "$ALPHA_VITE_CACHE_DIR"
  print -r -- "$ALPHA_RUNTIME_MANIFEST_HASH" > "$ALPHA_VITE_CACHE_STAMP"
fi

if [[ ! -f "$ALPHA_DIR/.dev.vars" ]]; then
  cp "$ALPHA_DIR/.dev.vars.example" "$ALPHA_DIR/.dev.vars"
  echo "สร้างไฟล์ตั้งค่า local แล้ว"
fi

ALPHA_TOOL_TOKEN="$(sed -n 's/^ALPHA_TOOL_TOKEN=//p' "$ALPHA_DIR/.dev.vars" | head -n 1 | tr -d '[:space:]')"
if [[ ${#ALPHA_TOOL_TOKEN} -ne 64 || "$ALPHA_TOOL_TOKEN" == *[^0-9a-fA-F]* ]]; then
  ALPHA_TOOL_TOKEN="$(openssl rand -hex 32)"
  if grep -q '^ALPHA_TOOL_TOKEN=' "$ALPHA_DIR/.dev.vars"; then
    sed -i '' "s/^ALPHA_TOOL_TOKEN=.*/ALPHA_TOOL_TOKEN=$ALPHA_TOOL_TOKEN/" "$ALPHA_DIR/.dev.vars"
  else
    echo "ALPHA_TOOL_TOKEN=$ALPHA_TOOL_TOKEN" >> "$ALPHA_DIR/.dev.vars"
  fi
fi
if ! grep -q '^ALPHA_TOOL_BASE_URL=' "$ALPHA_DIR/.dev.vars"; then
  echo 'ALPHA_TOOL_BASE_URL=http://127.0.0.1:4317' >> "$ALPHA_DIR/.dev.vars"
fi
if grep -q '^OLLAMA_BASE_URL=' "$ALPHA_DIR/.dev.vars"; then
  sed -i '' 's#^OLLAMA_BASE_URL=.*#OLLAMA_BASE_URL=http://127.0.0.1:11435#' "$ALPHA_DIR/.dev.vars"
else
  echo 'OLLAMA_BASE_URL=http://127.0.0.1:11435' >> "$ALPHA_DIR/.dev.vars"
fi
chmod 600 "$ALPHA_DIR/.dev.vars"

if command -v node >/dev/null 2>&1; then
  ALPHA_NODE_BIN="$(command -v node)"
elif [[ -x "$ALPHA_CODEX_NODE_DIR/node" ]]; then
  ALPHA_NODE_BIN="$ALPHA_CODEX_NODE_DIR/node"
else
  echo "ยังไม่พบ Node.js สำหรับเปิด Alpha Tool Service"
  read -r "?กด Enter เพื่อปิดหน้าต่าง..."
  exit 1
fi

# The generated Ticket Bot is executed from the installed learned-skill copy,
# not directly from templates/. Keep that runtime copy on the exact app version
# before deciding whether an already-running Tool Service can be reused.
"$ALPHA_NODE_BIN" "$ALPHA_DIR/scripts/sync-bundled-skills.mjs" "$ALPHA_DIR"

if ! tool_ready; then
  launchctl remove "$ALPHA_TOOL_SERVICE" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    ! lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.1
  done
  if lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
    for ALPHA_STALE_TOOL_PID in $(lsof -nP -iTCP:4317 -sTCP:LISTEN -t 2>/dev/null || true); do
      ALPHA_STALE_TOOL_COMMAND="$(ps -p "$ALPHA_STALE_TOOL_PID" -o command= 2>/dev/null || true)"
      if [[ "$ALPHA_STALE_TOOL_COMMAND" == *"tool-service/server.mjs"* || "$ALPHA_STALE_TOOL_COMMAND" == *"tool-service/supervisor.mjs"* ]]; then stop_pid_tree "$ALPHA_STALE_TOOL_PID"; fi
    done
    sleep 0.2
    if lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "พอร์ต 4317 ถูกบริการอื่นใช้งานอยู่ กรุณาปิดโปรแกรมนั้นก่อน"
      read -r "?กด Enter เพื่อปิดหน้าต่าง..."
      exit 1
    fi
  fi
  echo "กำลังเปิดบริการเครื่องมือของอัลฟ่า..."
  "$ALPHA_NODE_BIN" --check "$ALPHA_DIR/tool-service/supervisor.mjs"
  launchctl submit -l "$ALPHA_TOOL_SERVICE" -o "$ALPHA_TOOL_LOG_FILE" -e "$ALPHA_TOOL_ERROR_LOG_FILE" -- "$ALPHA_NODE_BIN" "$ALPHA_DIR/tool-service/supervisor.mjs" "$ALPHA_DIR"
  for _ in {1..30}; do
    tool_ready && break
    sleep 0.5
  done
fi

if ! tool_ready; then
  echo "เปิดบริการเครื่องมือไม่สำเร็จ ดูรายละเอียดที่ $ALPHA_TOOL_ERROR_LOG_FILE"
  read -r "?กด Enter เพื่อปิดหน้าต่าง..."
  exit 1
fi

if alpha_health_ready; then
  echo "อัลฟ่าทำงานอยู่แล้ว"
else
  while IFS= read -r ALPHA_STALE_PID; do
    [[ -z "$ALPHA_STALE_PID" ]] && continue
    if pid_belongs_to_alpha "$ALPHA_STALE_PID"; then
      stop_pid_tree "$ALPHA_STALE_PID"
    fi
  done < <(lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null || true)
  sleep 0.3
  if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "พอร์ต 3000 ถูกโปรแกรมอื่นใช้งานอยู่ กรุณาปิดโปรแกรมนั้นก่อน"
    read -r "?กด Enter เพื่อปิดหน้าต่าง..."
    exit 1
  fi
  launchctl remove "$ALPHA_WEB_SERVICE" >/dev/null 2>&1 || true
  launchctl submit -l "$ALPHA_WEB_SERVICE" -o "$ALPHA_LOG_FILE" -e "$ALPHA_ERROR_LOG_FILE" -- /bin/zsh -c 'export WRANGLER_LOG_PATH="$1/.wrangler/wrangler.log"; cd "$1" && exec "$2" "$1/node_modules/vinext/dist/cli.js" dev' alpha "$ALPHA_DIR" "$ALPHA_NODE_BIN"
fi

echo "กำลังเปิดอัลฟ่า..."
ALPHA_BROWSER_OPENED=false
ALPHA_STABLE_HEALTH_COUNT=0
for _ in {1..120}; do
  if alpha_health_ready; then
    if [[ "$ALPHA_BROWSER_OPENED" == false ]]; then
      open "$ALPHA_URL"
      ALPHA_BROWSER_OPENED=true
      ALPHA_STABLE_HEALTH_COUNT=0
      # Chrome requests the client bundle a moment after the first HTML page.
      # Give that compile time to begin before measuring consecutive readiness.
      sleep 8
    else
      ALPHA_STABLE_HEALTH_COUNT=$((ALPHA_STABLE_HEALTH_COUNT + 1))
      if (( ALPHA_STABLE_HEALTH_COUNT >= 5 )); then
        exit 0
      fi
    fi
  else
    ALPHA_STABLE_HEALTH_COUNT=0
  fi
  sleep 1
done

echo "เปิดอัลฟ่าไม่สำเร็จ ดูรายละเอียดที่ $ALPHA_ERROR_LOG_FILE"
read -r "?กด Enter เพื่อปิดหน้าต่าง..."
exit 1
