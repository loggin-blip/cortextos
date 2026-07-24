# Community catalog

## browse-catalog
Browse community catalog for skills, agents, or org templates.

```bash
cortextos bus browse-catalog [--type skill|agent|org] [--tag <tag>] [--search <query>]
```

## install-community-item
Install a community catalog item.

```bash
cortextos bus install-community-item <item-name> [--dry-run]
```

## prepare-submission
Prepare a skill/agent/org for community submission (PII scan + staging).

```bash
cortextos bus prepare-submission <type> <source-path> <item-name> [--dry-run]
```

## submit-community-item
Submit a prepared item to the community catalog.

```bash
cortextos bus submit-community-item <item-name> <item-type> "<description>" [--dry-run]
```
