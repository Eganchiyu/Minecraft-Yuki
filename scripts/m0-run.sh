#!/usr/bin/env bash
# scripts/m0-run.sh —— M0 端到端验收一键跑：起服 -> 预置环境 -> 起服务 -> 跑验收 -> 全部停掉。
# 用法: bash scripts/m0-run.sh
set -euo pipefail

ROOT=/home/asumi/Minecraft
JAVA=/usr/lib/jvm/java-25-openjdk-amd64/bin/java
PY=/home/asumi/miniconda3/envs/yuki/bin/python
LOG=/tmp/m0
FIFO=$LOG/server.in

mkdir -p "$LOG"
rm -f "$FIFO"
mkfifo "$FIFO"
: > "$LOG/server.log"; : > "$LOG/sidecar.log"; : > "$LOG/planner.log"

cleanup () {
  echo "[m0] 收尾..."
  for pid in ${PLANNER_PID:-} ${SIDECAR_PID:-} ${SERVER_PID:-}; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  exec 3>&- 2>/dev/null || true
  sleep 3
  rm -f "$FIFO"
  ss -lntp 2>/dev/null | grep -E ':(25565|8790|8791)\b' || echo "[m0] 端口已释放"
}
trap cleanup EXIT

ss -lntp 2>/dev/null | grep -E ':(25565|8790|8791)\b' && { echo "[m0] 端口被占用，先停掉旧进程"; exit 1; }

echo "[m0] 启动主服 :25565"
( cd "$ROOT/server" && exec "$JAVA" -Xms1G -Xmx2G -jar server.jar nogui < "$FIFO" ) > "$LOG/server.log" 2>&1 &
SERVER_PID=$!
exec 3> "$FIFO"

for i in $(seq 1 120); do
  grep -q 'Done (' "$LOG/server.log" && break
  sleep 1
done
grep -q 'Done (' "$LOG/server.log" || { echo "[m0] 服务端启动失败，见 $LOG/server.log"; tail -20 "$LOG/server.log"; exit 1; }
echo "[m0] 服务端就绪"

echo "[m0] 启动 planner :8791"
( cd "$ROOT/planner" && exec "$PY" app.py ) > "$LOG/planner.log" 2>&1 &
PLANNER_PID=$!

echo "[m0] 启动 sidecar :8790"
( cd "$ROOT/yuki-bot" && exec node sidecar/index.js ) > "$LOG/sidecar.log" 2>&1 &
SIDECAR_PID=$!

for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8790/health 2>/dev/null | grep -q '"ready"'; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:8790/health | grep -q '"ready"' || { echo "[m0] bot 未就绪，见 $LOG/sidecar.log"; tail -20 "$LOG/sidecar.log"; exit 1; }
echo "[m0] bot 已登录"

read -r X Y Z < <(node -e "fetch('http://127.0.0.1:8790/state').then(r=>r.json()).then(s=>{const p=s.pos;console.log(Math.round(p.x),Math.round(p.y),Math.round(p.z))})")
echo "[m0] Yuki 在 $X $Y $Z，预置工具与石头"

echo "/give Yuki minecraft:wooden_pickaxe 1" >&3
echo "/fill $((X + 2)) $Y $((Z - 1)) $((X + 4)) $((Y + 1)) $((Z + 1)) minecraft:stone" >&3
sleep 2

echo "[m0] 跑验收脚本"
set +e
( cd "$ROOT/yuki-bot" && node scripts/m0-test.js )
RC=$?
set -e

echo "[m0] 验收退出码 $RC"
echo "[m0] planner 调用统计: $(curl -s http://127.0.0.1:8791/stats || echo '{}')"
exit $RC
