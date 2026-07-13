import 'dotenv/config';
import express from 'express';
import { hybridSearch, kbAvailable } from './search.js';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT ?? '7788', 10);
const SECRET = process.env.KB_API_SECRET;
if (!SECRET) {
  console.error('KB_API_SECRET mangler i .env — nekter å starte uten auth');
  process.exit(1);
}

// /health åpen (for launchd/tunnel-prober) — alt annet krever secret-header
app.get('/health', (_req, res) => res.json({ ok: true, service: 'massivlust-kb-service', kb: kbAvailable() }));

app.use((req, res, next) => {
  if (req.get('X-KB-Api-Secret') !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Service-side rate limit (siste skanse hvis secret lekker)
const buckets = new Map();
function rateLimit(key, max = 60, windowMs = 60_000) {
  const now = Date.now();
  const b = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (b.length >= max) return false;
  b.push(now); buckets.set(key, b); return true;
}

// POST /search { question, identity: { email, role }, k? }
// identity er PÅKREVD — tjenesten gater collections/scope på rollen.
app.post('/search', async (req, res) => {
  try {
    if (!kbAvailable()) return res.status(503).json({ error: 'KB ikke tilgjengelig (mmrag mangler)' });
    const { question, identity, k } = req.body ?? {};
    if (!question || typeof question !== 'string') return res.status(400).json({ error: 'question mangler' });
    if (!identity || !identity.role) return res.status(400).json({ error: 'identity { email, role } er påkrevd' });
    if (!rateLimit(`search:${identity.email ?? identity.role}`)) return res.status(429).json({ error: 'Too many requests' });

    const out = await hybridSearch({ question: question.trim(), identity, k: Math.min(Math.max(k ?? 8, 1), 20) });
    res.json(out);
  } catch (e) {
    console.error('[kb-service] /search feilet:', e?.message ?? e);
    res.status(500).json({ error: 'Søk feilet' });
  }
});

app.listen(PORT, () => console.log(`massivlust-kb-service lytter på :${PORT}`));
