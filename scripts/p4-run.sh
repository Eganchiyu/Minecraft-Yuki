#!/usr/bin/env bash
# scripts/p4-run.sh —— P4.2 验收一键跑：起主服（带控制台 FIFO）-> 起 L3 侧车 -> 跑观察者真机验收 -> 全部停掉。
# 不启动 planner：观察者只看结构化事件，不调任何模型。
# 用法: bash scripts/p4-run.sh
set -euo pipefail

ROOT=/home/asumi/Minecraft
JAVA=/usr/lib/jvm/java-25-openjdk-amd64/bin/java
LOG=/tmp/p4
FIFO=$LOG/server.in

mkdir -p "$LOG"
rm -f "$FIFO"
mkfifo "$FIFO"
: > "$LOG/server.log"
: > "$LOG/sidecar.log"

cleanup () {
  echo "[p4] 收尾..."
  if : >&3 2>/dev/null; then
    # 恢复机主存档世界的默认 gamerule（坑 21：26.1 用 snake_case）
    echo "/gamerule spawn_monsters true" >&3 2>/dev/null || true
    sleep 1
  fi
  for pid in ${SIDECAR_PID:-} ${SERVER_PID:-}; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  exec 3>&- 2>/dev/null || true
  sleep 3
  rm -f "$FIFO"
  ss -lntp 2>/dev/null | grep -E ':(25565|8790)\b' || echo "[p4] 端口已释放"
}
trap cleanup EXIT

ss -lntp 2>/dev/null | grep -E ':(25565|8790)\b' && { echo "[p4] 端口被占用，先停掉旧进程"; exit 1; }

echo "[p4] 启动主服 :25565"
( cd "$ROOT/server" && exec "$JAVA" -Xms1G -Xmx2G -jar server.jar nogui < "$FIFO" ) > "$LOG/server.log" 2>&1 &
SERVER_PID=$!
exec 3> "$FIFO"

for _ in $(seq 1 120); do
  grep -q 'Done (' "$LOG/server.log" && break
  sleep 1
done
grep -q 'Done (' "$LOG/server.log" || { echo "[p4] 服务端启动失败，见 $LOG/server.log"; tail -20 "$LOG/server.log"; exit 1; }
echo "[p4] 服务端就绪"

# 固定场景：白天、无天气、不刷野怪（否则新实体候选会被路过的怪刷屏）
echo "/gamerule spawn_monsters false" >&3
echo "/time set day" >&3
echo "/weather clear" >&3
echo "/kill @e[type=!player]" >&3
sleep 2

echo "[p4] 启动 sidecar :8790"
( cd "$ROOT/yuki-bot" && exec node sidecar/index.js ) > "$LOG/sidecar.log" 2>&1 &
SIDECAR_PID=$!

for _ in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8790/health 2>/dev/null | grep -q '"ready"'; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:8790/health | grep -q '"ready"' || { echo "[p4] bot 未就绪，见 $LOG/sidecar.log"; tail -30 "$LOG/sidecar.log"; exit 1; }
echo "[p4] bot 已登录"

set +e
( cd "$ROOT/yuki-bot" && P4_FIFO="$FIFO" node scripts/p4-test.js "--fifo=$FIFO" )
RC=$?
set -e

echo "[p4] 验收退出码 $RC"
if [ "$RC" -ne 0 ]; then echo "[p4] sidecar 日志尾部:"; tail -40 "$LOG/sidecar.log"; fi
exit $RC
