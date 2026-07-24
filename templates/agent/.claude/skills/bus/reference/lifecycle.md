# Lifecycle

## self-restart
Restart with `--continue` (preserves conversation history).

```bash
cortextos bus self-restart --reason "why"
```

Ask the user first ("Fresh restart or continue with conversation history?") — do NOT restart until they specify which type.

## hard-restart
Kill and relaunch (fresh session, no history).

```bash
cortextos bus hard-restart --reason "why"
```

Sessions auto-restart with `--continue` every ~71 hours. On context exhaustion, notify user via Telegram then hard-restart.

## auto-commit
Automatic daily snapshot of agent workspace changes. Local only, never pushes.

```bash
cortextos bus auto-commit [--dry-run]
```

## check-upstream
Check for framework updates from the canonical repo.

```bash
cortextos bus check-upstream [--apply]
```
