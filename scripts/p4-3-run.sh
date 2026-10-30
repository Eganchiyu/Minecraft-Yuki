#!/usr/bin/env bash
# scripts/p4-3-run.sh —— P4.3 真机验收：主服 + 侧车 + planner（注意力 Shadow）。
# 第一阶段 p4-test 造真实事件，侧车把候选写成事实行；
# 第二阶段 planner 按批打分写 decisions.jsonl，再用 p4_3_live.py 核对。
# 用隔离实验场 :25566 + 独立世界分区（MC_WORLD=p4-3-test），
# 既不动机主主服的世界地形，也不动主服的 seen/记忆/经历账本。
# 用法: bash scripts/p4-3-run.sh
set -euo pipefail

ROOT=/home/asumi/Minecraft
JAVA=/usr/lib/jvm/java-25-openjdk-amd64/bin/java
PY=/home/asumi/miniconda3/envs/yuki/bin/python
LOG=/tmp/p4-3
FIFO=$LOG/server.in
export MC_WORLD=p4-3-test
export MC_PORT=25566
STATE=$ROOT/planner/state/worlds/$MC_WORLD
CONFIG=$LOG/local.json

mkdir -p "$LOG"
rm -f "$FIFO"
mkfifo "$FIFO"
: > "$LOG/server.log"
: > "$LOG/sidecar.log"
: > "$LOG/planner.log"

# 只删本脚本自己的世界分区；绝对路径核对过才删
case "$STATE" in
  "$ROOT"/planner/state/worlds/"$MC_WORLD") ;;
  *) echo "[p4-3] 拒绝删除非预期路径: $STATE"; exit 1 ;;
esac
rm -rf "$STATE"

cleanup () {
  echo "[p4-3] 收尾..."
  if : >&3 2>/dev/null; then
    echo "/gamerule spawn_monsters true" >&3 2>/dev/null || true
    sleep 1
  fi
  for pid in ${PLANNER_PID:-} ${SIDECAR_PID:-} ${SERVER_PID:-}; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  exec 3>&- 2>/dev/null || true
  sleep 3
  rm -f "$FIFO"
  ss -lntp 2>/dev/null | grep -E ':(25566|8790|8791)\b' || echo "[p4-3] 端口已释放"
}
trap cleanup EXIT

ss -lntp 2>/dev/null | grep -E ':(25566|8790|8791)\b' && { echo "[p4-3] 端口被占用，先停掉旧进程"; exit 1; }

# 验收用配置：不加载 embedding（省内存/启动快）、5 秒一批、不主动调模型（只看注意力）
$PY - "$CONFIG" <<'PY'
import json, sys
src = "/home/asumi/Minecraft/configs/local.json"
raw = json.load(open(src, encoding="utf-8"))
raw.setdefault("memory", {})["vector"] = False
raw.setdefault("attention", {}).update({
    "batch_s": 5, "max_fact_age_s": 86400,
    "wake_enabled": False,         # 这一轮验的是 P4.3 Shadow：只写 decision，不叫醒 L1
})
raw.setdefault("autonomy", {}).update({
    "max_calls_per_10min": 0,      # 只跑注意力，不让 idle tick 调模型
    "idle_gap_s": 3600,
    "max_idle_gap_s": 3600,
})
json.dump(raw, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY

echo "[p4-3] 启动实验场 :25566（creative）"
( cd "$ROOT/server-test" && exec "$JAVA" -Xms1G -Xmx2G -jar server.jar nogui < "$FIFO" ) > "$LOG/server.log" 2>&1 &
SERVER_PID=$!
exec 3> "$FIFO"

for _ in $(seq 1 120); do
  grep -q 'Done (' "$LOG/server.log" && break
  sleep 1
done
grep -q 'Done (' "$LOG/server.log" || { echo "[p4-3] 服务端启动失败，见 $LOG/server.log"; tail -20 "$LOG/server.log"; exit 1; }
echo "[p4-3] 服务端就绪"

echo "/gamerule spawn_monsters false" >&3
echo "/time set day" >&3
echo "/weather clear" >&3
echo "/kill @e[type=!player]" >&3
sleep 2

echo "[p4-3] 启动 sidecar :8790（世界分区 $MC_WORLD）"
( cd "$ROOT/yuki-bot" && exec node sidecar/index.js ) > "$LOG/sidecar.log" 2>&1 &
SIDECAR_PID=$!
for _ in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8790/health 2>/dev/null | grep -q '"ready"'; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:8790/health | grep -q '"ready"' || { echo "[p4-3] bot 未就绪，见 $LOG/sidecar.log"; tail -30 "$LOG/sidecar.log"; exit 1; }
echo "[p4-3] bot 已登录"

echo "[p4-3] 启动 planner :8791（注意力 Shadow，5 秒一批）"
( cd "$ROOT/planner" && exec env YUKI_MC_CONFIG="$CONFIG" "$PY" app.py ) > "$LOG/planner.log" 2>&1 &
PLANNER_PID=$!
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8791/health 2>/dev/null | grep -q '"ok"'; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:8791/health | grep -q '"ok"' || { echo "[p4-3] planner 未就绪，见 $LOG/planner.log"; tail -30 "$LOG/planner.log"; exit 1; }
echo "[p4-3] planner 已就绪"

set +e
( cd "$ROOT/yuki-bot" && P4_FIFO="$FIFO" node scripts/p4-test.js "--fifo=$FIFO" )
SIDECAR_RC=$?
Y4_FACTS="$STATE/experiences.jsonl" Y4_DECISIONS="$STATE/decisions.jsonl" \
  Y4_PLANNER=http://127.0.0.1:8791 Y4_WAIT_S=120 \
  "$PY" "$ROOT/planner/tests/p4_3_live.py"
ATTENTION_RC=$?
set -e

echo "[p4-3] 侧车验收退出码 $SIDECAR_RC，注意力验收退出码 $ATTENTION_RC"
if [ "$SIDECAR_RC" -ne 0 ]; then echo "[p4-3] sidecar 日志尾部:"; tail -40 "$LOG/sidecar.log"; fi
if [ "$ATTENTION_RC" -ne 0 ]; then echo "[p4-3] planner 日志尾部:"; tail -40 "$LOG/planner.log"; fi
[ "$SIDECAR_RC" -eq 0 ] && [ "$ATTENTION_RC" -eq 0 ]
