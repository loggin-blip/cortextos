# Experiments (Theta Wave)

## create-experiment
Create a new experiment proposal. For system-scope, auto-creates an approval.

```bash
cortextos bus create-experiment <metric_name> "<hypothesis>" [--surface <path>] [--direction higher|lower] [--window <duration>] [--measurement <cmd>]
```

## run-experiment
Start running a proposed experiment.

```bash
cortextos bus run-experiment <experiment_id> [changes_description]
```

## evaluate-experiment
Evaluate a running experiment and decide keep/discard.

```bash
cortextos bus evaluate-experiment <experiment_id> <measured_value> [--score <1-10>] [--justification "<text>"]
```

## list-experiments
List experiments with filters.

```bash
cortextos bus list-experiments [--agent <name>] [--status <status>] [--metric <name>] [--json]
```

## gather-context
Collect experiment context for hypothesis generation.

```bash
cortextos bus gather-context [--agent <name>] [--metric <name>] [--format json|markdown]
```
