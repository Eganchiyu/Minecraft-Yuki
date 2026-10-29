#!/usr/bin/env bash
# scripts/p2-run.sh —— P2 验收一键跑：起主服（带控制台 FIFO）-> 起 planner -> 起侧车 -> 单测 + 端到端 -> 全部停掉。
# 用法: bash scripts/p2-run.sh
set -euo pipefail

ROOT=/home/asumi/Minecraft
JAVA=/usr/lib/jvm/java-25-openjdk-amd64/bin/java
PY=/home/asumi/miniconda3/envs/yuki/bin/python
LOG=/tmp/p2
FIFO=$LOG/server.in

mkdir -p "$LOG"
rm -f "$FIFO"
mkfifo "$FIFO"
: > "$LOG/server.log"; : > "$LOG/sidecar.log"; : > "$LOG/planner.log"

cleanup () {
  echo "[p2] 收尾..."
  # 把测试用的 gamerule 恢复默认，别把机主的存档世界改坏（坑 21：26.1 是 snake_case）
  if : >&3 2>/dev/null; then
    echo "/gamerule spawn_monsters true" >&3 2>/dev/null || true
    echo "/gamerule keep_inventory false" >&3 2>/dev/null || true
    echo "/difficulty normal" >&3 2>/dev/null || true
    echo "/kill @e[type=minecraft:zombie]" >&3 2>/dev/null || true
    sleep 1
  fi
  for pid in ${SIDECAR_PID:-} ${PLANNER_PID:-} ${SERVER_PID:-}; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  exec 3>&- 2>/dev/null || true
  sleep 3
  rm -f "$FIFO"
  ss -lntp 2>/dev/null | grep -E ':(25565|8790|8791)\b' || echo "[p2] 端口已释放"
}
trap cleanup EXIT

ss -lntp 2>/dev/null | grep -E ':(25565|8790|8791)\b' && { echo "[p2] 端口被占用，先停掉旧进程"; exit 1; }

echo "[p2] 单测：schema / 预算 / 事实 / 修复重试"
( cd "$ROOT" && "$PY" planner/tests/test_p2.py )

echo "[p2] 启动主服 :25565"
( cd "$ROOT/server" && exec "$JAVA" -Xms1G -Xmx2G -jar server.jar nogui < "$FIFO" ) > "$LOG/server.log" 2>&1 &
SERVER_PID=$!
exec 3> "$FIFO"

for i in $(seq 1 120); do
  grep -q 'Done (' "$LOG/server.log" && break
  sleep 1
done
grep -q 'Done (' "$LOG/server.log" || { echo "[p2] 服务端启动失败，见 $LOG/server.log"; tail -20 "$LOG/server.log"; exit 1; }
echo "[p2] 服务端就绪"

echo "[p2] 启动 planner :8791"
( cd "$ROOT/planner" && exec "$PY" app.py ) > "$LOG/planner.log" 2>&1 &
PLANNER_PID=$!

echo "[p2] 启动 sidecar :8790"
( cd "$ROOT/yuki-bot" && exec node sidecar/index.js ) > "$LOG/sidecar.log" 2>&1 &
SIDECAR_PID=$!

for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8790/health 2>/dev/null | grep -q '"ready"'; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:8790/health | grep -q '"ready"' || { echo "[p2] bot 未就绪，见 $LOG/sidecar.log"; tail -30 "$LOG/sidecar.log"; exit 1; }
curl -sf http://127.0.0.1:8791/health >/dev/null || { echo "[p2] planner 未就绪，见 $LOG/planner.log"; tail -30 "$LOG/planner.log"; exit 1; }
echo "[p2] bot 与 planner 已就绪"

set +e
( cd "$ROOT/yuki-bot" && P2_FIFO="$FIFO" node scripts/p2-test.js "--fifo=$FIFO" )
RC=$?
set -e

echo "[p2] 验收退出码 $RC"
echo "[p2] planner 统计: $(curl -s http://127.0.0.1:8791/stats || echo '{}')"
if [ "$RC" -ne 0 ]; then
  echo "[p2] sidecar 日志尾部:"; tail -40 "$LOG/sidecar.log"
  echo "[p2] planner 日志尾部:"; tail -40 "$LOG/planner.log"
fi
exit $RC
