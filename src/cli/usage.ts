import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = join(__dirname, '../scripts/usage-tracker.py');

export const usageCommand = new Command('usage')
  .description('Show token usage and cost per agent')
  .option('--days <n>', 'Only include last N days', parseInt)
  .option('--agent <name>', 'Filter to agent name (substring)')
  .option('--json', 'Output raw JSON instead of summary')
  .option('-o, --output <path>', 'Write JSON to file')
  .action((opts: { days?: number; agent?: string; json?: boolean; output?: string }) => {
    const args = ['python3', SCRIPT];
    if (opts.days) args.push('--days', String(opts.days));
    if (opts.agent) args.push('--agent', opts.agent);
    if (opts.output) args.push('--output', opts.output);
    if (!opts.json && !opts.output) args.push('--summary');

    const result = spawnSync(args[0], args.slice(1), {
      stdio: 'inherit',
      timeout: 120_000,
    });
    process.exit(result.status ?? 0);
  });
