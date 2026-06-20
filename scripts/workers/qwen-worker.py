#!/usr/bin/env python3
"""
qwen-worker.py — Local Ollama task processor for cortextos.

Polls `cortextos bus list-tasks --assignee qwen-worker --status pending` every
POLL_INTERVAL seconds. For each task:
  1. Claim it (mark in_progress)
  2. Call Ollama with task description as prompt
  3. Complete task with Ollama response as result

Zero Claude tokens. Runs on Mac Studio as PM2-managed daemon.

Task metadata conventions (optional, via `create-task --meta '{...}'`):
  model     : "qwen2.5:7b" | "qwen2.5:72b" | "qwen2.5-coder:32b"
  temperature: float (default 0.3)
  num_predict: int (default 1024)
  system    : str (optional system prompt)

Env:
  OLLAMA_BASE_URL          default http://localhost:11434
  QWEN_WORKER_MODEL        default qwen2.5:7b
  QWEN_WORKER_POLL_SEC     default 20
  QWEN_WORKER_MAX_RUNTIME_SEC default 600 (per-task hard timeout)
"""

from __future__ import annotations
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

AGENT_NAME = "qwen-worker"
OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("QWEN_WORKER_MODEL", "qwen2.5:7b")
POLL_INTERVAL = int(os.environ.get("QWEN_WORKER_POLL_SEC", "20"))
MAX_RUNTIME = int(os.environ.get("QWEN_WORKER_MAX_RUNTIME_SEC", "600"))

LOG_DIR = Path.home() / ".cortextos" / "default" / "logs" / AGENT_NAME
LOG_DIR.mkdir(parents=True, exist_ok=True)
METRICS_FILE = LOG_DIR / "metrics.jsonl"
STDOUT_LOG = LOG_DIR / "stdout.log"

_shutdown = False


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        with STDOUT_LOG.open("a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def handle_sigterm(signum, frame):
    global _shutdown
    log(f"signal {signum} received, draining current task then exiting")
    _shutdown = True


signal.signal(signal.SIGTERM, handle_sigterm)
signal.signal(signal.SIGINT, handle_sigterm)


def bus(args: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
    """Run `cortextos bus <args>` and return CompletedProcess."""
    cmd = ["cortextos", "bus"] + args
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def list_pending_tasks() -> list[dict]:
    """Return list of tasks assigned to qwen-worker with status=pending."""
    r = bus(["list-tasks", "--agent", AGENT_NAME, "--status", "pending", "--format", "json"])
    if r.returncode != 0:
        log(f"list-tasks failed: rc={r.returncode} stderr={r.stderr[:200]}")
        return []
    try:
        data = json.loads(r.stdout)
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        # CLI may output "No tasks found." in text mode
        return []


def claim_task(task_id: str) -> bool:
    r = bus(["update-task", task_id, "in_progress"])
    if r.returncode != 0:
        log(f"claim {task_id} failed: {r.stderr[:200]}")
        return False
    return True


def complete_task(task_id: str, result: str) -> bool:
    r = bus(["complete-task", task_id, "--result", result])
    if r.returncode != 0:
        log(f"complete {task_id} failed: {r.stderr[:200]}")
        return False
    return True


def fail_task(task_id: str, reason: str) -> None:
    # No explicit fail state — mark completed with [ERROR] prefix so visibility.
    complete_task(task_id, f"[qwen-worker ERROR] {reason}")


def call_ollama(prompt: str, model: str, *, system: str | None = None,
                temperature: float = 0.3, num_predict: int = 1024,
                timeout: int = MAX_RUNTIME) -> tuple[str, dict]:
    """Returns (response_text, metrics_dict)."""
    body = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": temperature, "num_predict": num_predict},
    }
    if system:
        body["system"] = system
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.URLError as e:
        raise RuntimeError(f"Ollama unreachable: {e}") from e

    latency = time.time() - start
    d = json.loads(raw)
    text = d.get("response", "").strip()
    metrics = {
        "model": model,
        "latency_sec": round(latency, 2),
        "prompt_tokens": d.get("prompt_eval_count", 0),
        "output_tokens": d.get("eval_count", 0),
        "done_reason": d.get("done_reason", "?"),
    }
    return text, metrics


def process_task(task: dict) -> None:
    task_id = task.get("id") or task.get("task_id") or ""
    title = task.get("title", "")
    desc = task.get("description") or task.get("desc") or title
    meta = task.get("meta") or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:
            meta = {}

    model = meta.get("model", DEFAULT_MODEL)
    system = meta.get("system")
    temperature = float(meta.get("temperature", 0.3))
    num_predict = int(meta.get("num_predict", 1024))

    log(f"claim {task_id} model={model} title={title[:60]!r}")
    if not claim_task(task_id):
        return

    try:
        response, metrics = call_ollama(
            prompt=desc, model=model, system=system,
            temperature=temperature, num_predict=num_predict,
        )
    except Exception as e:
        log(f"ollama call failed for {task_id}: {e}")
        fail_task(task_id, str(e))
        return

    metrics["task_id"] = task_id
    metrics["title"] = title[:100]
    metrics["completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        with METRICS_FILE.open("a") as f:
            f.write(json.dumps(metrics) + "\n")
    except Exception:
        pass

    if complete_task(task_id, response):
        log(f"done  {task_id} latency={metrics['latency_sec']}s out_tokens={metrics['output_tokens']}")
    else:
        log(f"complete-task bus-call failed for {task_id}; response was generated but not committed")


def mainloop() -> None:
    log(f"qwen-worker starting; ollama={OLLAMA_URL} default_model={DEFAULT_MODEL} poll={POLL_INTERVAL}s")
    # Smoke-test Ollama reachable once at boot
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=5) as r:
            r.read()
        log("ollama reachable ✓")
    except Exception as e:
        log(f"WARNING: ollama not reachable at boot: {e} — will retry on each task")

    while not _shutdown:
        try:
            tasks = list_pending_tasks()
        except Exception as e:
            log(f"list-pending error: {e}")
            tasks = []

        if tasks:
            log(f"{len(tasks)} pending task(s)")
            for t in tasks:
                if _shutdown:
                    break
                process_task(t)
        else:
            # idle — short heartbeat log every ~10 min
            pass

        # Sleep in small increments so SIGTERM reacts fast
        remaining = POLL_INTERVAL
        while remaining > 0 and not _shutdown:
            time.sleep(min(2, remaining))
            remaining -= 2

    log("qwen-worker exiting cleanly")


if __name__ == "__main__":
    try:
        mainloop()
    except Exception as e:
        log(f"fatal: {e}")
        sys.exit(1)
