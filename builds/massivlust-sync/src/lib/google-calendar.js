import { google } from 'googleapis';
import { readFileSync } from 'fs';
import { config } from '../config.js';

function getClient(calendarEmail) {
  const keyFile = JSON.parse(readFileSync(config.google.saKeyPath, 'utf8'));
  const auth = new google.auth.JWT(
    keyFile.client_email,
    null,
    keyFile.private_key,
    ['https://www.googleapis.com/auth/calendar.readonly'],
    calendarEmail,
  );
  return google.calendar({ version: 'v3', auth });
}

export async function listEvents(calendarEmail, opts = {}) {
  const cal = getClient(calendarEmail);
  const events = [];
  let pageToken = null;

  const params = {
    calendarId: 'primary',
    maxResults: 250,
    singleEvents: true,
    orderBy: 'startTime',
  };

  if (opts.timeMin) params.timeMin = opts.timeMin;
  if (opts.timeMax) params.timeMax = opts.timeMax;
  if (opts.syncToken) {
    params.syncToken = opts.syncToken;
    delete params.timeMin;
    delete params.timeMax;
    delete params.orderBy;
  }

  do {
    params.pageToken = pageToken;
    try {
      const res = await cal.events.list(params);
      events.push(...(res.data.items || []));
      pageToken = res.data.nextPageToken;
      if (!pageToken && res.data.nextSyncToken) {
        return { events, syncToken: res.data.nextSyncToken };
      }
    } catch (err) {
      if (err.code === 410 && opts.syncToken) {
        delete params.syncToken;
        params.orderBy = 'startTime';
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        params.timeMin = sixMonthsAgo.toISOString();
        continue;
      }
      throw err;
    }
  } while (pageToken);

  return { events, syncToken: null };
}

export const TEAM_CALENDARS = [
  'alex@massivlust.no',
  'martin@massivlust.no',
  'eivind.smedal@outlook.com',
  'vegard@massivlust.no',
  'mathias@massivlust.no',
];
