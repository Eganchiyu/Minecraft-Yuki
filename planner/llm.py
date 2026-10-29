# planner/llm.py —— OpenAI 兼容调用，带超时、重试、调用计数、单任务预算记账与请求/补全留痕。
import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

import aiohttp

from budget import TaskBudget
from config import (
    DISABLE_THINKING,
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_MODEL,
    LLM_TIMEOUT_S,
    TRACE_ENABLED,
    TRACE_MAX_BYTES,
    TRACE_PATH,
)

log = logging.getLogger("llm")


class LLMError(RuntimeError):
    pass


class LLMClient:
    def __init__(self) -> None:
        self.calls = 0
        self.failures = 0
        self.tokens = {"prompt": 0, "completion": 0}
        self.by_purpose: dict[str, int] = {}
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=LLM_TIMEOUT_S, connect=10)
            )
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    # ---------- 留痕：请求体与补全原文 ----------
    @staticmethod
    def _write_trace(entry: dict) -> None:
        """把一次调用的输入输出追加到 trace.jsonl；超过上限就滚动成 .1。"""
        if not TRACE_ENABLED:
            return
        try:
            path = Path(TRACE_PATH)
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.stat().st_size > TRACE_MAX_BYTES:
                backup = path.with_suffix(path.suffix + ".1")
                path.replace(backup)
            with path.open("a", encoding="utf-8") as fp:
                fp.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError as exc:  # 留痕失败绝不影响主流程
            log.warning(f"[LLM] trace 写入失败: {exc}")

    def stats(self) -> dict:
        return {
            "calls": self.calls,
            "failures": self.failures,
            "tokens": self.tokens,
            "by_purpose": dict(self.by_purpose),
        }

    async def chat(
        self,
        messages: list[dict],
        *,
        purpose: str,
        tools: list[dict] | None = None,
        max_tokens: int = 400,
        temperature: float = 0.8,
        retries: int = 1,
        budget: TaskBudget | None = None,
    ) -> dict:
        payload: dict[str, Any] = {
            "model": LLM_MODEL,
            "messages": messages,
            "stream": False,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if DISABLE_THINKING:
            # 实测：这个开关把 completion 从 110 token 压到 31，且 content 直接是 JSON
            payload["thinking"] = {"type": "disabled"}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        url = f"{LLM_BASE_URL.rstrip('/')}/chat/completions"
        headers = {"Authorization": f"Bearer {LLM_API_KEY}", "Content-Type": "application/json"}
        last_error = ""
        for attempt in range(retries + 1):
            if budget is not None:
                budget.check()  # 超预算直接抛 BudgetExceeded，不再发请求
            self.calls += 1
            self.by_purpose[purpose] = self.by_purpose.get(purpose, 0) + 1
            started = time.time()
            trace_common = {
                "ts": int(started),
                "at": time.strftime("%m-%d %H:%M:%S"),
                "purpose": purpose,
                "model": LLM_MODEL,
                "attempt": attempt,
                "request": {
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "tools": [((tool.get("function") or {}).get("name")) for tool in (tools or [])] or None,
                    "thinking_disabled": DISABLE_THINKING,
                },
            }
            try:
                session = await self._get_session()
                async with session.post(url, json=payload, headers=headers) as resp:
                    text = await resp.text()
                    if resp.status != 200:
                        raise LLMError(f"http_{resp.status}: {text[:200]}")
                    data = json.loads(text)
                usage = data.get("usage") or {}
                prompt_tokens = int(usage.get("prompt_tokens") or 0)
                completion_tokens = int(usage.get("completion_tokens") or 0)
                self.tokens["prompt"] += prompt_tokens
                self.tokens["completion"] += completion_tokens
                if budget is not None:
                    budget.charge_usage(prompt_tokens, completion_tokens)
                message = dict(data["choices"][0]["message"])
                message["_usage"] = {"prompt": prompt_tokens, "completion": completion_tokens}
                self._write_trace(
                    {
                        **trace_common,
                        "ok": True,
                        "elapsed_ms": round((time.time() - started) * 1000),
                        "completion": message.get("content") or "",
                        "reasoning": message.get("reasoning_content") or "",
                        "tool_calls": message.get("tool_calls") or None,
                        "usage": {"prompt": prompt_tokens, "completion": completion_tokens},
                        "raw_finish_reason": (data["choices"][0].get("finish_reason")),
                    }
                )
                return message
            except (aiohttp.ClientError, asyncio.TimeoutError, LLMError, KeyError, json.JSONDecodeError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                self.failures += 1
                if budget is not None:
                    budget.charge_usage()  # 失败的请求也占一次调用名额
                self._write_trace(
                    {**trace_common, "ok": False, "error": last_error, "elapsed_ms": round((time.time() - started) * 1000)}
                )
                if attempt < retries:
                    await asyncio.sleep(0.8)
        raise LLMError(last_error or "llm_failed")
