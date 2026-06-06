# Mirror — Architecture

## What it does today (v1)

Three scripts that form a pipeline:

1. **analyze-session.py** — Takes a JSONL file, classifies each user message as correction/approval/decision/instruction, outputs structured analysis
2. **synthesize.py** — Takes a JSONL file, extracts what was built (files, tools, stack) and how Max worked (process flow, iterations), outputs knowledge extract
3. **watcher.py** — Scans ~/.claude/projects/ for new/changed sessions, filters out agent sessions, runs synthesizer on personal terminal work, saves extracts to ~/.cortextos/mirror/extracts/

## What it needs next (v2)

### Pattern Aggregator
Reads all extracts and builds layered knowledge:
- **core.md** — universal patterns across all project types
- **dashboard.md** — dashboard-specific patterns
- **website.md** — website-specific patterns
- Detects: "Max always does X", "Max never accepts Y", "Max's process is: A → B → C"

### Session Bootstrapper
When Max starts a new terminal session:
- Detects the project type (from file structure)
- Loads the right knowledge layer
- Generates a context brief: "Last session you were working on X, you were stuck on Y, suggested next step is Z"
- Injects via CLAUDE.md or session startup

### Real-time Mode
Instead of cron-based batch processing:
- File watcher (fswatch/inotify) on ~/.claude/projects/
- Process new messages as they arrive
- Build live project status dashboard

## Data flow

```
Terminal session (JSONL)
    ↓
watcher.py (detect changes)
    ↓
synthesize.py (extract patterns)
    ↓
~/.cortextos/mirror/extracts/ (per-session)
    ↓
[v2] aggregator (merge into knowledge layers)
    ↓
[v2] core.md / dashboard.md / website.md
    ↓
[v2] CLAUDE.md injection (next session is smarter)
```

## File locations

| What | Where |
|------|-------|
| Scripts | /Users/max/cortextos/mirror/ |
| Watcher state | ~/.cortextos/mirror/watcher-state.json |
| Session extracts | ~/.cortextos/mirror/extracts/ |
| Knowledge layers | ~/.cortextos/mirror/knowledge/ (v2) |
