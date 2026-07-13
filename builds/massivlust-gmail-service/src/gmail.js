import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SA_KEY_PATH = join(__dirname, '..', 'google-sa-key.json');
const DOMAIN_GUARD = '@massivlust.no';
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

const _clients = new Map();

function getClient(email) {
  if (!email.endsWith(DOMAIN_GUARD)) throw new Error(`Ugyldig e-post: må slutte på ${DOMAIN_GUARD}`);
  if (_clients.has(email)) return _clients.get(email);
  const key = JSON.parse(readFileSync(SA_KEY_PATH, 'utf8'));
  const auth = new google.auth.JWT(key.client_email, null, key.private_key, SCOPES, email);
  const client = google.gmail({ version: 'v1', auth });
  _clients.set(email, client);
  return client;
}

function decodeBase64Url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractTextBody(payload, type = 'text/plain') {
  if (!payload) return '';
  if (payload.mimeType === type && payload.body?.data) return decodeBase64Url(payload.body.data);
  if (payload.parts) {
    for (const p of payload.parts) {
      const found = extractTextBody(p, type);
      if (found) return found;
    }
  }
  return '';
}

function extractHtmlBody(payload) {
  return extractTextBody(payload, 'text/html');
}

function extractAttachments(payload) {
  const atts = [];
  function walk(p) {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      atts.push({ id: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType, size: p.body.size ?? 0 });
    }
    if (p.parts) p.parts.forEach(walk);
  }
  walk(payload);
  return atts;
}

function extractFriendlyName(from) {
  const m = from?.match(/^"?([^"<]+)"?\s*</);
  return m ? m[1].trim() : from ?? '';
}

function extractEmail(from) {
  const m = from?.match(/<([^>]+)>/);
  return m ? m[1].trim() : from ?? '';
}

function humanLabel(labels) {
  if (labels.includes('UNREAD')) return 'UNREAD';
  return labels[0] ?? '';
}

function headerVal(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export async function listInbox(userEmail, { label = 'INBOX', limit = 50, category, q } = {}) {
  const gmail = getClient(userEmail);
  let query = '';
  if (label !== 'ALL') query += `label:${label.toLowerCase()} `;
  if (category) query += `category:${category} `;
  if (q) query += q;
  query = query.trim();

  const listRes = await gmail.users.messages.list({
    userId: 'me', maxResults: Math.min(limit, 100),
    ...(query ? { q: query } : {}),
  });

  const messages = listRes.data.messages ?? [];
  if (!messages.length) return [];

  const full = await Promise.all(
    messages.map(m => gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'] }))
  );

  return full.map(r => {
    const msg = r.data;
    const headers = msg.payload?.headers ?? [];
    const from = headerVal(headers, 'From');
    return {
      id: msg.id,
      threadId: msg.threadId,
      from: extractFriendlyName(from),
      fromEmail: extractEmail(from),
      subject: headerVal(headers, 'Subject') || '(ingen emne)',
      snippet: msg.snippet ?? '',
      date: headerVal(headers, 'Date'),
      unread: (msg.labelIds ?? []).includes('UNREAD'),
      starred: (msg.labelIds ?? []).includes('STARRED'),
      hasAttachment: (msg.labelIds ?? []).includes('HAS_ATTACHMENT'),
      labels: msg.labelIds ?? [],
    };
  });
}

export async function getThread(userEmail, threadId, { markRead = false } = {}) {
  const gmail = getClient(userEmail);
  const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const messages = res.data.messages ?? [];

  if (markRead) {
    const unreadIds = messages.filter(m => (m.labelIds ?? []).includes('UNREAD')).map(m => m.id);
    await Promise.all(unreadIds.map(id =>
      gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['UNREAD'] } }).catch(() => {})
    ));
  }

  return messages.map(msg => {
    const headers = msg.payload?.headers ?? [];
    const from = headerVal(headers, 'From');
    return {
      id: msg.id,
      from: extractFriendlyName(from),
      fromEmail: extractEmail(from),
      to: headerVal(headers, 'To'),
      cc: headerVal(headers, 'Cc'),
      subject: headerVal(headers, 'Subject') || '(ingen emne)',
      date: headerVal(headers, 'Date'),
      bodyText: extractTextBody(msg.payload),
      bodyHtml: extractHtmlBody(msg.payload),
      snippet: msg.snippet ?? '',
      attachments: extractAttachments(msg.payload),
    };
  });
}

export async function getLabelCounts(userEmail) {
  const gmail = getClient(userEmail);
  const res = await gmail.users.labels.list({ userId: 'me' });
  const labelIds = ['INBOX', 'STARRED', 'SENT', 'DRAFT', 'SPAM', 'TRASH'];
  const details = await Promise.all(
    labelIds.map(id => gmail.users.labels.get({ userId: 'me', id }).catch(() => null))
  );
  const result = {};
  details.forEach((r, i) => {
    if (r?.data) result[labelIds[i]] = { total: r.data.messagesTotal ?? 0, unread: r.data.messagesUnread ?? 0 };
  });
  return result;
}

export async function getUserLabels(userEmail) {
  const gmail = getClient(userEmail);
  const res = await gmail.users.labels.list({ userId: 'me' });
  return (res.data.labels ?? [])
    .filter(l => l.type === 'user')
    .map(l => ({ id: l.id, name: l.name }));
}

export async function modifyMessage(userEmail, messageId, { addLabelIds = [], removeLabelIds = [] }) {
  const gmail = getClient(userEmail);
  await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds, removeLabelIds } });
  return { ok: true };
}

export async function getAttachment(userEmail, messageId, attachmentId) {
  const gmail = getClient(userEmail);
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  return Buffer.from((res.data.data ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
