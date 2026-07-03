import express from 'express';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  listInbox, getThread, getLabelCounts, getUserLabels,
  modifyMessage, getAttachment,
} from './gmail.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '7777', 10);
const SECRET = process.env.GMAIL_API_SECRET;
const SA_KEY = join(__dirname, '..', 'google-sa-key.json');

if (!SECRET) { console.error('GMAIL_API_SECRET er ikke satt'); process.exit(1); }
if (!existsSync(SA_KEY)) { console.error('google-sa-key.json mangler i service-roten'); process.exit(1); }

const app = express();
app.use(express.json());

function auth(req, res, next) {
  if (req.headers['x-gmail-api-secret'] !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function userEmail(req, res) {
  const u = req.query.user ?? req.body?.user;
  if (!u) { res.status(400).json({ error: 'user parameter required' }); return null; }
  if (!u.endsWith('@massivlust.no')) { res.status(400).json({ error: 'Kun @massivlust.no tillatt' }); return null; }
  return u;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/inbox', auth, async (req, res) => {
  const u = userEmail(req, res); if (!u) return;
  try {
    const messages = await listInbox(u, {
      label: req.query.label ?? 'INBOX',
      limit: parseInt(req.query.limit ?? '50', 10),
      category: req.query.category,
      q: req.query.q,
    });
    res.json(messages);
  } catch (e) {
    console.error('/inbox error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/threads/:id', auth, async (req, res) => {
  const u = userEmail(req, res); if (!u) return;
  try {
    const messages = await getThread(u, req.params.id, { markRead: req.query.markRead === 'true' });
    res.json(messages);
  } catch (e) {
    console.error('/threads error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/labels/counts', auth, async (req, res) => {
  const u = userEmail(req, res); if (!u) return;
  try {
    res.json(await getLabelCounts(u));
  } catch (e) {
    console.error('/labels/counts error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/labels', auth, async (req, res) => {
  const u = userEmail(req, res); if (!u) return;
  try {
    res.json(await getUserLabels(u));
  } catch (e) {
    console.error('/labels error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/messages/:messageId/modify', auth, async (req, res) => {
  const u = userEmail(req, res); if (!u) return;
  try {
    res.json(await modifyMessage(u, req.params.messageId, req.body));
  } catch (e) {
    console.error('/messages/modify error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/attachments/:messageId/:attachmentId', auth, async (req, res) => {
  const u = userEmail(req, res); if (!u) return;
  try {
    const buf = await getAttachment(u, req.params.messageId, req.params.attachmentId);
    const mime = req.query.mimeType ?? 'application/octet-stream';
    const filename = req.query.filename ?? 'attachment';
    res.set('Content-Type', mime);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) {
    console.error('/attachments error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Threads-index og draft er Supabase-baserte — håndteres av dashboard direkte
// eller via agent. Stubber her for å unngå 404 fra gammel kode.
app.get('/threads-index', auth, (_req, res) => res.json([]));
app.post('/threads-index/:id', auth, (_req, res) => res.json({ ok: true }));
app.post('/draft', auth, (_req, res) => res.status(202).json({ msgId: 'async', note: 'Bruk /api/mail/ai-draft for agent-utkast' }));
app.post('/corrections', auth, (_req, res) => res.json({ ok: true }));
app.post('/attachments/save', auth, (_req, res) => res.status(501).json({ error: 'Ikke implementert' }));
app.post('/send', auth, (_req, res) => res.status(501).json({ error: 'Sending ikke aktivert i denne servicen' }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`massivlust-gmail-service kjører på http://127.0.0.1:${PORT}`);
});
