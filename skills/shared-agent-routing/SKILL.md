---
name: shared-agent-routing
description: "Lookup persons, chat_ids, projects, and roles for delte agenter (Jensen/ks-avvik/kjoreplan). Use when: agenten må vite hvem som skal motta en melding, eller hvem som skrev inn en melding (chat_id → person)."
---

# Shared-agent routing

Felles routing-lookup for alle delte agenter. All data ligger i `shared_agents.*` i Massivlust Supabase.

## Når brukes dette

- En cron skal sende meldinger til N brukere → hent kandidat-liste via `list_active`
- En melding kommer inn på Telegram, du har chat_id → finn hvem det er via `resolve_chat`
- Du skal pinge en spesifikk person → hent deres chat_id via `get_chat_id`

## Bruk via helper-script

```bash
# List aktive medlemmer for en agent
python3 lookup.py list_active --agent jensen
python3 lookup.py list_active --agent kjoreplan --role pl

# Hvem er denne chat_id?
python3 lookup.py resolve_chat --agent jensen --chat-id 6739017378

# Hent chat_id for en gitt person på en agent
python3 lookup.py get_chat_id --agent ks-avvik --short-name Eivind

# Hent alle prosjekter en person har
python3 lookup.py list_projects --short-name Vegard

# Hvem er PL på dette prosjektet?
python3 lookup.py project_role --project-id <uuid> --role pl
```

## Output

JSON til stdout, errors til stderr med exit 1.

```json
{
  "ok": true,
  "data": [
    {"short_name": "Eivind", "full_name": "Eivind Haarr Smedal", "chat_id": "6739017378", "role": "montor"}
  ]
}
```

## Schema-referanse

Tabellene ligger i schema `shared_agents`:
- `persons` — én rad per menneske
- `agent_memberships` — én rad per (person, agent)
- `person_projects` — én rad per (person, prosjekt)
- `cron_log` — audit-trail

Views: `v_active_users` (joined), `v_effective_quiet_hours`.

## Env-variabler

- `SUPABASE_URL` — fra `secrets.env`
- `MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY` — fra `secrets.env`

## Når IKKE bruke

Dette skillet gjør LOOKUP. For å registrere en ny bruker → bruk `shared-agent-onboarding`. For å sjekke OM en bruker skal motta en ping akkurat nå → bruk `shared-agent-preflight`.
