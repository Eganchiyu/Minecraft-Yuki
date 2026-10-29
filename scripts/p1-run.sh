#!/usr/bin/env bash
# scripts/p1-run.sh —— P1 验收一键跑：起主服（带控制台 FIFO）-> 起 L3 侧车 -> 跑纯脚本验收 -> 全部停掉。
# 不启动 planner：P1 是执行器验收，不调任何模型。
# 用法: bash scripts/p1-run.sh
set -euo pipefail

ROOT=/home/asumi/Minecraft
JAVA=/usr/lib/jvm/java-25-openjdk-amd64/bin/java
LOG=/tmp/p1
FIFO=$LOG/server.in

mkdir -p "$LOG"
rm -f "$FIFO"
mkfifo "$FIFO"
: > "$LOG/server.log"; : > "$LOG/sidecar.log"
rm -f "$LOG/sidecar.log"

cleanup () {
  echo "[p1] 收尾..."
  # 把测试用的 gamerule 恢复默认，别把机主的存档世界改坏（坑 21：26.1 是 snake_case）
  if : >&3 2>/dev/null; then
    echo "/gamerule spawn_monsters true" >&3 2>/dev/null || true
    echo "/gamerule keep_inventory false" >&3 2>/dev/null || true
    sleep 1
  fi
  for pid in ${SIDECAR_PID:-} ${SERVER_PID:-}; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  exec 3>&- 2>/dev/null || true
  sleep 3
  rm -f "$FIFO"
  ss -lntp 2>/dev/null | grep -E ':(25565|8790)\b' || echo "[p1] 端口已释放"
}
trap cleanup EXIT

ss -lntp 2>/dev/null | grep -E ':(25565|8790)\b' && { echo "[p1] 端口被占用，先停掉旧进程"; exit 1; }

echo "[p1] 启动主服 :25565"
( cd "$ROOT/server" && exec "$JAVA" -Xms1G -Xmx2G -jar server.jar nogui < "$FIFO" ) > "$LOG/server.log" 2>&1 &
SERVER_PID=$!
exec 3> "$FIFO"

for i in $(seq 1 120); do
  grep -q 'Done (' "$LOG/server.log" && break
  sleep 1
done
grep -q 'Done (' "$LOG/server.log" || { echo "[p1] 服务端启动失败，见 $LOG/server.log"; tail -20 "$LOG/server.log"; exit 1; }
echo "[p1] 服务端就绪"

# 测试世界固定为白天、不刷怪、无天气，保证可复现
echo "/gamerule spawn_monsters false" >&3
echo "/gamerule keep_inventory true" >&3
echo "/time set day" >&3
echo "/weather clear" >&3
sleep 1

echo "[p1] 启动 sidecar :8790"
( cd "$ROOT/yuki-bot" && exec node sidecar/index.js ) > "$LOG/sidecar.log" 2>&1 &
SIDECAR_PID=$!

for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8790/health 2>/dev/null | grep -q '"ready"'; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:8790/health | grep -q '"ready"' || { echo "[p1] bot 未就绪，见 $LOG/sidecar.log"; tail -30 "$LOG/sidecar.log"; exit 1; }
echo "[p1] bot 已登录"

set +e
( cd "$ROOT/yuki-bot" && P1_FIFO="$FIFO" node scripts/p1-test.js "--fifo=$FIFO" )
RC=$?
set -e

echo "[p1] 验收退出码 $RC"
if [ "$RC" -ne 0 ]; then echo "[p1] sidecar 日志尾部:"; tail -40 "$LOG/sidecar.log"; fi
exit $RC
