# Events (log-event)

## What bus already auto-emits — do NOT log manually

| You call | Bus auto-emits |
|----------|---------------|
| `create-task` | `task/task_created` |
| `update-task` | `task/task_updated` (with `from`/`to`) |
| `complete-task` | `task/task_completed` (with `outcome`) |
| `send-message` | `message/agent_message_sent` |
| `create-approval` | `approval/approval_created` |
| `update-approval` | `approval/approval_updated` |
| `update-heartbeat` | refreshes `last_heartbeat` (no event needed) |
| `log-event` (ANY) | refreshes `last_heartbeat` as a side-effect |

Categories `task`, `message`, `approval`, `heartbeat` are RESERVED for auto-emit. Do not use them yourself.

## log-event
Log activity bus doesn't already know about.

```bash
cortextos bus log-event <category> <event_name> <severity> [--meta '<json_payload>']
```

- **category** (YOU use): `action` | `error` | `metric` | `milestone` | `agent_activity`
- **event_name**: Descriptive canonical name (see KNOWN_EVENT_NAMES). Unknown names produce a stderr warn.
- **severity**: `info` | `warning` | `error` | `critical`
- **--meta**: JSON string. NEVER put `"agent":"..."` — bus injects `agent`, `org`, `timestamp`, `id` automatically.

## When YOU should log manually

### Session boundaries
Bus doesn't see conversation start/end.
```bash
cortextos bus log-event action session_start info
cortextos bus log-event action session_end info
```

### Real errors (not caught-and-recovered flows)
```bash
cortextos bus log-event error deploy_failed error --meta '{"operation":"vercel deploy","error":"build timeout"}'
```

### Milestones (business/project meaning)
```bash
cortextos bus log-event milestone project_delivered info --meta '{"project":"VG54","deliverable":"dagrapport"}'
```

### Research/analysis cycle complete
```bash
cortextos bus log-event action research_complete info --meta '{"topic":"competitor analysis","findings":3}'
```

### Orchestrator coordination
Bus doesn't know a send-message is conceptually a task dispatch. Log for KPI.
```bash
cortextos bus log-event action task_dispatched info --meta '{"to":"eivind-massivlust","task":"KS Verksgata"}'
cortextos bus log-event action briefing_sent info --meta '{"type":"morning_review"}'
```

## Malformed JSON
Malformed `--meta` is preserved under `metadata._raw` with `_meta_parse_error: true` and a stderr warning. Check stderr if piping bash-escaped JSON.

## Unknown event_name
Produces a stderr warn but the event is still written. Canonical names live in `src/utils/validate.ts:KNOWN_EVENT_NAMES`. Add new ones there so dashboard filters pick them up.
