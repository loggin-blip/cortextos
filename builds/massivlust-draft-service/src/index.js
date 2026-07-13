import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const PORT = parseInt(process.env.PORT ?? '7778', 10);
const SECRET = process.env.DRAFT_API_SECRET;
const GMAIL_URL = process.env.GMAIL_API_URL ?? 'http://localhost:7777';
const GMAIL_SECRET = process.env.GMAIL_API_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!SECRET) { console.error('DRAFT_API_SECRET ikke satt'); process.exit(1); }
if (!GMAIL_SECRET) { console.error('GMAIL_API_SECRET ikke satt'); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY ikke satt'); process.exit(1); }

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

const app = express();
app.use(express.json());

function auth(req, res, next) {
  if (req.headers['x-draft-api-secret'] !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function readThread(threadId, employeeEmail) {
  const res = await fetch(`${GMAIL_URL}/threads/${threadId}?user=${encodeURIComponent(employeeEmail)}`, {
    headers: { 'X-Gmail-Api-Secret': GMAIL_SECRET },
  });
  if (!res.ok) throw new Error(`Gmail service ${res.status}: ${await res.text()}`);
  return res.json();
}

function buildThreadText(messages) {
  return messages.map((m, i) => {
    const body = (m.bodyText || m.snippet || '').trim().slice(0, 2000);
    return `--- Melding ${i + 1} ---\nFra: ${m.from} <${m.fromEmail}>\nTil: ${m.to || ''}\nDato: ${m.date}\nEmne: ${m.subject}\n\n${body}`;
  }).join('\n\n');
}

const SYSTEM_PROMPT = `Du er en assistent som genererer profesjonelle e-postutkast på vegne av ansatte i Massivlust AS, et massivtre-montasjeselskap.

Regler:
- Svar ALLTID på norsk bokmål
- Svar KUN på det som faktisk ble spurt om i siste melding
- Aldri hallusinér fakta, beløp, datoer eller paragrafhenvisninger du ikke kan verifisere
- Aldri siter NS-paragrafer med mindre du kan verifisere eksakt paragrafnummer
- Tone: formell overfor eksterne (Backe, Veidekke, Massivtre, Splitkon, bank, kommune), uformell overfor kolleger
- Ren tekst — ingen markdown i e-postbrødteksten
- Aldri skriv "takk for oversendelse" hvis de ikke sendte noe
- Aldri skriv "takk for invitasjonen" hvis de stilte et spørsmål

Svar med JSON på dette formatet:
{
  "action": "draft" | "no_reply",
  "reason": "<kort forklaring av hva du gjorde>",
  "draft_subject": "<Re: original emne>",
  "draft_body": "<ferdig e-posttekst med signatur>",
  "note_to_employee": "<valgfri: én linje hvis den ansatte må legge til noe spesifikt>"
}

Hvis ingen svar er nødvendig (automatisk varsel, allerede svart, spam, personlig mail), sett action="no_reply" og draft_body=null.`;

function buildSignature(employee) {
  if (!employee) return 'Med vennlig hilsen\n[navn]\nMassivlust AS\nmassivlust.no';
  return `Med vennlig hilsen\n${employee.full_name}\n${employee.title} | Massivlust AS\n${employee.phone} | ${employee.email}\nmassivlust.no`;
}

async function fetchEmployeeProfile(employeeEmail, supabaseUrl, supabaseKey) {
  if (!supabaseUrl || !supabaseKey) return null;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/massivlust_employees?email=eq.${encodeURIComponent(employeeEmail)}&select=full_name,title,phone&limit=1`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    const rows = await res.json();
    return rows[0] ? { ...rows[0], email: employeeEmail } : null;
  } catch {
    return null;
  }
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/draft', auth, async (req, res) => {
  const { thread_id, employee_email, instruction } = req.body;

  if (!thread_id || !employee_email) {
    return res.status(400).json({ error: 'thread_id og employee_email påkrevd' });
  }
  if (!employee_email.endsWith('@massivlust.no')) {
    return res.status(400).json({ error: 'Kun @massivlust.no tillatt' });
  }

  try {
    const [messages, employee] = await Promise.all([
      readThread(thread_id, employee_email),
      fetchEmployeeProfile(
        employee_email,
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY
      ),
    ]);

    if (!messages.length) {
      return res.status(404).json({ error: 'Tråden er tom' });
    }

    const threadText = buildThreadText(messages);
    const signature = buildSignature(employee);
    const lastMsg = messages[messages.length - 1];

    const userPrompt = `E-posttråd for ${employee_email}:

${threadText}

---
Signatur for ${employee_email}:
${signature}

${instruction ? `Instruksjon fra bruker: ${instruction}\n` : ''}
Siste melding er fra: ${lastMsg.from} <${lastMsg.fromEmail}>
Skriv utkast til svar fra ${employee_email}. Inkluder signaturen i draft_body.`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0]?.text ?? '';

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Modellen returnerte ikke gyldig JSON');
    const result = JSON.parse(jsonMatch[0]);

    console.log(`[draft] ${employee_email} / ${thread_id} → action=${result.action}`);
    res.json(result);
  } catch (e) {
    console.error('[draft] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`massivlust-draft-service kjører på http://127.0.0.1:${PORT}`);
});
