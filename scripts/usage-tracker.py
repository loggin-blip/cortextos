#!/usr/bin/env python3
"""
cortextOS Usage Tracker — aggregates Claude Code token usage per agent per day.

Parses ~/.claude/projects/*/*.jsonl session files, extracts token counts from
assistant messages, and outputs structured JSON for dashboard consumption.

Usage:
    python3 scripts/usage-tracker.py                    # stdout JSON
    python3 scripts/usage-tracker.py --days 7           # last 7 days
    python3 scripts/usage-tracker.py --agent kaptein    # single agent
    python3 scripts/usage-tracker.py --output /path/to/usage.json
"""

import json
import os
import re
import sys
import glob
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from collections import defaultdict

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"

# USD per million tokens — update when pricing changes
PRICING = {
    "claude-opus-4-7":   {"input": 15.0,  "output": 75.0, "cache_write": 18.75, "cache_read": 1.50},
    "claude-opus-4-6":   {"input": 15.0,  "output": 75.0, "cache_write": 18.75, "cache_read": 1.50},
    "claude-opus-4-5":   {"input": 15.0,  "output": 75.0, "cache_write": 18.75, "cache_read": 1.50},
    "claude-sonnet-4-6": {"input": 3.0,   "output": 15.0, "cache_write": 3.75,  "cache_read": 0.30},
    "claude-sonnet-4-5": {"input": 3.0,   "output": 15.0, "cache_write": 3.75,  "cache_read": 0.30},
    "claude-haiku-4-5":  {"input": 0.80,  "output": 4.0,  "cache_write": 1.00,  "cache_read": 0.08},
}

FALLBACK_PRICING = {"input": 15.0, "output": 75.0, "cache_write": 18.75, "cache_read": 1.50}


def extract_agent_name(project_dir: str) -> str:
    """Derive agent name from Claude project directory name."""
    # Pattern: -Users-max-cortextos-orgs-westside-hq-agents-<agent-name>
    m = re.search(r'agents-([a-z0-9_-]+)$', project_dir)
    if m:
        return m.group(1)
    # Pattern: -Users-max-cortextos-builds-<project>
    m = re.search(r'builds-([a-z0-9_-]+)$', project_dir)
    if m:
        return f"build:{m.group(1)}"
    # Pattern: -Users-max-cortextos (root)
    if project_dir.endswith('-cortextos'):
        return "cortextos-root"
    # Pattern: -Users-max (home)
    if project_dir.endswith('-max'):
        return "max-cli"
    return project_dir.split('-')[-1] or "unknown"


def get_pricing(model: str) -> dict:
    if not model:
        return FALLBACK_PRICING
    for key, prices in PRICING.items():
        if key in model:
            return prices
    if "opus" in model:
        return PRICING["claude-opus-4-7"]
    if "sonnet" in model:
        return PRICING["claude-sonnet-4-6"]
    if "haiku" in model:
        return PRICING["claude-haiku-4-5"]
    return FALLBACK_PRICING


def compute_cost(usage: dict, model: str) -> float:
    prices = get_pricing(model)
    input_tok = usage.get("input_tokens", 0)
    output_tok = usage.get("output_tokens", 0)
    cache_write = usage.get("cache_creation_input_tokens", 0)
    cache_read = usage.get("cache_read_input_tokens", 0)

    cost = (
        (input_tok / 1_000_000) * prices["input"]
        + (output_tok / 1_000_000) * prices["output"]
        + (cache_write / 1_000_000) * prices["cache_write"]
        + (cache_read / 1_000_000) * prices["cache_read"]
    )
    return round(cost, 6)


def parse_jsonl(filepath: str, date_from: str | None, date_to: str | None):
    """Yield (date_str, model, usage_dict) for each assistant message with usage."""
    with open(filepath, "r") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            if entry.get("type") != "assistant":
                continue

            msg = entry.get("message")
            if not isinstance(msg, dict):
                continue

            usage = msg.get("usage")
            if not usage:
                continue

            ts = entry.get("timestamp", "")
            if not ts:
                continue

            date_str = ts[:10]
            if date_from and date_str < date_from:
                continue
            if date_to and date_str > date_to:
                continue

            model = msg.get("model", "unknown")
            yield date_str, model, usage


def aggregate(days: int | None = None, agent_filter: str | None = None) -> dict:
    """
    Returns:
    {
      "generated_at": "ISO timestamp",
      "date_range": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"},
      "totals": {"input_tokens": N, "output_tokens": N, "cache_write_tokens": N, "cache_read_tokens": N, "cost_usd": N, "requests": N},
      "by_agent": {
        "agent-name": {
          "totals": {...},
          "by_day": {
            "YYYY-MM-DD": {"input_tokens": N, "output_tokens": N, "cache_write_tokens": N, "cache_read_tokens": N, "cost_usd": N, "requests": N, "models": {"model-id": N}}
          }
        }
      },
      "by_day": {
        "YYYY-MM-DD": {"input_tokens": N, "output_tokens": N, "cache_write_tokens": N, "cache_read_tokens": N, "cost_usd": N, "requests": N}
      }
    }
    """
    date_to = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    date_from = None
    if days:
        date_from = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")

    # agent -> date -> accumulated stats
    data = defaultdict(lambda: defaultdict(lambda: {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_write_tokens": 0,
        "cache_read_tokens": 0,
        "cost_usd": 0.0,
        "requests": 0,
        "models": defaultdict(int),
    }))

    if not CLAUDE_PROJECTS.exists():
        return {"error": f"{CLAUDE_PROJECTS} not found"}

    for project_dir in CLAUDE_PROJECTS.iterdir():
        if not project_dir.is_dir():
            continue

        agent = extract_agent_name(project_dir.name)
        if agent_filter and agent_filter not in agent:
            continue

        for jsonl_file in project_dir.glob("*.jsonl"):
            try:
                for date_str, model, usage in parse_jsonl(str(jsonl_file), date_from, date_to):
                    bucket = data[agent][date_str]
                    bucket["input_tokens"] += usage.get("input_tokens", 0)
                    bucket["output_tokens"] += usage.get("output_tokens", 0)
                    bucket["cache_write_tokens"] += usage.get("cache_creation_input_tokens", 0)
                    bucket["cache_read_tokens"] += usage.get("cache_read_input_tokens", 0)
                    bucket["cost_usd"] += compute_cost(usage, model)
                    bucket["requests"] += 1
                    bucket["models"][model] += 1
            except Exception as e:
                print(f"Warning: failed to parse {jsonl_file}: {e}", file=sys.stderr)

    # Build output
    grand_totals = {"input_tokens": 0, "output_tokens": 0, "cache_write_tokens": 0, "cache_read_tokens": 0, "cost_usd": 0.0, "requests": 0}
    by_day_global = defaultdict(lambda: {"input_tokens": 0, "output_tokens": 0, "cache_write_tokens": 0, "cache_read_tokens": 0, "cost_usd": 0.0, "requests": 0})
    by_agent = {}

    for agent, days_data in sorted(data.items()):
        agent_totals = {"input_tokens": 0, "output_tokens": 0, "cache_write_tokens": 0, "cache_read_tokens": 0, "cost_usd": 0.0, "requests": 0}
        agent_by_day = {}

        for date_str, bucket in sorted(days_data.items()):
            day_entry = {
                "input_tokens": bucket["input_tokens"],
                "output_tokens": bucket["output_tokens"],
                "cache_write_tokens": bucket["cache_write_tokens"],
                "cache_read_tokens": bucket["cache_read_tokens"],
                "cost_usd": round(bucket["cost_usd"], 4),
                "requests": bucket["requests"],
                "models": dict(bucket["models"]),
            }
            agent_by_day[date_str] = day_entry

            for k in ["input_tokens", "output_tokens", "cache_write_tokens", "cache_read_tokens", "requests"]:
                agent_totals[k] += bucket[k]
                by_day_global[date_str][k] += bucket[k]
                grand_totals[k] += bucket[k]
            agent_totals["cost_usd"] += bucket["cost_usd"]
            by_day_global[date_str]["cost_usd"] += bucket["cost_usd"]
            grand_totals["cost_usd"] += bucket["cost_usd"]

        agent_totals["cost_usd"] = round(agent_totals["cost_usd"], 4)
        by_agent[agent] = {"totals": agent_totals, "by_day": agent_by_day}

    grand_totals["cost_usd"] = round(grand_totals["cost_usd"], 4)
    by_day_out = {d: {**v, "cost_usd": round(v["cost_usd"], 4)} for d, v in sorted(by_day_global.items())}

    all_dates = sorted(by_day_global.keys())

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "date_range": {"from": all_dates[0] if all_dates else date_from, "to": all_dates[-1] if all_dates else date_to},
        "totals": grand_totals,
        "by_agent": by_agent,
        "by_day": by_day_out,
    }


def main():
    parser = argparse.ArgumentParser(description="cortextOS Usage Tracker")
    parser.add_argument("--days", type=int, help="Only include last N days")
    parser.add_argument("--agent", type=str, help="Filter to agent name (substring match)")
    parser.add_argument("--output", "-o", type=str, help="Write JSON to file instead of stdout")
    parser.add_argument("--summary", action="store_true", help="Print human-readable summary instead of JSON")
    args = parser.parse_args()

    result = aggregate(days=args.days, agent_filter=args.agent)

    if args.summary:
        t = result["totals"]
        print(f"Usage: {result['date_range']['from']} → {result['date_range']['to']}")
        print(f"Total cost: ${t['cost_usd']:.2f}")
        print(f"Requests: {t['requests']:,}")
        print(f"Tokens: {t['input_tokens']:,} in / {t['output_tokens']:,} out / {t['cache_write_tokens']:,} cache-w / {t['cache_read_tokens']:,} cache-r")
        print()
        print(f"{'Agent':<30} {'Cost':>10} {'Requests':>10} {'Out tokens':>12}")
        print("-" * 65)
        agents_sorted = sorted(result["by_agent"].items(), key=lambda x: x[1]["totals"]["cost_usd"], reverse=True)
        for agent, info in agents_sorted:
            at = info["totals"]
            print(f"{agent:<30} ${at['cost_usd']:>8.2f} {at['requests']:>10,} {at['output_tokens']:>12,}")

        if result.get("by_day"):
            print()
            print(f"{'Date':<12} {'Cost':>10} {'Requests':>10}")
            print("-" * 35)
            for date, day_info in sorted(result["by_day"].items()):
                print(f"{date:<12} ${day_info['cost_usd']:>8.2f} {day_info['requests']:>10,}")
    else:
        output = json.dumps(result, indent=2)
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            with open(args.output, "w") as f:
                f.write(output)
            print(f"Written to {args.output}", file=sys.stderr)
        else:
            print(output)


if __name__ == "__main__":
    main()
