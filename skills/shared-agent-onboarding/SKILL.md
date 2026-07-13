---
name: shared-agent-onboarding
description: "Registrer en ny bruker på en delt agent når de sender /start. Lagrer telegram_chat_id og onboarded_at i shared_agent_memberships. Use when: melding kommer inn med /start eller chat_id ikke finnes i routing-tabellen."
---

# Shared-agent onboarding

Når en ny bruker sender `/start` til en delt agent, eller agenten oppdager en ukjent chat_id, kall dette skillet for å registrere brukeren riktig.

## Flow

1. Bruker sender `/start` til bot (f.eks. kjoreplan-bot)
2. Agenten leser chat_id + telegram_username fra payload
3. Sjekker først i `shared_agent_memberships`:
   - Hvis chat_id alt mappet → svar "Du er allerede onboardet, X"
   - Hvis ikke mappet, men det finnes en `shared_agent_memberships`-rad med chat_id=NULL for denne agenten → spør bruker hvem de er (match mot existing shared_persons), eller match på username
   - Hvis verken chat_id eller person finnes → opprett ny person + ny membership

## Bruk via helper-script

```bash
# Sjekk om chat_id allerede er mappet
python3 onboard.py check_chat --agent kjoreplan --chat-id 6739017378

# Bind chat_id til en eksisterende person (typisk brukt etter brukeren bekrefter navn)
python3 onboard.py bind_chat \
  --agent kjoreplan \
  --chat-id 6739017378 \
  --short-name Eivind \
  --telegram-username eivindx

# Opprett HELT ny bruker (person + membership)
python3 onboard.py create_new \
  --agent jensen \
  --chat-id <id> \
  --short-name Andreas \
  --full-name "Andreas Larsen" \
  --email andreas@massivlust.no \
  --role montor

# List uombordet medlemskap for en agent (PL/montør uten chat_id)
python3 onboard.py list_pending --agent kjoreplan
```

## Output

JSON. `{"ok": true, "data": ...}` eller `{"ok": false, "error": "..."}`.

## Konvensjoner

- `short_name` = kallenavn brukt i pings (typisk fornavn): `Eivind`, `Vegard`, `Martin`
- `agent_name` = `jensen` | `ks-avvik` | `kjoreplan`
- `role` = `pl` | `montor` | `alex` | `ekstern` | `admin`
- `onboarded_at` settes automatisk til now()
- `last_seen_at` oppdateres ved hver `/start` eller første-melding-binding

## Konfliktshåndtering

- chat_id allerede bundet til en annen person på samme agent → returner error (krever Max-input)
- short_name finnes ikke + create_new ikke kjørt → spør bruker via Telegram før binding

## Sikkerhetsnotat

`create_new` har skrive-tilgang til `shared_persons` og `shared_agent_memberships`. Bruk kun fra agent-konteksten etter at bruker eksplisitt bekrefter sin identitet (typisk via knapp eller eksplisitt /start name=...).

## Env

- `SUPABASE_URL`, `MASSIVLUST_SUPABASE_SERVICE_ROLE_KEY`
