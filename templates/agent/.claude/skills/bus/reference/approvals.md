# Approvals

## create-approval
Request human approval before taking a high-stakes action. Required for: external comms, production deploys, data deletion, financial commitments. Auto-emits `approval/approval_created`.

```bash
cortextos bus create-approval "<title>" <category> "[context]"
```

- **title** (required): What you are requesting approval for
- **category** (required): `external-comms` | `financial` | `deployment` | `data-deletion` | `other`
- **context** (optional): Additional details to help the human decide

Example:
```bash
cortextos bus create-approval "Send cold outreach to 50 leads" external-comms "Draft in task_abc123. Target: SaaS founders."
```

## update-approval
Resolve an approval request (typically called by the system after human responds via Telegram). Auto-emits `approval/approval_updated`.

```bash
cortextos bus update-approval <approval_id> <approved|rejected> "[note]"
```

Example:
```bash
cortextos bus update-approval "appr_123" approved "User approved via Telegram"
```

See `.claude/skills/approvals/SKILL.md` for the full approval workflow (task blocking, notification, re-pinging).
