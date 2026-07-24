---
name: bus
description: cortextos bus CLI. Table of contents + 10 most-used commands. For less-common commands, Read the matching reference/ file on demand.
triggers:
  - bus
  - cortextos bus
  - list-tasks
  - create-task
  - send-telegram
  - check-inbox
  - log-event
  - update-heartbeat
  - how do I
  - what command
---

# cortextos bus — CLI reference

All commands are `cortextos bus <command>`. This file lists the 10 most-used commands inline. Everything else lives in `reference/` — Read only the file you need.

## Auto-emit — read this once

Many events are emitted for you by the commands themselves:

| You call | Bus auto-emits |
|----------|---------------|
| `create-task` | `task/task_created` |
| `update-task` | `task/task_updated` (with `from`/`to`) |
| `complete-task` | `task/task_completed` (with `outcome`) |
| `send-message` | `message/agent_message_sent` |
| `create-approval` | `approval/approval_created` |
| `update-approval` | `approval/approval_updated` |
| `update-heartbeat` | (refreshes `last_heartbeat` — activity = liveness) |
| `log-event` (any) | refreshes `last_heartbeat` as a side-effect |

Do NOT manually re-log those with `log-event` — it produces duplicates with mismatched shapes and breaks dashboard filters.

Bus always injects `agent`, `org`, `timestamp`, and `id` into the event envelope. Never put `"agent":"..."` in `--meta`.

Categories `task`, `message`, `approval`, `heartbeat` are reserved for auto-emit. When *you* call `log-event`, use: `action` | `error` | `metric` | `milestone` | `agent_activity`.

## Reference index

| File | Commands |
|------|----------|
| `reference/tasks.md` | create-task, update-task, complete-task, list-tasks |
| `reference/messages.md` | send-message, check-inbox, ack-inbox, notify-agent |
| `reference/telegram.md` | send-telegram, edit-message, answer-callback, post-activity |
| `reference/events.md` | log-event (what to log manually vs. auto-emit) |
| `reference/heartbeat.md` | update-heartbeat |
| `reference/approvals.md` | create-approval, update-approval |
| `reference/discovery.md` | list-agents, list-skills, read-all-heartbeats |
| `reference/fleet-health.md` | check-stale-tasks, check-goal-staleness, check-human-tasks, archive-tasks |
| `reference/experiments.md` | create/run/evaluate/list-experiments, gather-context |
| `reference/lifecycle.md` | self-restart, hard-restart, auto-commit, check-upstream |
| `reference/community.md` | browse-catalog, install/prepare/submit-community-item |
| `reference/tools.md` | agent-browser, peekaboo, gog (external CLIs) |

## 10 most-used commands

### update-heartbeat
Set status text + current_task. Any bus write already refreshes `last_heartbeat`, so this is for *what* you're doing, not proving you're alive.
```bash
cortextos bus update-heartbeat "<current_task_summary>"
```

### check-inbox
Process incoming messages. Run every heartbeat.
```bash
cortextos bus check-inbox
```

### ack-inbox
Acknowledge a message so it doesn't redeliver.
```bash
cortextos bus ack-inbox "<message_id>"
```

### create-task
Create a tracked task. Every piece of work >10 min = at least 1 task. Auto-emits `task_created`.
```bash
cortextos bus create-task "<title>" --desc "<what needs doing>"
```

### complete-task
Mark task done with result summary. Auto-emits `task_completed` (with outcome).
```bash
cortextos bus complete-task "<task_id>" --result "<what you produced>" [--outcome success|failure]
```

`--outcome` defaults to `success`. Set `failure` when the task shipped but did not achieve its goal (deploy attempted but failed, report drafted but blocked, etc.) — KPI accuracy depends on it.

### log-event
Log activity that bus doesn't already know about (session boundaries, milestones, real errors, orchestrator coordination).
```bash
cortextos bus log-event <category> <event_name> <severity> --meta '<json>'
# Categories YOU use: action | error | metric | milestone | agent_activity
# Severity: info | warning | error | critical
```

### send-telegram
Message the user.
```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" "<message>"
```

### send-message
Message another agent. Include reply_to when responding. Auto-emits `agent_message_sent`.
```bash
cortextos bus send-message <agent> <priority> '<body>' [reply_to]
# Priority: urgent | high | normal | low
```

### create-approval
Request human approval before external comms / prod deploy / financial commit. Auto-emits `approval_created`.
```bash
cortextos bus create-approval "<title>" <category> "[context]"
# Categories: external-comms | financial | deployment | data-deletion | other
```

### list-tasks
See your queue.
```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
```

## When to load reference/ files

- User asks about a command NOT in the 10 above → Read the matching `reference/<domain>.md`
- You're about to invoke an unfamiliar command → Read its reference file first
- You need parameter details, flags, or examples → Read the reference file

Do NOT pre-load reference files. They exist to be read on demand.
