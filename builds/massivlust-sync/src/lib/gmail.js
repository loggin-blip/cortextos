import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { config } from '../config.js';

const _clients = new Map();

function getClient(impersonateEmail) {
  const email = impersonateEmail || config.google.impersonateEmail;
  if (_clients.has(email)) return _clients.get(email);

  const keyFile = JSON.parse(readFileSync(config.google.saKeyPath, 'utf8'));
  const auth = new google.auth.JWT(
    keyFile.client_email,
    null,
    keyFile.private_key,
    ['https://www.googleapis.com/auth/gmail.modify'],
    email,
  );
  const client = google.gmail({ version: 'v1', auth });
  _clients.set(email, client);
  return client;
}

export async function listHistory(startHistoryId, impersonateEmail) {
  const gmail = getClient(impersonateEmail);
  const messages = [];
  let pageToken = null;

  do {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: String(startHistoryId),
      historyTypes: ['messageAdded'],
      pageToken,
    });

    const histories = res.data.history || [];
    for (const h of histories) {
      for (const added of (h.messagesAdded || [])) {
        messages.push(added.message);
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return { messages, historyId: messages.length > 0 ? undefined : startHistoryId };
}

export async function getMessage(messageId, impersonateEmail) {
  const gmail = getClient(impersonateEmail);
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  return res.data;
}

export async function getProfile(impersonateEmail) {
  const gmail = getClient(impersonateEmail);
  const res = await gmail.users.getProfile({ userId: 'me' });
  return res.data;
}

export function parseHeaders(headers) {
  const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  return {
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
    messageId: get('Message-ID'),
  };
}

export function extractBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

export async function getAttachment(messageId, attachmentId, impersonateEmail) {
  const gmail = getClient(impersonateEmail);
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  return Buffer.from(res.data.data, 'base64');
}

const SIGNATURE_IMAGE_RX = /^image\d*\.(png|jpe?g|gif|bmp)$/i;

export function findAttachments(payload) {
  const out = [];
  function walk(part) {
    if (!part) return;
    const filename = part.filename || '';
    const disposition = (part.headers || []).find(h => h.name.toLowerCase() === 'content-disposition')?.value || '';
    const contentId = (part.headers || []).find(h => h.name.toLowerCase() === 'content-id')?.value || '';
    const mimeType = part.mimeType || '';
    const size = part.body?.size || 0;
    const isInline = disposition.toLowerCase().startsWith('inline');
    const isSignatureImage = mimeType.startsWith('image/') && SIGNATURE_IMAGE_RX.test(filename) && size < 100 * 1024;
    const hasContentIdRef = !!contentId && size < 200 * 1024 && mimeType.startsWith('image/');
    const isRealAttachment = filename && part.body?.attachmentId && !isInline && !isSignatureImage && !hasContentIdRef;
    if (isRealAttachment) {
      out.push({
        partId: part.partId,
        filename,
        mimeType: mimeType || 'application/octet-stream',
        sizeBytes: size,
        attachmentId: part.body.attachmentId,
      });
    }
    for (const sub of (part.parts || [])) walk(sub);
  }
  walk(payload);
  return out;
}

export async function searchMessages(query, maxResults = 100, impersonateEmail) {
  const gmail = getClient(impersonateEmail);
  const messages = [];
  let pageToken = null;

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(maxResults - messages.length, 100),
      pageToken,
    });
    const ids = res.data.messages || [];
    messages.push(...ids);
    pageToken = res.data.nextPageToken;
    if (messages.length >= maxResults) break;
  } while (pageToken);

  return messages.slice(0, maxResults);
}
