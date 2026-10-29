#!/usr/bin/env bash
# scripts/patch-262.sh —— 给 mineflayer 生态补上 26.2（协议 776）的实验性支持。
#
# 背景：minecraft-data 3.117.0 只登记了 26.2 = 776，但没有 data/pc/26.2 的数据目录；
#       minecraft-protocol 1.68.0 的 supportedVersions 也只到 26.1。
# 做法：把 26.1 的数据目录复制成 26.2、补 dataPaths 映射、把 26.2 加进版本白名单。
# 注意：这是「拿旧数据充新版本」，属于未验证状态；上游发正式数据后跑了 npm i 就恢复原样。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../yuki-bot" && pwd)"
MD="$ROOT/node_modules/minecraft-data/minecraft-data/data"
MP="$ROOT/node_modules/minecraft-protocol/src/version.js"
PY="${PY:-/home/asumi/miniconda3/envs/yuki/bin/python}"

[ -d "$MD/pc/26.1" ] || { echo "[262] 找不到 $MD/pc/26.1"; exit 1; }

if [ ! -d "$MD/pc/26.2" ]; then
  cp -r "$MD/pc/26.1" "$MD/pc/26.2"
  echo "[262] 已复制 data/pc/26.1 -> data/pc/26.2"
else
  echo "[262] data/pc/26.2 已存在，跳过复制"
fi

"$PY" - "$MD/dataPaths.json" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path, encoding='utf-8') as fp:
    data = json.load(fp)
pc = data.setdefault('pc', {})
if '26.2' in pc:
    print('[262] dataPaths 已有 26.2 映射')
else:
    pc['26.2'] = dict(pc['26.1'])
    with open(path, 'w', encoding='utf-8') as fp:
        json.dump(data, fp, indent=2)
    print('[262] dataPaths 已加入 26.2（复用 26.1 的数据目录）')
PYEOF

"$PY" - "$MP" <<'PYEOF'
import re, sys
path = sys.argv[1]
with open(path, encoding='utf-8') as fp:
    src = fp.read()
if "'26.2'" in src:
    print('[262] supportedVersions 已包含 26.2')
else:
    src = re.sub(r"('26\.1')\]", r"'26.1', '26.2']", src)
    with open(path, 'w', encoding='utf-8') as fp:
        fp.write(src)
    print('[262] supportedVersions 已加入 26.2')
PYEOF

node -e "
const proto = require('$ROOT/node_modules/minecraft-protocol')
const mcData = require('$ROOT/node_modules/minecraft-data')
console.log('[262] supportedVersions 末尾:', proto.supportedVersions.slice(-3).join(', '))
const d = mcData('26.2')
console.log('[262] mcData 26.2 -> version', d.version.version, '| blocks', Object.keys(d.blocksByName).length, '| items', Object.keys(d.itemsByName).length)
"
