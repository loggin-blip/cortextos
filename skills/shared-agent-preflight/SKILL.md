---
name: shared-agent-preflight
description: "Sjekk om en bruker skal motta en ping akkurat nå (aktiv + utenfor quiet-hours + ikke på ferie + ikke nylig pinget + har items). Use when: en cron-skill skal sende meldinger til flere brukere og må filtrere før send."
---

# Shared-agent preflight

Deterministisk filter som kjøres FØR en ping sendes. Returnerer go/no-go + årsak. Logger til `cron_log` automatisk.

## Når brukes dette

Hver gang en cron-skill itererer over en brukerliste og skal sende per-bruker-meldinger:

```
for person in routing.list_active(agent=...):
    decision = preflight.check(person_id, agent, cron_name, cooldown_hours=4)
    if decision.go:
        send_telegram(person.chat_id, message)
        preflight.log(person_id, agent, cron_name, outcome="sent")
    else:
        preflight.log(person_id, agent, cron_name, outcome=f"skipped_{decision.reason}")
```

## Sjekker (i rekkefølge, fail-fast)

1. **inactive** — `shared_persons.active = false OR shared_agent_memberships.active = false`
2. **quiet_hours** — nåtid er innenfor `shared_v_effective_quiet_hours` for (person, agent)
3. **vacation** — Google Calendar har "ferie/fri/sykmeldt" for i dag (krever GOOGLE_USER env eller fallback til shared_persons.email)
4. **cooldown** — Siste `shared_cron_log` med outcome=sent for samme (person, cron) er innenfor cooldown-vinduet
5. **no_items** — Krever caller å oppgi item-count; preflight sjekker ikke selv (kan ikke vite hva som er "items" for hver cron)

## Bruk via helper-script

```bash
# Sjekk én person
python3 preflight.py check \
  --person-id <uuid> \
  --agent jensen \
  --cron-name dagrapport-ping \
  --cooldown-hours 4 \
  --has-items true

# Output:
# {"go": true, "reason": "ok"}
# eller
# {"go": false, "reason": "cooldown", "last_sent_at": "2026-06-29T07:30:00Z"}

# Log resultat (uten faktisk send)
python3 preflight.py log \
  --person-id <uuid> \
  --agent jensen \
  --cron-name dagrapport-ping \
  --outcome sent \
  --metadata '{"item_count": 3}'
```

## Vacation-sjekk

Bruker Google Calendar MCP for det. Stikkord-match (case-insensitive):
- ferie, fri, sykmeldt, syk, vacation, holiday, permisjon

Hvis Calendar-API ikke er tilgjengelig (ingen credentials): hopper over vacation-sjekken og fortsetter (fail-open for det steget, slik at agenten ikke blir paralysert hvis Calendar er nede). Logger som metadata.

## Env

- `SUPABASE_URL`, `MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY` — for cron_log + persons-lookup
- `GOOGLE_CALENDAR_SKIP=1` — hopp over vacation-sjekk (testing eller hvis MCP utilgjengelig)

## Når IKKE bruke

For å bygge selve brukerlisten → bruk `shared-agent-routing`. For å registrere ny bruker → bruk `shared-agent-onboarding`.
