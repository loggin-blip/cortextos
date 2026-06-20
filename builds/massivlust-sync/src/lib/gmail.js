import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { config } from '../config.js';

let _gmail = null;

function getClient() {
  if (_gmail) return _gmail;

  const keyFile = JSON.parse(readFileSync(config.google.saKeyPath, 'utf8'));
  const auth = new google.auth.JWT(
    keyFile.client_email,
    null,
    keyFile.private_key,
    ['https://www.googleapis.com/auth/gmail.modify'],
    config.google.impersonateEmail,
  );
  _gmail = google.gmail({ version: 'v1', auth });
  return _gmail;
}

export async function listHistory(startHistoryId) {
  const gmail = getClient();
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

export async function getMessage(messageId) {
  const gmail = getClient();
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  return res.data;
}

export async function getProfile() {
  const gmail = getClient();
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

export async function searchMessages(query, maxResults = 100) {
  const gmail = getClient();
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
