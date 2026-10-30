#!/usr/bin/env bash
# scripts/mc-client-headless.sh —— 给 Yuki 开一台「看不见的显示器」，用真客户端渲染她的视角。
#
# 为什么必须这样：mineflayer 只有协议数据，没有渲染器；要原生画面（方块、生物、光影）
# 只能有一个真 Minecraft 客户端在跑。这里用 Xvfb 虚拟屏 + Mesa 软件渲染把它藏在 :98，
# 完全不碰机主的 :0.0，也不抢焦点。抓帧用 scripts/mc-shot.sh。
#
# 用法:
#   bash scripts/mc-client-headless.sh                 # 启动（默认 YukiCam 进 127.0.0.1:25565）
#   bash scripts/mc-client-headless.sh --dry-run       # 只打印启动命令，不做任何事
#   bash scripts/mc-client-headless.sh --stop          # 关掉客户端与虚拟屏
#
# 账号：离线第二账号（默认 YukiCam），进服后由服务端控制台 /gamemode spectator。
set -euo pipefail

ROOT=/home/asumi/Minecraft
MC=$ROOT/.minecraft
JAVA=/usr/lib/jvm/java-25-openjdk-amd64/bin/java
VERSION=26.1.2-Fabric
USER_NAME=YukiCam
SERVER=127.0.0.1:25565
DISP=:98
SIZE=1280x720
MEM=1536M
GAMEDIR=$ROOT/work/mc-camera
RUNDIR=/tmp/mc-client
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_NAME="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --display) DISP="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --mem) MEM="$2"; shift 2 ;;
    --game-dir) GAMEDIR="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --stop) STOP=1; shift ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

mkdir -p "$RUNDIR"

if [ "${STOP:-0}" = "1" ]; then
  [ -f "$RUNDIR/client.pid" ] && kill -TERM "$(cat "$RUNDIR/client.pid")" 2>/dev/null || true
  [ -f "$RUNDIR/xvfb.pid" ] && kill -TERM "$(cat "$RUNDIR/xvfb.pid")" 2>/dev/null || true
  rm -f "$RUNDIR/client.pid" "$RUNDIR/xvfb.pid"
  echo "[client] 已停"
  exit 0
fi

# ---------- 1. 组装 classpath（按 rules 过滤；mac/win 的库直接跳过） ----------
CP_FILE=$RUNDIR/classpath.txt
python3 - "$MC" "$CP_FILE" <<'PY'
import json, os, sys
mc, out = sys.argv[1], sys.argv[2]
ver = "26.1.2-Fabric"
doc = json.load(open(os.path.join(mc, "versions", ver, f"{ver}.json"), encoding="utf-8"))

def allowed(lib):
    rules = lib.get("rules")
    if not rules:
        return True
    allow = None
    for rule in rules:
        osr = rule.get("os") or {}
        name, arch = osr.get("name"), osr.get("arch")
        if name and name not in ("linux", "universal"):
            continue
        if arch and arch != "x86_64":
            continue
        if rule.get("action") == "allow":
            allow = True
        elif rule.get("action") == "disallow":
            return False
    return bool(allow)

def path_of(lib):
    art = (lib.get("downloads") or {}).get("artifact")
    if art:
        return art["path"]
    parts = lib["name"].split(":")
    if len(parts) < 3:
        return None
    group, name, version = parts[0], parts[1], parts[2]
    fname = f"{name}-{version}.jar"
    return "/".join(group.split(".")) + f"/{name}/{version}/{fname}"

paths = []
missing = []
for lib in doc["libraries"]:
    if "natives" in (lib.get("name") or ""):
        continue
    if not allowed(lib):
        continue
    rel = path_of(lib)
    if not rel:
        continue
    full = os.path.join(mc, "libraries", rel)
    if os.path.exists(full):
        paths.append(full)
    else:
        missing.append(lib["name"])
client_jar = os.path.join(mc, "versions", ver, f"{ver}.jar")
paths.append(client_jar)
open(out, "w", encoding="utf-8").write(":".join(paths))
if missing:
    print(f"[client] 跳过 {len(missing)} 个本机没有的库（多为 mac/win 专用）", file=sys.stderr)
PY
CP=$(cat "$CP_FILE")

# ---------- 2. 独立 gameDir：不动机主的设置、mods 与存档 ----------
mkdir -p "$GAMEDIR"
if [ ! -f "$GAMEDIR/options.txt" ]; then
  if [ -f "$MC/versions/$VERSION/options.txt" ]; then
    cp "$MC/versions/$VERSION/options.txt" "$GAMEDIR/options.txt"
  else
    : > "$GAMEDIR/options.txt"
  fi
  python3 - "$GAMEDIR/options.txt" <<'PY'
import re, sys
path = sys.argv[1]
want = {
    "pauseOnLostFocus": "false",
    "renderDistance": "4",
    "simulationDistance": "4",
    "maxFps": "20",
    "graphicsMode": "0",
    "fullscreen": "false",
    "guiScale": "2",
    "fov": "0.0",
    "skipMultiplayerWarning": "true",
    "tutorialStep": "none",
    "soundCategory_master": "0.0",
}
text = open(path, encoding="utf-8").read() if path else ""
lines, seen = [], set()
for line in text.splitlines():
    key = line.split(":", 1)[0]
    if key in want:
        lines.append(f"{key}:{want[key]}")
        seen.add(key)
    else:
        lines.append(line)
for key, value in want.items():
    if key not in seen:
        lines.append(f"{key}:{value}")
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
fi

# 离线 UUID：md5("OfflinePlayer:<name>") 加版本位，和原版离线服务器一致
UUID=$(python3 - "$USER_NAME" <<'PY'
import hashlib, sys
name = sys.argv[1]
raw = bytearray(hashlib.md5(f"OfflinePlayer:{name}".encode()).digest())
raw[6] = (raw[6] & 0x0F) | 0x30
raw[8] = (raw[8] & 0x3F) | 0x80
h = raw.hex()
print(f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}")
PY
)

NATIVES=$MC/versions/$VERSION/natives-linux-x86_64
CMD=("$JAVA" "-Xmx$MEM" -Xms512M -XX:+UseG1GC -XX:MaxGCPauseMillis=50
  "-Djava.library.path=$NATIVES" "-Dorg.lwjgl.librarypath=$NATIVES"
  "-Dminecraft.launcher.brand=yuki-camera" "-Dminecraft.launcher.version=1"
  -cp "$CP"
  net.fabricmc.loader.impl.launch.knot.KnotClient
  --username "$USER_NAME" --version "$VERSION" --gameDir "$GAMEDIR"
  --assetsDir "$MC/assets" --assetIndex 30
  --uuid "$UUID" --accessToken 0 --userType legacy --versionType release
  --width "${SIZE%x*}" --height "${SIZE#*x}"
  --quickPlayMultiplayer "$SERVER")

if [ "$DRY" = "1" ]; then
  echo "[client] DISPLAY=$DISP LIBGL_ALWAYS_SOFTWARE=1"
  printf '%q ' "${CMD[@]}" | sed 's/ -cp [^ ]*/ -cp <classpath>/'
  echo
  exit 0
fi

# ---------- 3. 虚拟屏 ----------
if ! xdpyinfo -display "$DISP" >/dev/null 2>&1; then
  echo "[client] 起 Xvfb $DISP ($SIZE)"
  Xvfb "$DISP" -screen 0 "${SIZE}x24" -nolisten tcp > "$RUNDIR/xvfb.log" 2>&1 &
  echo $! > "$RUNDIR/xvfb.pid"
  for _ in $(seq 1 30); do
    xdpyinfo -display "$DISP" >/dev/null 2>&1 && break
    sleep 0.3
  done
fi
xdpyinfo -display "$DISP" >/dev/null 2>&1 || { echo "[client] Xvfb 起不来，见 $RUNDIR/xvfb.log"; exit 1; }

# ---------- 4. 客户端 ----------
echo "[client] 启动 $VERSION（$USER_NAME @ $SERVER，内存 $MEM，软件渲染）"
( export DISPLAY="$DISP" LIBGL_ALWAYS_SOFTWARE=1
  exec "${CMD[@]}" ) > "$RUNDIR/client.log" 2>&1 &
echo $! > "$RUNDIR/client.pid"
echo "[client] PID $(cat "$RUNDIR/client.pid")，日志 $RUNDIR/client.log"
echo "[client] 抓帧: bash scripts/mc-shot.sh /tmp/mc-client/frame.png"
