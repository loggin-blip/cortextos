import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import nodeFetch from 'node-fetch';
import https from 'https';

const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 5 });

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (url, options = {}) => nodeFetch(url, { ...options, agent: _httpsAgent }) },
  }
);
