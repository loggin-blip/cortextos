import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger.js';
import * as syncRuns from '../sync-runs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PYTHON = process.env.KB_EMBED_PYTHON || '/Users/max/cortextos/knowledge-base/venv/bin/python';
const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'embed-korrespondanse.py');
const LIMIT = Number(process.env.KB_EMBED_LIMIT) || 50;

export async function run({ mode = 'incremental', dryRun = false } = {}) {
  if (dryRun) {
    logger.info({ mode }, 'kb-embed dry-run — skipping');
    return { mode: 'dry-run', mail: 0, attachment: 0 };
  }

  const source = 'kb_embed';
  const runId = await syncRuns.start({ source });

  try {
    const env = {
      ...process.env,
      SA_KEY: process.env.GOOGLE_SA_KEY_PATH || process.env.SA_KEY || '',
    };
    const result = await runPython(['--mode=both', `--limit=${LIMIT}`], env);

    await syncRuns.complete(runId, {
      status: 'success',
      rows_in: 0,
      rows_upserted: (result.mail || 0) + (result.attachment || 0),
      rows_skipped: (result.mail_skipped || 0) + (result.attachment_skipped || 0),
      rows_failed: 0,
    });

    return result;
  } catch (err) {
    await syncRuns.complete(runId, { status: 'error', error_message: err.message });
    throw err;
  }
}

function runPython(args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [SCRIPT, ...args], { env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`embed-korrespondanse.py exited ${code}: ${stderr.slice(-500)}`));
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      const out = { mail: 0, mail_skipped: 0, attachment: 0, attachment_skipped: 0 };
      for (const line of lines) {
        try {
          const j = JSON.parse(line);
          if (j.mode === 'mail') {
            out.mail = j.indexed || 0;
            out.mail_skipped = j.skipped || 0;
          } else if (j.mode === 'attachment') {
            out.attachment = j.indexed || 0;
            out.attachment_skipped = j.skipped || 0;
          }
        } catch {
          logger.warn({ line }, 'embed-korrespondanse non-JSON output');
        }
      }
      if (stderr) logger.warn({ stderr: stderr.slice(-500) }, 'embed-korrespondanse stderr');
      resolve(out);
    });
    proc.on('error', reject);
  });
}
