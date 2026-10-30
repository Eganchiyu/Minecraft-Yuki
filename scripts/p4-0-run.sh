#!/usr/bin/env bash
# scripts/p4-0-run.sh —— P4.0 截图/观战链路真机验收（虚拟屏版，不碰机主桌面）。
#
# 做四件事：
#   1. 起实验场 :25566 + 侧车（Yuki 本体用的是 mineflayer，无画面）
#   2. 起 Xvfb :98 + 真客户端（第二离线账号 YukiCam，spectator）
#   3. 用服务端控制台每 200ms 把 YukiCam 传到 Yuki 的位置与朝向（不依赖 mod / 键盘）
#   4. 分三步抓帧（静止 / 走一段 / 抬头），检查画面是否跟着位置与视角变
# 产物：/tmp/p4-0/frame-*.png + /tmp/p4-0/report.json；日志都在 /tmp/p4-0/。
# 用法: bash scripts/p4-0-run.sh
set -euo pipefail

ROOT=/home/asumi/Minecraft
JAVA=/usr/lib/jvm/java-25-openjdk-amd64/bin/java
PY=/home/asumi/miniconda3/envs/yuki/bin/python
LOG=/tmp/p4-0
FIFO=$LOG/server.in
export MC_WORLD=p4-0-test
export MC_PORT=25566

mkdir -p "$LOG"
rm -f "$FIFO"
mkfifo "$FIFO"

case "$LOG" in
  /tmp/p4-0) ;;
  *) echo "[p4-0] 拒绝在非预期目录收尾: $LOG"; exit 1 ;;
esac

cleanup () {
  echo "[p4-0] 收尾..."
  [ -n "${CAMERA_PID:-}" ] && kill -TERM "$CAMERA_PID" 2>/dev/null || true
  bash "$ROOT/scripts/mc-client-headless.sh" --stop >/dev/null 2>&1 || true
  for pid in ${SIDECAR_PID:-} ${SERVER_PID:-}; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
  done
  exec 3>&- 2>/dev/null || true
  sleep 3
  rm -f "$FIFO"
  ss -lntp 2>/dev/null | grep -E ':(25566|8790)\b' || echo "[p4-0] 端口已释放"
}
trap cleanup EXIT

ss -lntp 2>/dev/null | grep -E ':(25566|8790)\b' && { echo "[p4-0] 端口被占用，先停旧进程"; exit 1; }

echo "[p4-0] 起实验场 :25566"
( cd "$ROOT/server-test" && exec "$JAVA" -Xms768M -Xmx1280M -jar server.jar nogui < "$FIFO" ) > "$LOG/server.log" 2>&1 &
SERVER_PID=$!
exec 3> "$FIFO"
for _ in $(seq 1 120); do grep -q 'Done (' "$LOG/server.log" && break; sleep 1; done
grep -q 'Done (' "$LOG/server.log" || { echo "[p4-0] 服务端起不来"; tail -20 "$LOG/server.log"; exit 1; }
echo "/gamerule spawn_monsters false" >&3
echo "/time set day" >&3
echo "/weather clear" >&3
sleep 2

echo "[p4-0] 起侧车（Yuki 登录 :25566）"
( cd "$ROOT/yuki-bot" && exec node sidecar/index.js ) > "$LOG/sidecar.log" 2>&1 &
SIDECAR_PID=$!
for _ in $(seq 1 90); do curl -sf http://127.0.0.1:8790/health 2>/dev/null | grep -q '"ready"' && break; sleep 1; done
curl -sf http://127.0.0.1:8790/health | grep -q '"ready"' || { echo "[p4-0] bot 未就绪"; tail -20 "$LOG/sidecar.log"; exit 1; }
echo "[p4-0] Yuki 已登录"

echo "[p4-0] 起虚拟屏客户端（YukiCam）"
bash "$ROOT/scripts/mc-client-headless.sh" --server 127.0.0.1:25566 --display :98 --size 1280x720 --mem 1200M \
  > "$LOG/client-start.log" 2>&1
for _ in $(seq 1 180); do
  grep -q 'YukiCam joined the game' "$LOG/server.log" && break
  sleep 1
done
grep -q 'YukiCam joined the game' "$LOG/server.log" || {
  echo "[p4-0] 客户端没进服，日志尾:"; tail -40 /tmp/mc-client/client.log
  echo "[p4-0] 服务端日志尾:"; tail -10 "$LOG/server.log"; exit 1; }
echo "/gamemode spectator YukiCam" >&3
echo "[p4-0] YukiCam 已进服并切成 spectator"
sleep 3
# F1 隐藏 HUD（spectator 仍会画一条底部状态条）：XTest 敲键，不需要 xdotool
"$PY" "$ROOT/scripts/mc-keys.py" --display :98 --focus F1 >/dev/null 2>&1 || echo "[p4-0] F1 没敲上（HUD 可能还在，不影响验收）"
sleep 1

echo "[p4-0] 让相机长在 Yuki 眼睛上（控制台 /tp 跟随）"
( cd "$ROOT/yuki-bot" && exec node scripts/mc-camera-follow.js --fifo="$FIFO" --user=YukiCam --sidecar=http://127.0.0.1:8790 --interval=200 --offset=0.6 ) \
  > "$LOG/camera.log" 2>&1 &
CAMERA_PID=$!
sleep 12

shot () { bash "$ROOT/scripts/mc-shot.sh" "$LOG/$1" --display=:98 --size=1280x720; }

echo "[p4-0] 把视角摆到地平线（spawn 默认朝上是 mineflayer 的行为，先归位）"
"$PY" - <<'PY' >/dev/null || true
import json, urllib.request
state = json.loads(urllib.request.urlopen("http://127.0.0.1:8790/state", timeout=5).read())
p = state.get("pos") or {"x": 0, "y": 64, "z": 0}
body = json.dumps({"x": p["x"] + 24, "y": p["y"], "z": p["z"] + 24}).encode()
req = urllib.request.Request("http://127.0.0.1:8790/look", data=body, headers={"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=5).read()
PY
sleep 3

echo "[p4-0] 第一帧：固定视角"
shot frame-still.png >/dev/null

echo "[p4-0] 走一段（侧车 roam）再抓一帧"
curl -sf -X POST http://127.0.0.1:8790/intention -H 'Content-Type: application/json' \
  -d '{"priority":4,"origin":"debug","steps":[{"skill":"roam","args":{"radius":12,"stops":2},"on_fail":"abort"}]}' >/dev/null || true
sleep 10
shot frame-moved.png >/dev/null

echo "[p4-0] 抬头看天，再抓一帧（验视角跟随）"
"$PY" - <<'PY' >/dev/null || true
import json, urllib.request
state = json.loads(urllib.request.urlopen("http://127.0.0.1:8790/state", timeout=5).read())
p = state.get("pos") or {"x": 0, "y": 64, "z": 0}
body = json.dumps({"x": p["x"] + 6, "y": p["y"] + 40, "z": p["z"] + 6}).encode()
req = urllib.request.Request("http://127.0.0.1:8790/look", data=body, headers={"Content-Type": "application/json"})
urllib.request.urlopen(req, timeout=5).read()
PY
sleep 2
# 先冻结相机（避免最后一帧被下一轮 /tp 覆盖），再抓
kill -TERM "$CAMERA_PID" 2>/dev/null || true
sleep 1
shot frame-looked.png >/dev/null

echo "[p4-0] 核对三帧"
P40_DIR="$LOG" "$PY" - <<'PY'
import json, os, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageStat

root = Path(os.environ["P40_DIR"])
names = ["frame-still.png", "frame-moved.png", "frame-looked.png"]
imgs = {}
for name in names:
    path = root / name
    imgs[name] = Image.open(path).convert("RGB") if path.exists() else None

passed = failed = 0

def check(label, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS {label}")
    else:
        failed += 1
        print(f"FAIL {label} | {detail}")

check("三帧都出图", all(img is not None for img in imgs.values()), [n for n, i in imgs.items() if i is None])
if all(img is not None for img in imgs.values()):
    def stats(img):
        gray = img.convert("L")
        return {
            "mean": round(ImageStat.Stat(gray).mean[0], 2),
            "colors": len(img.getcolors(maxcolors=200000) or []),
        }
    def diff(a, b):
        stat = ImageStat.Stat(ImageChops.difference(a, b))
        return round(sum(stat.mean) / 3, 2)

    s_still, s_moved, s_looked = stats(imgs["frame-still.png"]), stats(imgs["frame-moved.png"]), stats(imgs["frame-looked.png"])
    check("画面不是黑屏", s_still["mean"] > 12 and s_moved["mean"] > 12, {"still": s_still, "moved": s_moved})
    check("画面有游戏内容（颜色数 > 200）", s_still["colors"] > 200, s_still)
    top = imgs["frame-still.png"].getcolors(maxcolors=200000) or []
    top_share = round(max((cnt for cnt, _ in top), default=0) / (imgs["frame-still.png"].width * imgs["frame-still.png"].height), 3)
    check("画面不是被单一大色块占满（相机不在方块/她的头里）", top_share < 0.45, top_share)
    d_move = diff(imgs["frame-still.png"], imgs["frame-moved.png"])
    d_look = diff(imgs["frame-moved.png"], imgs["frame-looked.png"])
    check("走动后画面变了（相机跟随位置）", d_move > 3.0, d_move)
    check("抬头后画面变了（相机跟随视角）", d_look > 6.0, d_look)
    report = {
        "still": s_still, "moved": s_moved, "looked": s_looked,
        "diff_still_moved": d_move, "diff_moved_looked": d_look,
        "passed": passed, "failed": failed,
    }
    (root / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))

sys.exit(1 if failed else 0)
PY
RC=$?
echo "[p4-0] 结论见 $LOG/report.json（帧：$LOG/frame-*.png）"
exit "$RC"
