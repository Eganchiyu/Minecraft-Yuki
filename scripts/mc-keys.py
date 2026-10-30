#!/usr/bin/env python3
"""scripts/mc-keys.py —— 往虚拟屏里的客户端敲一个键（XTest，零依赖）。

用途：给无人值守的观战客户端按 F1 隐藏 HUD（物品栏/经验条），或以后按 T 敲命令。
没有 xdotool，也不想装东西，所以直接用 ctypes 调 libX11 + libXtst。

用法:
  python3 scripts/mc-keys.py --display :98 F1
  python3 scripts/mc-keys.py --display :98 --focus F1
  python3 scripts/mc-keys.py --display :98 --text 'hello'   # 只支持 ASCII
"""
import argparse
import ctypes
import ctypes.util
import os
import subprocess
import time

X11 = ctypes.CDLL("libX11.so.6")
XTST = ctypes.CDLL("libXtst.so.6")
X11.XOpenDisplay.restype = ctypes.c_void_p
X11.XOpenDisplay.argtypes = [ctypes.c_char_p]
X11.XStringToKeysym.restype = ctypes.c_ulong
X11.XStringToKeysym.argtypes = [ctypes.c_char_p]
X11.XKeysymToKeycode.restype = ctypes.c_ubyte
X11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
X11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
X11.XFlush.argtypes = [ctypes.c_void_p]
X11.XCloseDisplay.argtypes = [ctypes.c_void_p]
XTST.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

KEYMAP = {
    " ": "space", "Escape": "Escape", "Return": "Return", "Tab": "Tab",
}


def find_client_window(display: str) -> int | None:
    """没有窗口管理器时焦点不一定在客户端上：找面积最大的可见子窗口当焦点。"""
    try:
        out = subprocess.run(
            ["xwininfo", "-display", display, "-root", "-tree"],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    best, best_area = None, 0
    for line in out.splitlines():
        if "0x" not in line or "root window" in line:
            continue
        try:
            win = int(line.strip().split()[0], 16)
        except (ValueError, IndexError):
            continue
        geom = line.split("+")[0].strip().split()
        number = None
        for token in geom:
            if "x" in token and token.replace("x", "").isdigit():
                number = token
        if not number:
            continue
        try:
            w, h = (int(v) for v in number.split("x"))
        except ValueError:
            continue
        if w * h > best_area:
            best, best_area = win, w * h
    return best


def press(dpy, keysym_name: str) -> None:
    keysym = X11.XStringToKeysym(keysym_name.encode())
    if not keysym:
        raise SystemExit(f"未知键名: {keysym_name}")
    code = X11.XKeysymToKeycode(dpy, keysym)
    if not code:
        return
    XTST.XTestFakeKeyEvent(dpy, code, 1, 0)
    XTST.XTestFakeKeyEvent(dpy, code, 0, 0)
    X11.XFlush(dpy)


def tap(dpy, keysym_name: str) -> None:
    press(dpy, keysym_name)
    time.sleep(0.05)


def type_text(dpy, text: str) -> None:
    for ch in text:
        tap(dpy, KEYMAP.get(ch, ch))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("keys", nargs="*", help="键名，如 F1 / t / Return")
    parser.add_argument("--display", default=":98")
    parser.add_argument("--focus", action="store_true", help="先把输入焦点给它（无 WM 时需要）")
    parser.add_argument("--text", default="", help="按字符串（只支持 ASCII 与空格）")
    parser.add_argument("--delay", type=float, default=0.6, help="聚焦后等一下再敲")
    args = parser.parse_args()

    dpy = X11.XOpenDisplay(args.display.encode())
    if not dpy:
        raise SystemExit(f"连不上显示 {args.display}")
    try:
        if args.focus:
            win = find_client_window(args.display)
            if win:
                X11.XSetInputFocus(dpy, win, 1, 0)  # RevertToPointerRoot
                X11.XFlush(dpy)
                time.sleep(args.delay)
        for key in args.keys:
            tap(dpy, KEYMAP.get(key, key))
        if args.text:
            type_text(dpy, args.text)
            tap(dpy, "Return")
    finally:
        X11.XCloseDisplay(dpy)


if __name__ == "__main__":
    main()
