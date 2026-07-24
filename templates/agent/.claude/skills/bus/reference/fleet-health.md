# Fleet health

## check-stale-tasks
Find stale tasks: in_progress >2h, pending >24h, stale human tasks, overdue.

```bash
cortextos bus check-stale-tasks [--all-orgs]
```

## check-goal-staleness
Check each agent's GOALS.md Updated timestamp. Flags goals older than threshold.

```bash
cortextos bus check-goal-staleness [--threshold DAYS] [--json]
```

## check-human-tasks
Check for stale human-assigned tasks and send reminders.

```bash
cortextos bus check-human-tasks
```

## archive-tasks
Archive completed tasks older than 7 days.

```bash
cortextos bus archive-tasks [--dry-run] [--all-orgs]
```
