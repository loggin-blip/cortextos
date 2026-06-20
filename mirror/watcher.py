#!/usr/bin/env python3
"""Mirror v1 — Session watcher.

Monitors ~/.claude/projects/ for new or updated JSONL files.
When a session is modified, queues it for analysis.
Maintains a state file tracking what's been processed.

Designed to run as a cron (every 30 min) or continuous daemon.
"""

import json
import os
import sys
import hashlib
from pathlib import Path
from datetime import datetime

STATE_FILE = os.path.expanduser("~/.cortextos/mirror/watcher-state.json")
EXTRACTS_DIR = os.path.expanduser("~/.cortextos/mirror/extracts")
KNOWLEDGE_DIR = os.path.expanduser("~/.cortextos/mirror/knowledge")
PROJECTS_DIR = os.path.expanduser("~/.claude/projects")

def is_agent_session(path: str) -> bool:
    return "agents-" in path or "agents/" in path


def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {"processed": {}, "last_run": None}


def save_state(state: dict):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def file_hash(filepath: str) -> str:
    stat = os.stat(filepath)
    return hashlib.md5(f"{filepath}:{stat.st_size}:{stat.st_mtime}".encode()).hexdigest()


def scan_for_changes(state: dict) -> list[dict]:
    changes = []
    for jsonl_path in Path(PROJECTS_DIR).rglob("*.jsonl"):
        path_str = str(jsonl_path)
        if "subagents" in path_str:
            continue
        if is_agent_session(path_str):
            continue

        current_hash = file_hash(path_str)
        stored_hash = state["processed"].get(path_str, {}).get("hash", "")

        if current_hash != stored_hash:
            stat = jsonl_path.stat()
            changes.append({
                "path": path_str,
                "hash": current_hash,
                "size_mb": round(stat.st_size / 1024 / 1024, 1),
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "project": jsonl_path.parent.name,
                "is_new": path_str not in state["processed"],
            })

    return changes


def process_session(filepath: str) -> dict | None:
    """Import and run synthesizer on a session file."""
    try:
        sys.path.insert(0, os.path.dirname(__file__))
        from synthesize import build_session_summary, generate_knowledge_extract

        summary = build_session_summary(filepath)
        extract = generate_knowledge_extract(summary)

        os.makedirs(EXTRACTS_DIR, exist_ok=True)
        session_id = Path(filepath).stem
        project = Path(filepath).parent.name
        outfile = os.path.join(EXTRACTS_DIR, f"{project}_{session_id[:8]}.md")

        with open(outfile, "w") as f:
            f.write(extract)

        return {
            "extract_file": outfile,
            "stats": summary["stats"],
            "project": project,
        }
    except Exception as e:
        return {"error": str(e), "path": filepath}


def run_watch_cycle(dry_run: bool = False) -> dict:
    state = load_state()
    changes = scan_for_changes(state)

    results = {
        "timestamp": datetime.now(tz=None).isoformat(),
        "changes_found": len(changes),
        "processed": [],
        "errors": [],
    }

    if not changes:
        state["last_run"] = results["timestamp"]
        save_state(state)
        return results

    for change in changes:
        if dry_run:
            results["processed"].append({
                "path": change["path"],
                "action": "would_process",
                "size_mb": change["size_mb"],
                "project": change["project"],
            })
            continue

        result = process_session(change["path"])
        if result and "error" not in result:
            state["processed"][change["path"]] = {
                "hash": change["hash"],
                "last_processed": datetime.now(tz=None).isoformat(),
                "extract_file": result["extract_file"],
            }
            results["processed"].append(result)
        elif result:
            results["errors"].append(result)

    state["last_run"] = results["timestamp"]
    if not dry_run:
        save_state(state)

    return results


def main():
    if "--dry-run" in sys.argv:
        results = run_watch_cycle(dry_run=True)
        print(json.dumps(results, indent=2, ensure_ascii=False))
    elif "--status" in sys.argv:
        state = load_state()
        print(f"Last run: {state.get('last_run', 'never')}")
        print(f"Sessions tracked: {len(state.get('processed', {}))}")
        for path, info in state.get("processed", {}).items():
            print(f"  {info.get('last_processed', '?')[:16]}  {Path(path).parent.name}")
    elif "--run" in sys.argv:
        results = run_watch_cycle()
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        print("Usage: watcher.py [--run|--dry-run|--status]")
        print()
        print("  --run       Process new/changed sessions")
        print("  --dry-run   Show what would be processed")
        print("  --status    Show current tracking state")


if __name__ == "__main__":
    main()
