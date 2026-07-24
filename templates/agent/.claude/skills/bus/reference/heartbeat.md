# Heartbeat

## update-heartbeat
Set your status text + current_task. Any bus write already refreshes `last_heartbeat` — this command is for *what* you're doing, not proving you're alive.

```bash
cortextos bus update-heartbeat "<current_task_summary>"
```

- **current_task_summary** (required): 1 sentence describing what you are doing right now

Call this:
- On every heartbeat cron fire (with WORKING ON: ...)
- On session start (before sending online notification)
- When starting a new significant task
- Before going into a long-running operation

Examples:
```bash
cortextos bus update-heartbeat "WORKING ON: Implementing user auth for the dashboard"
cortextos bus update-heartbeat "online"
cortextos bus update-heartbeat "restarting"
```

Never claim a status you haven't verified. If crons reset on restart, run `cortextos bus list-crons $CTX_AGENT_NAME` before saying "crons running."
