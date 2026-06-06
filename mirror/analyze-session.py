#!/usr/bin/env python3
"""Mirror v1 — JSONL session analyzer.

Reads a Claude Code JSONL conversation file and extracts:
- User corrections ("nei", "ikke slik", "prøv heller")
- Design decisions (component choices, layout changes)
- Quality signals (what Max accepts vs rejects)
- Process patterns (order of operations, workflow steps)

Output: structured JSON suitable for knowledge-base ingestion.
"""

import json
import sys
import os
import re
from pathlib import Path
from datetime import datetime
from collections import defaultdict


def parse_jsonl(filepath: str) -> list[dict]:
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


def extract_user_messages(entries: list[dict]) -> list[dict]:
    messages = []
    for entry in entries:
        if entry.get("type") != "user":
            continue
        msg = entry.get("message", {})
        if not isinstance(msg, dict):
            continue
        content = msg.get("content", "")
        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    parts.append(c["text"])
            text = "\n".join(parts)
        if text.strip():
            messages.append({
                "text": text.strip(),
                "timestamp": entry.get("timestamp", ""),
                "message_id": msg.get("id", ""),
            })
    return messages


def extract_assistant_summaries(entries: list[dict]) -> list[dict]:
    summaries = []
    for entry in entries:
        if entry.get("type") != "assistant":
            continue
        msg = entry.get("message", {})
        if not isinstance(msg, dict):
            continue
        content = msg.get("content", [])
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text":
                    parts.append(c["text"])
            text = "\n".join(parts)
        else:
            continue
        if text.strip():
            summaries.append({
                "text": text.strip()[:500],
                "timestamp": entry.get("timestamp", ""),
            })
    return summaries


CORRECTION_PATTERNS = [
    r"\bnej\b", r"\bikkje?\b", r"\bfeil\b", r"\bgalt\b",
    r"\bikke s[åa]nn\b", r"\bikke slik\b", r"\bprøv heller\b",
    r"\bstopp\b", r"\bvent\b", r"\bgjør det om\b",
    r"\bbytt\b", r"\bendre\b", r"\bfjern\b", r"\bslett\b",
    r"\bno\b", r"\bwrong\b", r"\bdon'?t\b", r"\bstop\b",
    r"\binstead\b", r"\bactually\b", r"\bnot that\b",
    r"\bslapt?\b", r"\bdårlig\b", r"\bstygg\b",
]

APPROVAL_PATTERNS = [
    r"\bbra\b", r"\bperfekt\b", r"\bfint\b", r"\bnice\b",
    r"\bgood\b", r"\byes\b", r"\bja\b", r"\bok\b",
    r"\bgo\b", r"\bkjør\b", r"\bferdig\b", r"\bdone\b",
    r"\bcommit\b", r"\bpush\b", r"\bship\b",
    r"\bexactly\b", r"\bnøyaktig\b",
]

DECISION_PATTERNS = [
    r"\bbruk\b.*\b(shadcn|tailwind|next|react|supabase|prisma)\b",
    r"\b(shadcn|tailwind|next|react|supabase)\b",
    r"\blayout\b", r"\bdesign\b", r"\bfarger?\b", r"\bfont\b",
    r"\bkomponent\b", r"\bcomponent\b",
    r"\barkitektur\b", r"\bstruktur\b", r"\bpattern\b",
    r"\bstack\b", r"\bapi\b", r"\bdatabase\b",
]


def classify_message(text: str) -> dict:
    text_lower = text.lower()
    signals = {
        "is_correction": False,
        "is_approval": False,
        "has_decision": False,
        "correction_triggers": [],
        "approval_triggers": [],
        "decision_triggers": [],
        "length": len(text),
        "is_short": len(text) < 50,
    }

    for pattern in CORRECTION_PATTERNS:
        if re.search(pattern, text_lower):
            signals["is_correction"] = True
            signals["correction_triggers"].append(pattern)

    for pattern in APPROVAL_PATTERNS:
        if re.search(pattern, text_lower):
            signals["is_approval"] = True
            signals["approval_triggers"].append(pattern)

    for pattern in DECISION_PATTERNS:
        if re.search(pattern, text_lower):
            signals["has_decision"] = True
            signals["decision_triggers"].append(pattern)

    if signals["is_correction"] and signals["is_approval"]:
        correction_count = len(signals["correction_triggers"])
        approval_count = len(signals["approval_triggers"])
        if correction_count > approval_count:
            signals["is_approval"] = False
        elif approval_count > correction_count:
            signals["is_correction"] = False

    return signals


def extract_conversation_pairs(entries: list[dict]) -> list[dict]:
    """Extract user→assistant pairs to see what Max said and how Claude responded."""
    pairs = []
    user_msgs = []
    assistant_msgs = []

    for entry in entries:
        if entry.get("type") == "user":
            msg = entry.get("message", {})
            content = msg.get("content", "")
            if isinstance(content, list):
                text = " ".join(
                    c.get("text", "") for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                )
            elif isinstance(content, str):
                text = content
            else:
                text = ""
            if text.strip():
                user_msgs.append(text.strip())

        elif entry.get("type") == "assistant":
            msg = entry.get("message", {})
            content = msg.get("content", [])
            if isinstance(content, list):
                text = " ".join(
                    c.get("text", "") for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                )
            elif isinstance(content, str):
                text = content
            else:
                text = ""
            if text.strip():
                assistant_msgs.append(text.strip())

            if user_msgs:
                pairs.append({
                    "user": user_msgs[-1][:300],
                    "assistant_preview": text.strip()[:200] if text.strip() else "",
                })

    return pairs


def analyze_session(filepath: str) -> dict:
    entries = parse_jsonl(filepath)

    user_messages = extract_user_messages(entries)
    assistant_summaries = extract_assistant_summaries(entries)

    corrections = []
    approvals = []
    decisions = []
    all_classified = []

    for msg in user_messages:
        signals = classify_message(msg["text"])
        classified = {**msg, **signals}
        all_classified.append(classified)

        if signals["is_correction"]:
            corrections.append(classified)
        if signals["is_approval"]:
            approvals.append(classified)
        if signals["has_decision"]:
            decisions.append(classified)

    session_meta = {
        "file": filepath,
        "total_entries": len(entries),
        "user_messages": len(user_messages),
        "assistant_messages": len(assistant_summaries),
        "corrections": len(corrections),
        "approvals": len(approvals),
        "decisions": len(decisions),
    }

    entry_types = defaultdict(int)
    for e in entries:
        entry_types[e.get("type", "unknown")] += 1

    return {
        "meta": session_meta,
        "entry_types": dict(entry_types),
        "corrections": [
            {"text": c["text"][:300], "triggers": c["correction_triggers"]}
            for c in corrections
        ],
        "approvals": [
            {"text": a["text"][:300], "triggers": a["approval_triggers"]}
            for a in approvals
        ],
        "decisions": [
            {"text": d["text"][:300], "triggers": d["decision_triggers"]}
            for d in decisions
        ],
        "process_flow": [
            {"text": m["text"][:150], "type": (
                "correction" if m["is_correction"]
                else "approval" if m["is_approval"]
                else "decision" if m["has_decision"]
                else "instruction"
            )}
            for m in all_classified
        ],
    }


def scan_sessions(base_dir: str = None) -> list[dict]:
    if base_dir is None:
        base_dir = os.path.expanduser("~/.claude/projects")

    sessions = []
    for jsonl_path in Path(base_dir).rglob("*.jsonl"):
        if "subagents" in str(jsonl_path):
            continue
        stat = jsonl_path.stat()
        sessions.append({
            "path": str(jsonl_path),
            "size_mb": round(stat.st_size / 1024 / 1024, 1),
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "project": jsonl_path.parent.name,
        })

    sessions.sort(key=lambda s: s["modified"], reverse=True)
    return sessions


def main():
    if len(sys.argv) < 2:
        print("Usage: analyze-session.py <jsonl-file|--scan|--scan-personal>")
        print()
        print("  <jsonl-file>     Analyze a specific JSONL session file")
        print("  --scan           List all available sessions")
        print("  --scan-personal  List only non-agent sessions (Max's terminal work)")
        sys.exit(1)

    if sys.argv[1] == "--scan":
        sessions = scan_sessions()
        for s in sessions:
            print(f"  {s['modified'][:16]}  {s['size_mb']:6.1f}MB  {s['project']}")
        print(f"\nTotal: {len(sessions)} sessions")

    elif sys.argv[1] == "--scan-personal":
        sessions = scan_sessions()
        agent_dirs = {
            "kaptein", "leon-kaptein", "leon-personal", "max-personal",
            "massivlust-dev", "massivlust-team", "ml-prosjektleder",
            "nordflo-dev", "martin-massivlust", "martin-thorvaldsen-venedik",
            "kaptein-massivlust", "-shared", "graphify-out",
        }
        personal = [
            s for s in sessions
            if not any(
                f"agents-{a}" in s["path"] or f"agents/{a}" in s["path"]
                for a in agent_dirs
            )
        ]
        for s in personal:
            print(f"  {s['modified'][:16]}  {s['size_mb']:6.1f}MB  {s['project']}")
        print(f"\nPersonal sessions: {len(personal)}")

    else:
        filepath = sys.argv[1]
        if not os.path.exists(filepath):
            print(f"File not found: {filepath}")
            sys.exit(1)

        result = analyze_session(filepath)

        if "--json" in sys.argv:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            meta = result["meta"]
            print(f"Session Analysis: {os.path.basename(filepath)}")
            print(f"{'='*60}")
            print(f"Messages: {meta['user_messages']} user, {meta['assistant_messages']} assistant")
            print(f"Signals:  {meta['corrections']} corrections, {meta['approvals']} approvals, {meta['decisions']} decisions")
            print()

            if result["corrections"]:
                print(f"CORRECTIONS ({len(result['corrections'])}):")
                for c in result["corrections"][:10]:
                    print(f"  - {c['text'][:120]}")
                print()

            if result["decisions"]:
                print(f"DECISIONS ({len(result['decisions'])}):")
                for d in result["decisions"][:10]:
                    print(f"  - {d['text'][:120]}")
                print()

            if result["approvals"]:
                print(f"APPROVALS ({len(result['approvals'])}):")
                for a in result["approvals"][:10]:
                    print(f"  - {a['text'][:120]}")
                print()

            print(f"PROCESS FLOW ({len(result['process_flow'])} steps):")
            for i, step in enumerate(result["process_flow"][:20]):
                marker = {
                    "correction": "✗",
                    "approval": "✓",
                    "decision": "◆",
                    "instruction": "→",
                }.get(step["type"], "?")
                print(f"  {marker} {step['text'][:100]}")


if __name__ == "__main__":
    main()
