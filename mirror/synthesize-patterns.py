#!/usr/bin/env python3
"""Mirror — Pattern synthesizer.

Reads .mirror/decisions.log files from across projects,
groups by type (DECISION/CORRECTION/REJECTED/APPROVED),
and produces patterns.md files that feed back into sessions.

Run periodically or manually to update knowledge layers.
"""

import os
import re
import json
import sys
from pathlib import Path
from datetime import datetime
from collections import defaultdict


MIRROR_DIRS = []
KNOWLEDGE_DIR = os.path.expanduser("~/.cortextos/mirror/knowledge")


def find_mirror_dirs(search_roots: list[str] = None) -> list[str]:
    if search_roots is None:
        search_roots = [
            os.path.expanduser("~"),
            os.path.expanduser("~/cortextos"),
            os.path.expanduser("~/cortextos/builds"),
            os.path.expanduser("~/cortextos/dashboard"),
        ]

    dirs = []
    for root in search_roots:
        mirror_dir = os.path.join(root, ".mirror")
        if os.path.isdir(mirror_dir):
            decisions_log = os.path.join(mirror_dir, "decisions.log")
            if os.path.exists(decisions_log):
                dirs.append(mirror_dir)
    return dirs


def parse_decisions_log(filepath: str) -> list[dict]:
    entries = []
    pattern = re.compile(
        r"^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s+"
        r"(DECISION|CORRECTION|REJECTED|APPROVED):\s+(.+)$"
    )

    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            match = pattern.match(line)
            if match:
                entries.append({
                    "timestamp": match.group(1),
                    "type": match.group(2),
                    "content": match.group(3),
                    "source": filepath,
                })
    return entries


def parse_session_brief(filepath: str) -> dict | None:
    if not os.path.exists(filepath):
        return None
    with open(filepath) as f:
        content = f.read()
    return {
        "path": filepath,
        "content": content,
        "modified": datetime.fromtimestamp(os.path.getmtime(filepath)).isoformat(),
    }


def group_entries(all_entries: list[dict]) -> dict:
    grouped = {
        "DECISION": [],
        "CORRECTION": [],
        "REJECTED": [],
        "APPROVED": [],
    }
    for entry in all_entries:
        entry_type = entry.get("type", "")
        if entry_type in grouped:
            grouped[entry_type].append(entry)
    return grouped


def generate_patterns_md(grouped: dict, project_name: str = "global") -> str:
    lines = []
    lines.append(f"# Patterns — {project_name}")
    lines.append(f"Generated: {datetime.now().isoformat()[:16]}")
    lines.append(f"Source: {sum(len(v) for v in grouped.values())} entries")
    lines.append("")

    if grouped["CORRECTION"]:
        lines.append("## Anti-Patterns (things to avoid)")
        lines.append("These are corrections the user has made. Don't repeat these mistakes.")
        lines.append("")
        for entry in grouped["CORRECTION"]:
            lines.append(f"- {entry['content']}")
        lines.append("")

    if grouped["REJECTED"]:
        lines.append("## Rejected Approaches")
        lines.append("The user rejected these — don't suggest them again.")
        lines.append("")
        for entry in grouped["REJECTED"]:
            lines.append(f"- {entry['content']}")
        lines.append("")

    if grouped["APPROVED"]:
        lines.append("## Confirmed Standards")
        lines.append("The user explicitly approved these — they represent the quality bar.")
        lines.append("")
        for entry in grouped["APPROVED"]:
            lines.append(f"- {entry['content']}")
        lines.append("")

    if grouped["DECISION"]:
        lines.append("## Decisions & Preferences")
        lines.append("")
        for entry in grouped["DECISION"]:
            lines.append(f"- {entry['content']}")
        lines.append("")

    return "\n".join(lines)


def synthesize(search_roots: list[str] = None, output_dir: str = None):
    if output_dir is None:
        output_dir = KNOWLEDGE_DIR

    mirror_dirs = find_mirror_dirs(search_roots)

    if not mirror_dirs:
        print("No .mirror/decisions.log files found.")
        print("Start a Claude Code session and work on something — decisions will be logged automatically.")
        return

    all_entries = []
    per_project = defaultdict(list)

    for mirror_dir in mirror_dirs:
        decisions_file = os.path.join(mirror_dir, "decisions.log")
        entries = parse_decisions_log(decisions_file)
        all_entries.extend(entries)

        project_root = os.path.dirname(mirror_dir)
        project_name = os.path.basename(project_root) or "home"
        per_project[project_name].extend(entries)

    os.makedirs(output_dir, exist_ok=True)

    global_grouped = group_entries(all_entries)
    global_patterns = generate_patterns_md(global_grouped, "global")
    global_path = os.path.join(output_dir, "patterns-global.md")
    with open(global_path, "w") as f:
        f.write(global_patterns)
    print(f"Global patterns: {global_path} ({len(all_entries)} entries)")

    for project_name, entries in per_project.items():
        grouped = group_entries(entries)
        patterns = generate_patterns_md(grouped, project_name)
        project_path = os.path.join(output_dir, f"patterns-{project_name}.md")
        with open(project_path, "w") as f:
            f.write(patterns)
        print(f"  {project_name}: {project_path} ({len(entries)} entries)")

    if all_entries:
        also_write_to_projects(per_project)


def also_write_to_projects(per_project: dict):
    """Write patterns.md back into each project's .mirror/ dir for Claude to read."""
    for project_name, entries in per_project.items():
        grouped = group_entries(entries)
        patterns = generate_patterns_md(grouped, project_name)

        for mirror_dir in find_mirror_dirs():
            project_root = os.path.dirname(mirror_dir)
            if os.path.basename(project_root) == project_name or (
                project_name == "home" and project_root == os.path.expanduser("~")
            ):
                patterns_path = os.path.join(mirror_dir, "patterns.md")
                with open(patterns_path, "w") as f:
                    f.write(patterns)
                print(f"  → Updated {patterns_path}")


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print("Usage: synthesize-patterns.py [--scan] [--output <dir>]")
        print()
        print("  (no args)   Synthesize patterns from all .mirror/decisions.log files")
        print("  --scan      Just show what .mirror dirs exist")
        print("  --output    Write patterns to specified dir instead of default")
        return

    if "--scan" in sys.argv:
        dirs = find_mirror_dirs()
        if dirs:
            print("Found .mirror directories:")
            for d in dirs:
                log = os.path.join(d, "decisions.log")
                count = len(parse_decisions_log(log)) if os.path.exists(log) else 0
                brief = "yes" if os.path.exists(os.path.join(d, "last-session.md")) else "no"
                print(f"  {d}  ({count} decisions, brief: {brief})")
        else:
            print("No .mirror directories found yet.")
            print("Start a Claude Code session — decisions.log will be created automatically.")
        return

    output_dir = None
    if "--output" in sys.argv:
        idx = sys.argv.index("--output")
        if idx + 1 < len(sys.argv):
            output_dir = sys.argv[idx + 1]

    synthesize(output_dir=output_dir)


if __name__ == "__main__":
    main()
