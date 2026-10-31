#!/usr/bin/env bash
# scripts/world-join.sh —— 统一入口：让 Yuki 以完整形态加入「任意一台」MC 服务器。
#
# 与 world-up.sh 的区别：world-up.sh 在本地起服（:25565），这个脚本不起服务端，
# 只把三层进程指向你给的对端地址；可选再起一台虚拟屏客户端给她当眼睛。
#
# 形态：
#   planner :8791（L1 人格/记忆 + L2 规划）  +  sidecar :8790（L3 身体，mineflayer）
#   --camera 时额外：Xvfb :98 + 第二离线账号客户端（spectate 跟随）+ 截图/视觉（P5）
#
# 用法:
#   bash scripts/world-join.sh play.example.com:25565
#   bash scripts/world-join.sh 192.168.31.110:25565 myserver --camera
#   bash scripts/world-join.sh host:port [世界简称] [--camera] [--no-snapshot] \
#        [--user=Yuki] [--cam-user=YukiCam] [--display=:98] [--size=1280x720] [--mem=1200M]
# 停止: bash scripts/world-down.sh
#
# 前置（对端服务器侧）：
#   * 版本必须是 26.1（Protocol 775）
#   * 离线服（online-mode=false），白名单里放 Yuki 与 YukiCam 两个名字
#   * --camera 时：YukiCam 要有 OP（/gamemode spectator + /spectate 都要权限 2）
set -euo pipefail

ROOT=/home/asumi/Minecraft
JAVA=/usr/lib/jvm/java-25-openjdk-amd64/bin/java
PY=/home/asumi/miniconda3/envs/yuki/bin/python
RUN=/tmp/yuki-world
DISPLAY_NUM=:98
SIZE=1280x720
MEM=1200M
CAMERA=0
SNAPSHOT=1
BOT_USER=""
CAM_USER=YukiCam
TARGET=${1:-}

if [ -z "$TARGET" ]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
shift

WORLD=""
for arg in "$@"; do
  case "$arg" in
    --camera) CAMERA=1 ;;
    --no-snapshot) SNAPSHOT=0 ;;
    --user=*) BOT_USER=${arg#*=} ;;
    --cam-user=*) CAM_USER=${arg#*=} ;;
    --display=*) DISPLAY_NUM=${arg#*=} ;;
    --size=*) SIZE=${arg#*=} ;;
    --mem=*) MEM=${arg#*=} ;;
    --*) echo "[join] 未知参数: $arg"; exit 2 ;;
    *) WORLD=$arg ;;
  esac
done

HOST=${TARGET%:*}
PORT=${TARGET##*:}
[ "$HOST" = "$TARGET" ] && PORT=25565
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "[join] 端口不合法: $TARGET"; exit 2
fi
if [ -z "$WORLD" ]; then
  # 世界分区名：只留字母数字与下划线，避免把记忆写进奇怪的目录
  WORLD=$(printf '%s_%s' "$HOST" "$PORT" | tr -c 'A-Za-z0-9_-' '_' | sed 's/_\+/_/g')
fi

mkdir -p "$RUN"
if ss -lntp 2>/dev/null | grep -qE ':(8790|8791)\b'; then
  echo "[join] 侧车/planner 端口已被占用，先 bash scripts/world-down.sh"
  ss -lntp | grep -E ':(8790|8791)\b'
  exit 1
fi

CONFIG=$RUN/local.json
"$PY" - "$CONFIG" "$HOST" "$PORT" "$WORLD" "$BOT_USER" "$SNAPSHOT" "$CAMERA" <<'PY'
import json, sys
src, host, port, world, bot_user, snapshot, camera = sys.argv[1:8]
raw = json.load(open("/home/asumi/Minecraft/configs/local.json", encoding="utf-8"))
mc = raw.setdefault("mc", {})
mc.update({"host": host, "port": int(port), "world": world})
if bot_user:
    mc["username"] = bot_user
# 截图/视觉要有人抓帧：只有起了虚拟屏客户端才开，否则每次都拍空
on = bool(int(snapshot)) and bool(int(camera))
raw.setdefault("snapshot", {})["enabled"] = on
raw.setdefault("attention", {})["snapshot_enabled"] = on
raw.setdefault("vision", {}).setdefault("enabled", True)
json.dump(raw, open(src, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY

export YUKI_MC_CONFIG=$CONFIG
export MC_HOST=$HOST MC_PORT=$PORT MC_WORLD=$WORLD

: > "$RUN/planner.log"; : > "$RUN/sidecar.log"; : > "$RUN/camera.log"

echo "[join] 目标 $HOST:$PORT（世界分区 $WORLD，账号 $($PY -c "import json;print(json.load(open('$CONFIG'))['mc'].get('username'))")）"

echo "[join] 启动 sidecar :8790（Yuki 进服）"
( cd "$ROOT/yuki-bot" && exec node sidecar/index.js ) > "$RUN/sidecar.log" 2>&1 &
echo $! > "$RUN/sidecar.pid"

for _ in $(seq 1 90); do
  curl -sf http://127.0.0.1:8790/health 2>/dev/null | grep -q '"ready"' && break
  sleep 1
done
curl -sf http://127.0.0.1:8790/health 2>/dev/null | grep -q '"ready"' || {
  echo "[join] bot 没进服，见 $RUN/sidecar.log"; tail -20 "$RUN/sidecar.log"; exit 1
}

echo "[join] 启动 planner :8791"
( cd "$ROOT/planner" && exec "$PY" app.py ) > "$RUN/planner.log" 2>&1 &
echo $! > "$RUN/planner.pid"
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:8791/health 2>/dev/null | grep -q '"ok"' && break
  sleep 1
done
curl -sf http://127.0.0.1:8791/health 2>/dev/null | grep -q '"ok"' || {
  echo "[join] planner 没起来，见 $RUN/planner.log"; tail -20 "$RUN/planner.log"; exit 1
}

pid_on_port () { ss -lntp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
pid_on_port 8790 > "$RUN/sidecar.pid"
pid_on_port 8791 > "$RUN/planner.pid"

if [ "$CAMERA" = "1" ]; then
  echo "[join] 启动虚拟屏客户端 $CAM_USER@$DISPLAY_NUM（$SIZE，软件渲染）"
  bash "$ROOT/scripts/mc-client-headless.sh" --server "$HOST:$PORT" --user "$CAM_USER" \
    --display "$DISPLAY_NUM" --size "$SIZE" --mem "$MEM" > "$RUN/camera.log" 2>&1

  # 客户端日志里没有「joined the game」（那条广播只发给别人），用 Connecting 之后是否掉线判断
  client_online () {
    grep -qa 'Connecting to ' /tmp/mc-client/client.log 2>/dev/null || return 1
    local tail_log
    tail_log=$(awk '/Connecting to /{buf=""} {buf=buf $0 "\n"} END{print buf}' /tmp/mc-client/client.log 2>/dev/null)
    ! printf '%s' "$tail_log" | grep -qaE 'Connection lost|Disconnected|Internal Exception'
  }
  for _ in $(seq 1 120); do
    client_online && break
    sleep 1
  done
  if client_online; then
    echo "[join] 客户端已进服"
  else
    echo "[join] 客户端 120 秒内没进服，见 /tmp/mc-client/client.log（其余进程继续跑）"
  fi
  sleep 2
  # 隐藏 HUD：旁观画面要干净，截图里不该有物品栏
  "$PY" "$ROOT/scripts/mc-keys.py" --display "$DISPLAY_NUM" --focus F1 >/dev/null 2>&1 || \
    echo "[join] F1 没敲上（HUD 可能还在，不影响跟随）"

  echo "[join] 启动相机跟随（spectate 模式，需 $CAM_USER 有 OP）"
  ( cd "$ROOT/yuki-bot" && exec node scripts/mc-camera-follow.js --mode=spectate \
      --display="$DISPLAY_NUM" --user="$CAM_USER" --ensure-spectator \
      --sidecar=http://127.0.0.1:8790 --client-log=/tmp/mc-client/client.log ) \
      >> "$RUN/camera.log" 2>&1 &
  echo $! > "$RUN/camera.pid"
fi

echo "[join] 就绪：Yuki 在 $HOST:$PORT 上线（planner :8791 / sidecar :8790）"
[ "$CAMERA" = "1" ] && echo "[join] 画面：$CAM_USER 已旁观（截图 bash scripts/mc-shot.sh）"
echo "[join] 日志: $RUN/sidecar.log  $RUN/planner.log  $RUN/camera.log"
echo "[join] 停止: bash scripts/world-down.sh"
