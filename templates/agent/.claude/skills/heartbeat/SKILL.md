---
name: heartbeat
description: "Your heartbeat cron has fired and you need to prove you're alive. Or you're checking whether another agent is responsive before sending them work. Or an agent appears offline/stale on the dashboard and you need to investigate. Any bus activity (log-event, create-task, send-message, etc.) auto-refreshes your `last_heartbeat` — so if you're doing work, you're already alive on the dashboard. Explicit update-heartbeat is for setting status text and current_task."
triggers: ["heartbeat", "update heartbeat", "check health", "agent health", "fleet health", "agent status", "is agent alive", "agent offline", "agent stale", "read heartbeats", "heartbeat cron", "i'm alive", "prove alive", "agent not responding", "stale agent", "check fleet", "fleet status", "who is online", "agent last seen"]
---

# Heartbeat

The heartbeat is how the dashboard and other agents know you're alive. If your `last_heartbeat` goes stale, you appear DEAD.

**Key fact:** any bus write (log-event, create-task, send-message, complete-task, etc.) auto-refreshes `last_heartbeat` on your heartbeat.json — activity = liveness. You only need `update-heartbeat` to set your **status text** and **current_task**.

---

## Your Heartbeat Cron

Your `config.json` has a heartbeat cron (default every 4h). When it fires:

```bash
# 1. Update your heartbeat with what you're doing (sets status + timestamp)
cortextos bus update-heartbeat "WORKING ON: <current task summary>"

# 2. Check inbox for messages
cortextos bus check-inbox

# 3. Check your task queue for anything stale
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status in_progress
```

No separate `log-event heartbeat agent_heartbeat` needed — `update-heartbeat` emits its own event, and check-inbox/list-tasks activity keeps you fresh regardless.

---

## Updating Heartbeat

```bash
cortextos bus update-heartbeat "<one sentence: what you are doing right now>"
```

Call this:
- On every heartbeat cron fire
- On session start (before sending online notification)
- When starting a new significant task
- Before going into a long-running operation

**Never claim a status you haven't verified.** If your crons were reset on restart, check `cortextos bus list-crons $CTX_AGENT_NAME` before saying "crons running."

---

## Reading Fleet Heartbeats

```bash
# All agents in the org
cortextos bus read-all-heartbeats

# JSON format for parsing
cortextos bus read-all-heartbeats --format json
```

Returns: agent name, status, last update timestamp, current task.

**Stale threshold:** An agent that hasn't updated in >6h should be investigated. Check their status via `cortextos status` or their heartbeat file.

---

## Checking a Specific Agent

```bash
# Read their heartbeat file directly
cat "$CTX_ROOT/state/<agent-name>/heartbeat.json"

# Check agent status via daemon
cortextos status

# Check PM2 process status
pm2 list
```

---

## Heartbeat File Schema

```json
{
  "agent": "agent-name",
  "status": "active | idle | crashed",
  "last_heartbeat": "2026-04-01T12:00:00Z",
  "current_task": "What I'm doing right now"
}
```

`last_heartbeat` is auto-refreshed on any bus write; `status` + `current_task` come from the last `update-heartbeat`.

Location: `$CTX_ROOT/state/{agent}/heartbeat.json`
