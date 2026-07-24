# Discovery

## list-agents
Discover all agents in the system.

```bash
cortextos bus list-agents [--org <org>] [--format json|text] [--status running|all]
```

## list-skills
List available skills for the current agent.

```bash
cortextos bus list-skills [--format text|json]
```

## read-all-heartbeats
Aggregate all agent heartbeats into a single JSON object keyed by agent name.

```bash
cortextos bus read-all-heartbeats [--format json]
```

Returns: agent name, status, last update timestamp, current task.

Stale threshold: an agent that hasn't updated in >6h should be investigated. Check via `cortextos status` or read their heartbeat file at `$CTX_ROOT/state/<agent>/heartbeat.json`.
