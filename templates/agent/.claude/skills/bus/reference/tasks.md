# Tasks

All task-mutation commands auto-emit their event — do NOT follow with a manual `log-event task ...`.

## create-task
Create a new task. Auto-emits `task/task_created`.

```bash
cortextos bus create-task "<title>" --desc "<description>" [--assignee <agent>] [--priority <p>] [--project <name>]
```

- **title** (required): Short task name
- **--desc** (optional): What needs to be done — be specific
- **--assignee** (optional): Agent name. Defaults to $CTX_AGENT_NAME
- **--priority** (optional): `urgent` | `high` | `normal` | `low`. Defaults to `normal`
- **--project** (optional): Project grouping

Example:
```bash
cortextos bus create-task "Write blog post" --desc "Draft a 500-word post on agent orchestration" --priority normal
```

## update-task
Update a task's status. Auto-emits `task/task_updated` (with `from` and `to`).

```bash
cortextos bus update-task "<task_id>" <status>
```

- **task_id** (required): The task ID from create-task or list-tasks
- **status** (required): `pending` | `in_progress` | `blocked` | `completed`

Example:
```bash
cortextos bus update-task "task_abc123" in_progress
```

Prefer `complete-task` over `update-task ... completed` — completion needs a result summary, and `complete-task` emits `task_completed` with outcome.

## complete-task
Mark a task as completed with a result. Auto-emits `task/task_completed` (with outcome).

```bash
cortextos bus complete-task "<task_id>" --result "<what you produced>" [--outcome success|failure]
```

- **task_id** (required): The task ID
- **--result** (optional): What was produced/accomplished
- **--outcome** (optional): `success` (default) | `failure` — set `failure` when the task shipped but did not achieve its goal. Feeds KPI dashboards.

Examples:
```bash
cortextos bus complete-task "task_abc123" --result "Deployed landing page. URL: https://site.com"
cortextos bus complete-task "task_def456" --result "Deploy attempted but Vercel build failed" --outcome failure
```

## list-tasks
List and filter tasks.

```bash
cortextos bus list-tasks [--status S] [--agent A] [--priority P] [--all-orgs]
```

- **--status**: Filter by `pending` | `in_progress` | `blocked` | `completed`
- **--agent**: Filter by agent name
- **--priority**: Filter by `urgent` | `high` | `normal` | `low`
- **--all-orgs**: Show tasks across all orgs

Example:
```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
```
