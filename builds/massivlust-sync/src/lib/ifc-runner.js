import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = join(__dirname, '..', 'python', 'parse_ifc.py');
const PYTHON_BIN = join(__dirname, '..', 'python', 'venv', 'bin', 'python3');

export function parseIfc(ifcPath, projectId) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [PYTHON_SCRIPT, ifcPath, '--project-id', projectId], {
      timeout: 120_000,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`IFC parser exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`IFC parser output not valid JSON: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on('error', reject);
  });
}
