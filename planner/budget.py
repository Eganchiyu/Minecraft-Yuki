# planner/budget.py —— P2 单任务预算：调用次数 / token / 墙钟时间 / 重试次数。
# 一条委托共享一份预算；任何一项超限就抛 BudgetExceeded，由调用方降级成人话。
import time


class BudgetExceeded(RuntimeError):
    pass


class TaskBudget:
    def __init__(self, max_calls: int, max_tokens: int, max_wall_s: float, max_retries: int) -> None:
        self.max_calls = max(1, int(max_calls))
        self.max_tokens = max(1, int(max_tokens))
        self.max_wall_s = max(1.0, float(max_wall_s))
        self.max_retries = max(0, int(max_retries))
        self.calls = 0
        self.tokens = 0
        self.retries = 0
        self.started_at = time.monotonic()

    # ---------- 记账 ----------
    def check(self) -> None:
        if self.calls >= self.max_calls:
            raise BudgetExceeded(f"calls>{self.max_calls}")
        if self.tokens >= self.max_tokens:
            raise BudgetExceeded(f"tokens>{self.max_tokens}")
        if self.elapsed_s >= self.max_wall_s:
            raise BudgetExceeded(f"wall>{self.max_wall_s:.0f}s")

    def charge_usage(self, prompt_tokens: int = 0, completion_tokens: int = 0) -> None:
        self.calls += 1
        self.tokens += max(0, int(prompt_tokens)) + max(0, int(completion_tokens))

    def take_retry(self) -> bool:
        """占用一次重规划名额；用尽返回 False。"""
        if self.retries >= self.max_retries:
            return False
        self.retries += 1
        return True

    # ---------- 观测 ----------
    @property
    def elapsed_s(self) -> float:
        return time.monotonic() - self.started_at

    @property
    def exhausted(self) -> bool:
        try:
            self.check()
        except BudgetExceeded:
            return True
        return False

    def snapshot(self) -> dict:
        return {
            "calls": self.calls,
            "max_calls": self.max_calls,
            "tokens": self.tokens,
            "max_tokens": self.max_tokens,
            "elapsed_s": round(self.elapsed_s, 2),
            "max_wall_s": self.max_wall_s,
            "retries": self.retries,
            "max_retries": self.max_retries,
        }
