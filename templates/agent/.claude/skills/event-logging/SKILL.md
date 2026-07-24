---
name: event-logging
description: "You need to record something the bus doesn't already know about — a session boundary, a research/analysis cycle finishing, a milestone hit, or a real error. Use `log-event` for events bus can't derive. Do NOT log task/message/approval events manually — the bus auto-emits those from create-task, update-task, complete-task, send-message, create-approval, update-approval. Duplicating those is the top source of noisy feeds. If you're active but see no events on the dashboard, either you've done nothing observable or you're only doing things bus already tracks."
triggers: ["log event", "log activity", "activity feed", "event log", "track activity", "record event", "log session", "log research", "log milestone", "log error", "no events", "invisible on dashboard", "dashboard empty", "nothing showing", "session start event", "log warning"]
---

# Event Logging

Events are how the dashboard activity feed sees you. But you don't have to log everything by hand — the bus does most of the work automatically. Your job is to log the things bus **cannot** derive.

---

## What bus already auto-emits (do NOT log these manually)

| You call | Bus auto-emits |
|----------|---------------|
| `create-task` | `task/task_created` |
| `update-task` | `task/task_updated` (with `from`/`to`) |
| `complete-task` | `task/task_completed` (with `outcome`) |
| `send-message` | `message/agent_message_sent` |
| `create-approval` | `approval/approval_created` |
| `update-approval` | `approval/approval_updated` |
| `log-event` (ANY category) | refreshes your `last_heartbeat` as a side-effect — activity = liveness |

Manually re-logging any of these produces duplicates with mismatched shapes and breaks dashboard filtering.

---

## Command

```bash
cortextos bus log-event <category> <event_name> <severity> [--meta '<json>']
```

| Parameter | Options |
|-----------|---------|
| category | `action` `error` `metric` `milestone` `agent_activity` (`task` `message` `approval` `heartbeat` are reserved for auto-emit) |
| severity | `info` `warning` `error` `critical` |

**No `agent` field in `--meta`.** Bus already injects `agent`, `org`, `timestamp`, and `id` into every event envelope. Adding `"agent":"..."` to meta duplicates that field.

**Malformed JSON in `--meta` is preserved under `metadata._raw` with `_meta_parse_error: true` and a stderr warning** — no more silent swallow, but check stderr if you're piping bash-escaped JSON.

**Unknown `event_name` produces a stderr warn.** Dashboard filters on canonical names in `src/utils/validate.ts:KNOWN_EVENT_NAMES` — a typo like `task_done` (vs `task_completed`) disappears from feeds silently otherwise.

---

## Events you SHOULD log manually

### Session start / end
Bus doesn't see session boundaries. The daemon knows a process is up, but not that this specific conversation began.

```bash
cortextos bus log-event action session_start info
cortextos bus log-event action session_end info
```

### Research or analysis cycle complete
```bash
cortextos bus log-event action research_complete info \
  --meta '{"topic":"<topic>","findings":3}'
```

### Milestone hit (business/project meaning)
```bash
cortextos bus log-event milestone <name> info \
  --meta '{"context":"<what happened>"}'
```

### Real error (not a caught-and-recovered flow)
```bash
cortextos bus log-event error <operation>_failed error \
  --meta '{"operation":"<what failed>","error":"<message>"}'
```

### Orchestrator coordination events (task_dispatched, briefing_sent, etc.)
Bus doesn't know these are conceptually different from a plain send-message. Log them for KPI.
```bash
cortextos bus log-event action task_dispatched info \
  --meta '{"to":"<agent>","task":"<title>"}'

cortextos bus log-event action briefing_sent info \
  --meta '{"type":"morning_review"}'
```

---

## Target

- 1 event at session start, 1 at session end.
- 1 event per real error, per milestone, per completed research cycle.
- Coordination events for orchestrators (task_dispatched, briefing_sent).
- Everything else — task lifecycle, messages, approvals — is bus's job. Don't double-log.
