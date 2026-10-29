# planner/app.py —— L1/L2 服务：/chat（听公屏）、/plan（中文→步骤）、/callback（汇报）、/event（世界事件）。
import asyncio
import json
import logging
import signal

from aiohttp import web

import config
from l1 import Planner, SidecarClient, state_text
from llm import LLMClient
from mind import Mind
from schema import SchemaError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("planner")

llm = LLMClient()
sidecar = SidecarClient(config.SIDECAR_URL)
planner = Planner(llm)
mind = Mind(llm, sidecar, planner)


async def handle_health(request: web.Request) -> web.Response:
    return web.json_response(
        {"ok": True, "llm_model": config.LLM_MODEL, "sidecar": config.SIDECAR_URL, "autonomy": config.AUTONOMY}
    )


async def handle_stats(request: web.Request) -> web.Response:
    return web.json_response({"llm": llm.stats(), **mind.stats()})


async def handle_trace(request: web.Request) -> web.Response:
    """最近几次模型调用的「上传了什么 / 补全了什么」，调 prompt 时用。"""
    try:
        limit = max(1, min(50, int(request.query.get("n") or 5)))
    except (TypeError, ValueError):
        limit = 5
    purpose = (request.query.get("purpose") or "").strip()
    path = config.TRACE_PATH
    if not path.exists():
        return web.json_response({"entries": [], "note": "还没有 trace"})
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        return web.json_response({"error": str(exc)}, status=500)
    entries = []
    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if purpose and item.get("purpose") != purpose:
            continue
        entries.append(item)
        if len(entries) >= limit:
            break
    entries.reverse()
    return web.json_response({"entries": entries})


async def handle_state(request: web.Request) -> web.Response:
    return web.json_response(mind.snapshot())


async def handle_chat(request: web.Request) -> web.Response:
    body = await request.json()
    player = str(body.get("player") or "").strip()[:32]
    text = str(body.get("text") or "").strip()[:300]
    if not player or not text:
        return web.json_response({"error": "player_and_text_required"}, status=400)
    log.info("chat_in player=%s text=%s", player, text)
    try:
        result = await mind.chat(player, text)
    except Exception as exc:
        log.error("chat_failed player=%s error=%s", player, exc)
        return web.json_response({"say": "", "error": str(exc)}, status=503)
    log.info("chat_out say=%s intention=%s", result.get("say"), result.get("intention_id"))
    status = 200 if result.get("say") else 200
    return web.json_response(result, status=status)


async def handle_plan(request: web.Request) -> web.Response:
    body = await request.json()
    text = str(body.get("text") or "").strip()[:300]
    if not text:
        return web.json_response({"error": "text_required"}, status=400)
    state_text_in = str(body.get("state") or "").strip()
    if not state_text_in:
        state, _ = await sidecar.state()
        state_text_in = state_text(state)
    last_failure = body.get("last_failure")
    if last_failure is not None and not isinstance(last_failure, dict):
        return web.json_response({"error": "last_failure_must_be_object"}, status=400)
    try:
        steps = await planner.plan(text, state_text_in, last_failure=last_failure)
    except (SchemaError, ValueError) as exc:
        log.warning("plan_rejected text=%s error=%s", text, exc)
        return web.json_response({"error": "schema_rejected", "detail": str(exc)}, status=422)
    except Exception as exc:  # LLM 不可用等
        log.error("plan_failed text=%s error=%s", text, exc)
        return web.json_response({"error": "plan_failed", "detail": str(exc)}, status=503)
    return web.json_response({"steps": steps})


async def handle_dispatch(request: web.Request) -> web.Response:
    """调试/验收：跳过人格层措辞，直接下发一句委托（仍走预算与失败升级链路）。"""
    body = await request.json()
    text = str(body.get("text") or "").strip()[:300]
    if not text:
        return web.json_response({"error": "text_required"}, status=400)
    priority = body.get("priority", 5)
    try:
        priority = max(0, min(8, int(priority)))
    except (TypeError, ValueError):
        priority = 5
    result = await mind.dispatch_direct(text, priority)
    return web.json_response(result, status=202 if result.get("ok") else 422)


async def handle_callback(request: web.Request) -> web.Response:
    body = await request.json()
    log.info("callback status=%s summary=%s", body.get("status"), body.get("summary"))
    try:
        result = await mind.callback(body)
    except Exception as exc:
        log.error("callback_failed error=%s", exc)
        return web.json_response({"say": "", "error": str(exc)}, status=503)
    # 升级路径的「重规划」本来就不说话，不算失败
    status = 200 if (result.get("say") or result.get("escalation")) else 502
    return web.json_response(result, status=status)


async def handle_event(request: web.Request) -> web.Response:
    """侧车推来的世界事件（受击/低血/岩浆/虚空/饥饿…）。"""
    body = await request.json()
    kind = str(body.get("kind") or "").strip()[:32]
    try:
        severity = int(body.get("severity") or 0)
    except (TypeError, ValueError):
        severity = 0
    detail = body.get("detail") if isinstance(body.get("detail"), dict) else {}
    result = await mind.on_event(kind, severity, detail)
    # 事件已经处理（她可能只是应了一声、没派活），别让侧车把 200 当失败重推
    handled = bool(result.get("ok") or result.get("say") or result.get("intention_id"))
    return web.json_response(result, status=200 if handled else 400)


async def handle_rest(request: web.Request) -> web.Response:
    body = await request.json()
    try:
        minutes = int(body.get("minutes") or config.AUTONOMY["rest_default_min"])
    except (TypeError, ValueError):
        minutes = config.AUTONOMY["rest_default_min"]
    return web.json_response(await mind.rest(minutes))


async def handle_cancel(request: web.Request) -> web.Response:
    body = await request.json()
    intention_id = str(body.get("intention_id") or "")
    if not intention_id:
        return web.json_response({"error": "intention_id_required"}, status=400)
    try:
        return web.json_response(await sidecar.cancel(intention_id))
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=503)


async def on_startup(app: web.Application) -> None:
    await mind.start()


async def on_cleanup(app: web.Application) -> None:
    await mind.stop()


def build_app() -> web.Application:
    app = web.Application(client_max_size=64 * 1024)
    app.add_routes(
        [
            web.get("/health", handle_health),
            web.get("/stats", handle_stats),
            web.get("/state", handle_state),
            web.get("/trace", handle_trace),
            web.post("/chat", handle_chat),
            web.post("/plan", handle_plan),
            web.post("/dispatch", handle_dispatch),
            web.post("/callback", handle_callback),
            web.post("/event", handle_event),
            web.post("/rest", handle_rest),
            web.post("/cancel", handle_cancel),
        ]
    )
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


async def main() -> None:
    app = build_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, config.PLANNER_HOST, config.PLANNER_PORT)
    await site.start()
    log.info("planner listening on http://%s:%s", config.PLANNER_HOST, config.PLANNER_PORT)
    log.info(
        "sidecar=%s model=%s autonomy=%s idle_gap=%ss",
        config.SIDECAR_URL,
        config.LLM_MODEL,
        config.AUTONOMY["enabled"],
        config.AUTONOMY["idle_gap_s"],
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()

    await runner.cleanup()
    await sidecar.close()
    await llm.close()
    log.info("planner stopped")


if __name__ == "__main__":
    asyncio.run(main())
