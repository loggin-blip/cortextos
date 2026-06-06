#!/usr/bin/env python3
"""Mirror v1 — Session synthesizer.

Takes analyzed session data and produces a structured knowledge extract:
- What was built (project type, stack, features)
- How Max worked (process flow, iteration patterns)
- What Max rejected vs accepted (quality signals)
- Reusable patterns for future projects

Designed to be run after analyze-session.py, or standalone on a JSONL file.
"""

import json
import sys
import os
from pathlib import Path
from datetime import datetime

from collections import Counter


def load_session(filepath: str) -> list[dict]:
    entries = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def extract_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            c.get("text", "")
            for c in content
            if isinstance(c, dict) and c.get("type") == "text"
        )
    return ""


def extract_tool_calls(content) -> list[dict]:
    if not isinstance(content, list):
        return []
    tools = []
    for c in content:
        if isinstance(c, dict) and c.get("type") == "tool_use":
            tools.append({
                "name": c.get("name", ""),
                "input_preview": str(c.get("input", {}))[:200],
            })
    return tools


def extract_files_touched(entries: list[dict]) -> list[str]:
    files = set()
    for entry in entries:
        if entry.get("type") != "assistant":
            continue
        content = entry.get("message", {}).get("content", [])
        if not isinstance(content, list):
            continue
        for c in content:
            if not isinstance(c, dict) or c.get("type") != "tool_use":
                continue
            inp = c.get("input", {})
            for key in ("file_path", "path", "filename"):
                if key in inp and isinstance(inp[key], str):
                    files.add(inp[key])
            if c.get("name") == "Bash":
                cmd = inp.get("command", "")
                if ">" in cmd or "edit" in cmd.lower() or "write" in cmd.lower():
                    pass  # could extract file paths from bash commands
    return sorted(files)


def build_session_summary(filepath: str) -> dict:
    entries = load_session(filepath)

    user_messages = []
    assistant_texts = []
    tool_usage = Counter()
    all_tools = []

    for entry in entries:
        if entry.get("type") == "user":
            text = extract_text(entry.get("message", {}).get("content", ""))
            if text.strip():
                user_messages.append(text.strip())

        elif entry.get("type") == "assistant":
            content = entry.get("message", {}).get("content", [])
            text = extract_text(content)
            if text.strip():
                assistant_texts.append(text.strip())
            tools = extract_tool_calls(content)
            for t in tools:
                tool_usage[t["name"]] += 1
                all_tools.append(t)

    files_touched = extract_files_touched(entries)

    file_types = Counter()
    for f in files_touched:
        ext = Path(f).suffix.lower()
        if ext:
            file_types[ext] += 1

    return {
        "session_file": os.path.basename(filepath),
        "project_dir": Path(filepath).parent.name,
        "timestamp": entries[0].get("timestamp", "") if entries else "",
        "stats": {
            "user_messages": len(user_messages),
            "assistant_responses": len(assistant_texts),
            "files_touched": len(files_touched),
            "tool_calls": sum(tool_usage.values()),
        },
        "tools_used": dict(tool_usage.most_common()),
        "file_types": dict(file_types.most_common()),
        "files_touched": files_touched[:30],
        "user_messages": [m[:300] for m in user_messages],
        "flow": _build_flow(user_messages),
    }


def _build_flow(user_messages: list[str]) -> list[dict]:
    flow = []
    for i, msg in enumerate(user_messages):
        msg_lower = msg.lower()
        phase = "unknown"

        if any(w in msg_lower for w in ["start", "bygg", "build", "create", "les", "read"]):
            phase = "initiate"
        elif any(w in msg_lower for w in ["nei", "ikke", "feil", "wrong", "no ", "stop", "endre"]):
            phase = "correct"
        elif any(w in msg_lower for w in ["bra", "ja", "ok", "good", "nice", "commit", "push", "ship", "go"]):
            phase = "approve"
        elif any(w in msg_lower for w in ["prøv", "test", "sjekk", "check", "verify"]):
            phase = "verify"
        elif any(w in msg_lower for w in ["legg til", "add", "also", "også", "update"]):
            phase = "extend"
        else:
            phase = "instruct"

        flow.append({
            "step": i + 1,
            "phase": phase,
            "message_preview": msg[:100],
        })

    return flow


def generate_knowledge_extract(summary: dict) -> str:
    """Generate a human-readable knowledge extract from a session summary."""
    lines = []
    lines.append(f"# Session Extract — {summary['project_dir']}")
    lines.append(f"Date: {summary.get('timestamp', 'unknown')[:10]}")
    lines.append("")

    stats = summary["stats"]
    lines.append(f"## Stats")
    lines.append(f"- {stats['user_messages']} user messages, {stats['assistant_responses']} assistant responses")
    lines.append(f"- {stats['files_touched']} files touched, {stats['tool_calls']} tool calls")
    lines.append("")

    if summary["tools_used"]:
        lines.append("## Tools Used")
        for tool, count in summary["tools_used"].items():
            lines.append(f"- {tool}: {count}x")
        lines.append("")

    if summary["file_types"]:
        lines.append("## File Types")
        for ext, count in summary["file_types"].items():
            lines.append(f"- {ext}: {count} files")
        lines.append("")

    if summary["flow"]:
        lines.append("## Process Flow")
        for step in summary["flow"]:
            marker = {
                "initiate": "🚀",
                "correct": "↩",
                "approve": "✓",
                "verify": "🔍",
                "extend": "+",
                "instruct": "→",
                "unknown": "?",
            }.get(step["phase"], "?")
            lines.append(f"  {marker} [{step['phase']}] {step['message_preview']}")
        lines.append("")

    if summary["user_messages"]:
        lines.append("## Key Messages")
        for msg in summary["user_messages"]:
            lines.append(f"- {msg}")
            lines.append("")

    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print("Usage: synthesize.py <jsonl-file> [--json|--markdown|--save <outdir>]")
        sys.exit(1)

    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        print(f"File not found: {filepath}")
        sys.exit(1)

    summary = build_session_summary(filepath)

    if "--json" in sys.argv:
        print(json.dumps(summary, indent=2, ensure_ascii=False))
    elif "--save" in sys.argv:
        idx = sys.argv.index("--save")
        outdir = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else "."
        os.makedirs(outdir, exist_ok=True)
        extract = generate_knowledge_extract(summary)
        outfile = os.path.join(outdir, f"extract-{summary['session_file'].replace('.jsonl', '.md')}")
        with open(outfile, "w") as f:
            f.write(extract)
        print(f"Saved to {outfile}")
    else:
        print(generate_knowledge_extract(summary))


if __name__ == "__main__":
    main()
