#!/usr/bin/env bash
# scripts/world-down.sh —— 优雅停掉常驻世界 / 远程入服（SIGTERM，Java 会保存存档；不要 kill -9）。
set -uo pipefail

ROOT=/home/asumi/Minecraft
RUN=/tmp/yuki-world
for name in camera sidecar planner server fifo-holder; do
  file=$RUN/$name.pid
  [ -f "$file" ] || continue
  pid=$(cat "$file" 2>/dev/null || true)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    echo "[world] 停 $name (pid $pid)"
    kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
done

# 远程入服形态下的虚拟屏客户端（Xvfb :98 + 观战客户端）
if [ -f /tmp/mc-client/client.pid ] || [ -f /tmp/mc-client/xvfb.pid ]; then
  bash "$ROOT/scripts/mc-client-headless.sh" --stop >/dev/null 2>&1 && echo "[world] 停虚拟屏客户端"
fi

for i in $(seq 1 20); do
  ss -lntp 2>/dev/null | grep -qE ':(25565|8790|8791)\b' || break
  sleep 1
done
ss -lntp 2>/dev/null | grep -E ':(25565|8790|8791)\b' || echo "[world] 端口已释放"
rm -f "$RUN/server.in"
