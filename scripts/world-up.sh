#!/usr/bin/env bash
# scripts/world-up.sh —— 常驻世界：主服 :25565 + planner :8791 + sidecar :8790，留给机主进服造访。
# 用法: bash scripts/world-up.sh     停止: bash scripts/world-down.sh
set -euo pipefail

ROOT=/home/asumi/Minecraft
JAVA=/usr/lib/jvm/java-25-openjdk-amd64/bin/java
PY=/home/asumi/miniconda3/envs/yuki/bin/python
RUN=/tmp/yuki-world
FIFO=$RUN/server.in

mkdir -p "$RUN"

if ss -lntp 2>/dev/null | grep -qE ':(25565|8790|8791)\b'; then
  echo "[world] 已有进程占用端口，先 bash scripts/world-down.sh"
  ss -lntp | grep -E ':(25565|8790|8791)\b'
  exit 1
fi

rm -f "$FIFO"; mkfifo "$FIFO"
: > "$RUN/server.log"; : > "$RUN/planner.log"; : > "$RUN/sidecar.log"

# 常驻写端：让服务端控制台 stdin 一直有 writer，后续 echo 命令才不阻塞
sleep 100000 > "$FIFO" &
echo $! > "$RUN/fifo-holder.pid"

echo "[world] 启动主服 :25565"
( cd "$ROOT/server" && exec "$JAVA" -Xms1G -Xmx2G -jar server.jar nogui < "$FIFO" ) > "$RUN/server.log" 2>&1 &
echo $! > "$RUN/server.pid"

for i in $(seq 1 150); do
  grep -q 'Done (' "$RUN/server.log" && break
  sleep 1
done
grep -q 'Done (' "$RUN/server.log" || { echo "[world] 服务端启动失败，见 $RUN/server.log"; tail -20 "$RUN/server.log"; exit 1; }

echo "[world] 启动 planner :8791"
( cd "$ROOT/planner" && exec "$PY" app.py ) > "$RUN/planner.log" 2>&1 &
echo $! > "$RUN/planner.pid"

echo "[world] 启动 sidecar :8790（Yuki 进服）"
( cd "$ROOT/yuki-bot" && exec node sidecar/index.js ) > "$RUN/sidecar.log" 2>&1 &
echo $! > "$RUN/sidecar.pid"

for i in $(seq 1 90); do
  curl -sf http://127.0.0.1:8790/health 2>/dev/null | grep -q '"ready"' && break
  sleep 1
done
curl -sf http://127.0.0.1:8790/health >/dev/null && curl -sf http://127.0.0.1:8791/health >/dev/null || {
  echo "[world] 服务未就绪，见 $RUN/sidecar.log / $RUN/planner.log"; exit 1
}

# PID 文件以真实监听者为准（`( ... ) & echo $!` 可能拿到外层 subshell）
pid_on_port () { ss -lntp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
pid_on_port 25565 > "$RUN/server.pid"
pid_on_port 8791 > "$RUN/planner.pid"
pid_on_port 8790 > "$RUN/sidecar.pid"

echo "[world] 就绪：客户端 26.1.2 离线模式连 127.0.0.1:25565，公屏带 yuki 关键字叫她"
echo "[world] 日志: $RUN/server.log  $RUN/sidecar.log  $RUN/planner.log"
echo "[world] 控制台命令: echo '/time set day' > $FIFO"
