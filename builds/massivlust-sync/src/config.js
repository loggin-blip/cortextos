import 'dotenv/config';

const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TRIPLETEX_CONSUMER_TOKEN',
  'TRIPLETEX_EMPLOYEE_TOKEN',
  'GOOGLE_SA_KEY_PATH',
  'GOOGLE_IMPERSONATE_EMAIL',
];

const missing = required.filter(k => !process.env[k]);
if (missing.length > 0 && !process.argv.includes('--dry-run')) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

export const config = {
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  tripletex: {
    consumerToken: process.env.TRIPLETEX_CONSUMER_TOKEN,
    employeeToken: process.env.TRIPLETEX_EMPLOYEE_TOKEN,
    apiBase: process.env.TRIPLETEX_API_BASE || 'https://tripletex.no/v2',
  },
  google: {
    saKeyPath: process.env.GOOGLE_SA_KEY_PATH || './secrets/google-sa-key.json',
    impersonateEmail: process.env.GOOGLE_IMPERSONATE_EMAIL || 'alex@massivlust.no',
  },
  logLevel: process.env.LOG_LEVEL || 'info',
  timezone: process.env.TIMEZONE || 'Europe/Oslo',
};
