'use strict';

const express = require('express');
const chokidar = require('chokidar');
const { marked } = require('marked');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const AGENT_ROOT = '/Users/max/cortextos/orgs/massivlust/agents/massivlust-team';
const SKILLS_DIR = path.join(AGENT_ROOT, '.claude/skills');
const CONFIG_JSON = path.join(AGENT_ROOT, 'config.json');
const LOGS_DIR = path.join(os.homedir(), '.cortextos/default/logs/massivlust-team');
const INBOUND_LOG = path.join(LOGS_DIR, 'inbound-messages.jsonl');
const OUTBOUND_LOG = path.join(LOGS_DIR, 'outbound-messages.jsonl');
const RESTART_LOG = path.join(LOGS_DIR, 'restarts.log');
const STDOUT_LOG = path.join(LOGS_DIR, 'stdout.log');

const BOOTSTRAP_FILES = [
  'AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', 'GOALS.md', 'IDENTITY.md',
  'SOUL.md', 'GUARDRAILS.md', 'MEMORY.md', 'HEARTBEAT.md', 'TOOLS.md',
  'USER.md', 'SYSTEM.md'
];

const PORT_PREF = 4747;
const PORT_FALLBACK = 4748;

// ---------- helpers ----------

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

async function safeRead(p, fallback = '') {
  try { return await fsp.readFile(p, 'utf8'); } catch { return fallback; }
}

function parseFrontmatter(md) {
  // Returns { data, body } — supports simple YAML: key: value, key: [a,b], multi-line via next key.
  if (!md.startsWith('---')) return { data: {}, body: md };
  const end = md.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: md };
  const raw = md.slice(3, end).trim();
  const body = md.slice(end + 4).replace(/^\n/, '');
  const data = {};
  let currentKey = null;
  let buffer = [];
  const flush = () => {
    if (currentKey) {
      const joined = buffer.join('\n').trim();
      data[currentKey] = tryParseValue(joined);
    }
    currentKey = null;
    buffer = [];
  };
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m) {
      flush();
      currentKey = m[1];
      buffer = [m[2]];
    } else if (currentKey !== null) {
      buffer.push(line);
    }
  }
  flush();
  return { data, body };
}

function tryParseValue(v) {
  if (v === '') return '';
  // list: [a, b, c]
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  // strip surrounding quotes
  const s = v.replace(/^["']|["']$/g, '');
  return s;
}

async function listSkills() {
  let entries = [];
  try { entries = await fsp.readdir(SKILLS_DIR, { withFileTypes: true }); }
  catch { return []; }
  const skills = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillMd = path.join(SKILLS_DIR, e.name, 'SKILL.md');
    const st = safeStat(skillMd);
    if (!st) continue;
    const raw = await safeRead(skillMd);
    const { data } = parseFrontmatter(raw);
    skills.push({
      id: e.name,
      type: 'skill',
      name: data.name || e.name,
      description: data.description || firstMeaningfulLine(raw),
      mtime: st.mtimeMs,
      size: st.size,
      path: skillMd
    });
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return skills;
}

function firstMeaningfulLine(md) {
  const lines = md.split('\n').filter(l => l.trim() && !l.startsWith('---') && !l.startsWith('#'));
  return (lines[0] || '').slice(0, 160);
}

async function loadConfig() {
  const raw = await safeRead(CONFIG_JSON, '{}');
  try { return JSON.parse(raw); } catch { return {}; }
}

async function listCrons() {
  const cfg = await loadConfig();
  const st = safeStat(CONFIG_JSON);
  return (cfg.crons || []).map(c => ({
    id: c.name,
    type: 'cron',
    name: c.name,
    schedule: c.interval || c.cron || '?',
    scheduleKind: c.interval ? 'interval' : (c.cron ? 'cron' : 'unknown'),
    prompt: c.prompt || '',
    mtime: st ? st.mtimeMs : Date.now(),
    path: CONFIG_JSON
  }));
}

async function listBootstrap() {
  const out = [];
  for (const name of BOOTSTRAP_FILES) {
    const p = path.join(AGENT_ROOT, name);
    const st = safeStat(p);
    if (!st) continue;
    const raw = await safeRead(p);
    out.push({
      id: name,
      type: 'bootstrap',
      name,
      mtime: st.mtimeMs,
      size: st.size,
      lineCount: raw.split('\n').length,
      path: p
    });
  }
  return out;
}

async function skillFiles(skillId) {
  const dir = path.join(SKILLS_DIR, skillId);
  const out = [];
  async function walk(cur, rel) {
    let entries = [];
    try { entries = await fsp.readdir(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const nrel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        await walk(full, nrel);
      } else {
        const st = safeStat(full);
        out.push({ path: nrel, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 });
      }
    }
  }
  await walk(dir, '');
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function tailFile(p, n = 200) {
  // Read only last ~256KB, split, take last n. Cheap & no cache.
  let stat;
  try { stat = await fsp.stat(p); } catch { return []; }
  const MAX = 256 * 1024;
  const size = stat.size;
  const start = Math.max(0, size - MAX);
  const fh = await fsp.open(p, 'r');
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // Drop the first (possibly partial) line if we didn't start at 0
    if (start > 0 && lines.length > 1) lines.shift();
    return lines.filter(l => l.length > 0).slice(-n);
  } finally {
    await fh.close();
  }
}

async function tailJsonl(p, n = 50) {
  const lines = await tailFile(p, n * 2);
  const out = [];
  for (const l of lines.slice(-n)) {
    try { out.push(JSON.parse(l)); } catch { /* skip */ }
  }
  return out;
}

async function grepStdout(term, limit = 20) {
  if (!term) return [];
  const lines = await tailFile(STDOUT_LOG, 4000);
  const needle = term.toLowerCase();
  const matches = [];
  for (let i = lines.length - 1; i >= 0 && matches.length < limit; i--) {
    if (lines[i].toLowerCase().includes(needle)) {
      matches.push(lines[i]);
    }
  }
  return matches.reverse();
}

// ---------- SSE broadcaster ----------

const sseClients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* ignore */ }
  }
}

// ---------- app ----------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/surfaces', async (req, res) => {
  try {
    const [skills, crons, bootstrap] = await Promise.all([listSkills(), listCrons(), listBootstrap()]);
    res.json({ skills, crons, bootstrap });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/surface', async (req, res) => {
  const { type, id } = req.query;
  if (!type || !id) return res.status(400).json({ error: 'type and id required' });
  try {
    if (type === 'skill') {
      const skillMd = path.join(SKILLS_DIR, id, 'SKILL.md');
      const st = safeStat(skillMd);
      if (!st) return res.status(404).json({ error: 'skill not found' });
      const raw = await safeRead(skillMd);
      const { data, body } = parseFrontmatter(raw);
      const bodyHtml = marked.parse(body, { mangle: false, headerIds: false });
      const files = await skillFiles(id);
      const recent = await grepStdout(id, 20);
      res.json({
        type, id,
        path: skillMd,
        name: data.name || id,
        description: data.description || '',
        triggers: normalizeTriggers(data.triggers || data.trigger),
        frontmatter: data,
        bodyHtml,
        bodyRaw: body,
        size: st.size,
        mtime: st.mtimeMs,
        files,
        recent
      });
    } else if (type === 'cron') {
      const crons = await listCrons();
      const c = crons.find(x => x.id === id);
      if (!c) return res.status(404).json({ error: 'cron not found' });
      const recent = await grepStdout(id, 10);
      res.json({ ...c, recent });
    } else if (type === 'bootstrap') {
      const p = path.join(AGENT_ROOT, id);
      const st = safeStat(p);
      if (!st) return res.status(404).json({ error: 'file not found' });
      const raw = await safeRead(p);
      const bodyHtml = marked.parse(raw, { mangle: false, headerIds: false });
      res.json({
        type, id, path: p, name: id,
        mtime: st.mtimeMs, size: st.size,
        lineCount: raw.split('\n').length,
        bodyHtml, bodyRaw: raw
      });
    } else {
      res.status(400).json({ error: 'unknown type' });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function normalizeTriggers(t) {
  if (!t) return [];
  if (Array.isArray(t)) return t;
  return String(t).split(/[,;|]/).map(s => s.trim()).filter(Boolean);
}

app.get('/api/tg', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 200);
  try {
    const [inbound, outbound, restarts] = await Promise.all([
      tailJsonl(INBOUND_LOG, limit),
      tailJsonl(OUTBOUND_LOG, limit),
      tailFile(RESTART_LOG, 10)
    ]);
    const merged = [];
    for (const m of inbound) {
      merged.push({
        direction: 'in',
        ts: m.timestamp || m.archived_at || null,
        chat_id: m.chat_id || m.from,
        from_name: m.from_name || '',
        text: (m.text || '').slice(0, 400),
        message_id: m.message_id
      });
    }
    for (const m of outbound) {
      merged.push({
        direction: 'out',
        ts: m.timestamp || null,
        chat_id: m.chat_id,
        from_name: 'jensen',
        text: (m.text || '').slice(0, 400),
        message_id: m.message_id
      });
    }
    merged.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    res.json({ messages: merged.slice(-limit), restarts });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch { /* ignore */ }
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ---------- file watcher ----------

const watcher = chokidar.watch([
  path.join(SKILLS_DIR, '**/*.md'),
  path.join(SKILLS_DIR, '**/*.py'),
  path.join(SKILLS_DIR, '**/*.js'),
  CONFIG_JSON,
  path.join(AGENT_ROOT, '*.md'),
  INBOUND_LOG,
  OUTBOUND_LOG,
  RESTART_LOG
], {
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 }
});

const debounce = new Map();
function debouncedEmit(p, kind) {
  const key = `${kind}:${p}`;
  clearTimeout(debounce.get(key));
  debounce.set(key, setTimeout(() => {
    broadcast({ type: 'file-changed', kind, path: p, ts: Date.now() });
    debounce.delete(key);
  }, 200));
}

watcher.on('change', p => debouncedEmit(p, categorize(p)));
watcher.on('add', p => debouncedEmit(p, categorize(p)));
watcher.on('unlink', p => debouncedEmit(p, categorize(p)));

function categorize(p) {
  if (p === INBOUND_LOG || p === OUTBOUND_LOG) return 'tg';
  if (p === RESTART_LOG) return 'restart';
  if (p === CONFIG_JSON) return 'cron';
  if (p.startsWith(SKILLS_DIR)) return 'skill';
  if (p.startsWith(AGENT_ROOT)) return 'bootstrap';
  return 'other';
}

// ---------- boot ----------

function start(port) {
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[jensen-inspector] listening on http://0.0.0.0:${port}`);
    console.log(`[jensen-inspector] watching ${SKILLS_DIR}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port === PORT_PREF) {
      console.error(`[jensen-inspector] port ${PORT_PREF} in use, trying ${PORT_FALLBACK}`);
      start(PORT_FALLBACK);
    } else {
      console.error('[jensen-inspector] fatal', err);
      process.exit(1);
    }
  });
}

start(PORT_PREF);

process.on('SIGTERM', () => { watcher.close(); process.exit(0); });
process.on('SIGINT', () => { watcher.close(); process.exit(0); });
