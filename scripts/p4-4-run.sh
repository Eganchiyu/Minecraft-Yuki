#!/usr/bin/env bash
# scripts/p4-4-run.sh —— P4.4 真机验收：经历胶囊真的叫醒 L1，并把反应写回账本。
# 起实验场 :25566（creative）+ 侧车 + planner（wake_enabled=true，真实 LLM），
# 分三幕间隔 135 秒造场景（初遇实体 / 建造候选 / 任务里程碑），让三种经历各自成一批，
# 再由 p4_4_live.py 核对 capsules.jsonl + 侧车账本回写 + 抢占机制。
# 世界分区 MC_WORLD=p4-4-test，不动机主主服。
# 用法: bash scripts/p4-4-run.sh
set -euo pipefail

ROOT=/home/asumi/Minecraft
JAVA=/usr/lib/jvm/java-25-openjdk-amd64/bin/java
PY=/home/asumi/miniconda3/envs/yuki/bin/python
LOG=/tmp/p4-4
FIFO=$LOG/server.in
export MC_WORLD=p4-4-test
export MC_PORT=25566
STATE=$ROOT/planner/state/worlds/$MC_WORLD
CONFIG=$LOG/local.json
STAGE_WAIT=${P44_STAGE_WAIT:-135}

mkdir -p "$LOG"
rm -f "$FIFO"
mkfifo "$FIFO"
: > "$LOG/server.log"
: > "$LOG/sidecar.log"
: > "$LOG/planner.log"

case "$STATE" in
  "$ROOT"/planner/state/worlds/"$MC_WORLD") ;;
  *) echo "[p4-4] 拒绝删除非预期路径: $STATE"; exit 1 ;;
esac
rm -rf "$STATE"

cleanup () {
  echo "[p4-4] 收尾..."
  if : >&3 2>/dev/null; then
    echo "/kill @e[type=minecraft:sheep]" >&3 2>/dev/null || true
    sleep 1
  fi
  for pid in ${PLANNER_PID:-} ${SIDECAR_PID:-} ${SERVER_PID:-}; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  exec 3>&- 2>/dev/null || true
  sleep 3
  rm -f "$FIFO"
  ss -lntp 2>/dev/null | grep -E ':(25566|8790|8791)\b' || echo "[p4-4] 端口已释放"
}
trap cleanup EXIT

ss -lntp 2>/dev/null | grep -E ':(25566|8790|8791)\b' && { echo "[p4-4] 端口被占用，先停掉旧进程"; exit 1; }

# 验收用配置：开真唤醒、5 秒一批、只让经历通道调模型（idle 拉长）
$PY - "$CONFIG" <<'PY'
import json, sys
src = "/home/asumi/Minecraft/configs/local.json"
raw = json.load(open(src, encoding="utf-8"))
raw.setdefault("memory", {})["vector"] = False
raw.setdefault("attention", {}).update({
    "batch_s": 5, "max_fact_age_s": 86400,
    "wake_enabled": True, "floor": 0.35, "wake_gap_s": 120, "top_k": 1,
    "snapshot_enabled": False,
})
raw.setdefault("autonomy", {}).update({
    # 只验经历通道：idle 一开始就压住（否则她会自己跑去砍木头、把注意力全打成 busy）
    "idle_gap_s": 3600, "max_idle_gap_s": 3600, "idle_first_gap_s": 3600,
    "max_calls_per_10min": 12, "daily_self_calls": 200,
})
raw.setdefault("snapshot", {})["enabled"] = False
json.dump(raw, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY

echo "[p4-4] 启动实验场 :25566（creative）"
( cd "$ROOT/server-test" && exec "$JAVA" -Xms1G -Xmx2G -jar server.jar nogui < "$FIFO" ) > "$LOG/server.log" 2>&1 &
SERVER_PID=$!
exec 3> "$FIFO"

for _ in $(seq 1 120); do
  grep -q 'Done (' "$LOG/server.log" && break
  sleep 1
done
grep -q 'Done (' "$LOG/server.log" || { echo "[p4-4] 服务端启动失败，见 $LOG/server.log"; tail -20 "$LOG/server.log"; exit 1; }
echo "[p4-4] 服务端就绪"
echo "/gamerule spawn_monsters false" >&3
echo "/time set day" >&3
echo "/weather clear" >&3
echo "/kill @e[type=!player]" >&3
sleep 2

echo "[p4-4] 启动 sidecar :8790（世界分区 $MC_WORLD）"
( cd "$ROOT/yuki-bot" && exec node sidecar/index.js ) > "$LOG/sidecar.log" 2>&1 &
SIDECAR_PID=$!
for _ in $(seq 1 90); do
  if curl -sf http://127.0.0.1:8790/health 2>/dev/null | grep -q '"ready"'; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:8790/health | grep -q '"ready"' || { echo "[p4-4] bot 未就绪，见 $LOG/sidecar.log"; tail -30 "$LOG/sidecar.log"; exit 1; }
echo "[p4-4] bot 已登录"

echo "[p4-4] 启动 planner :8791（wake_enabled=true）"
( cd "$ROOT/planner" && exec env YUKI_MC_CONFIG="$CONFIG" "$PY" app.py ) > "$LOG/planner.log" 2>&1 &
PLANNER_PID=$!
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8791/health 2>/dev/null | grep -q '"ok"'; then break; fi
  sleep 1
done
curl -sf http://127.0.0.1:8791/health | grep -q '"ok"' || { echo "[p4-4] planner 未就绪，见 $LOG/planner.log"; tail -30 "$LOG/planner.log"; exit 1; }
echo "[p4-4] planner 已就绪"

read -r OX OY OZ USERNAME <<<"$("$PY" - <<'PY'
import json, urllib.request
d = json.loads(urllib.request.urlopen("http://127.0.0.1:8790/state", timeout=5).read())
p = d.get("pos") or {}
print(p.get("x", 0), p.get("y", 64), p.get("z", 0), d.get("username") or "Yuki")
PY
)"
echo "[p4-4] 她的位置：$OX $OY $OZ（$USERNAME）"
sleep 6   # 观察者暖机

echo "[p4-4] 第一幕：初遇实体（等一批打分 + 一次唤醒）"
echo "/summon minecraft:sheep $((OX + 2)) $((OY + 2)) $((OZ + 2))" >&3
sleep "$STAGE_WAIT"

echo "[p4-4] 第二幕：附近有人搭 18 块"
for dy in 0 1; do
  for dx in 0 1 2; do
    for dz in 0 1 2; do
      block=white_wool
      [ "$dy" -eq 1 ] && block=red_wool
      echo "/setblock $((OX - 4 + dx)) $((OY + 6 + dy)) $((OZ - 1 + dz)) minecraft:$block keep" >&3
    done
  done
done
sleep "$STAGE_WAIT"

echo "[p4-4] 第三幕：她自己做完一件事（里程碑）"
echo "/give $USERNAME minecraft:crafting_table 1" >&3
sleep 1
curl -sf -X POST http://127.0.0.1:8790/intention -H 'Content-Type: application/json' \
  -d '{"priority":5,"origin":"debug","steps":[{"skill":"place","args":{"item":"crafting_table"},"on_fail":"abort"}]}' >/dev/null \
  && echo "[p4-4] place 意图已下发" || echo "[p4-4] place 意图下发失败（继续，验收看账本）"
sleep "$STAGE_WAIT"

echo "[p4-4] 收尾场景：清掉她自己放的方块"
echo "/fill $((OX - 4)) $((OY + 6)) $((OZ - 1)) $((OX - 2)) $((OY + 7)) $((OZ + 1)) minecraft:air" >&3

set +e
P44_STATE="$STATE" P44_PLANNER=http://127.0.0.1:8791 P44_SIDECAR=http://127.0.0.1:8790 \
  P44_SIDECAR_LOG="$LOG/sidecar.log" \
  "$PY" "$ROOT/planner/tests/p4_4_live.py"
LIVE_RC=$?
set -e

echo "[p4-4] 验收退出码 $LIVE_RC"
[ "$LIVE_RC" -eq 0 ] || { echo "[p4-4] planner 日志尾部:"; tail -40 "$LOG/planner.log"; }
exit "$LIVE_RC"
