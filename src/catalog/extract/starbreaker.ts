// Thin wrapper around the StarBreaker CLI: our fork starbreaker-ps (fleetyards fork + github.com/diogotr7/StarBreaker).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024;

export async function starbreakerVersion(bin: string): Promise<string> {
  const { stdout } = await exec(bin, ['--version']);
  return stdout.trim().replace(/^starbreaker\s+/, '');
}

/** Runs StarBreaker and returns its combined output (progress goes to stderr). */
export async function starbreaker(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await exec(bin, args, { maxBuffer: MAX_BUFFER });
    return `${stdout}\n${stderr}`;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string };
    throw new Error(`starbreaker ${args.join(' ')} failed: ${e.stderr || e.stdout || e.message}`);
  }
}

/** Number of records StarBreaker reports for a `dcb extract` run. */
export function exportedCount(output: string): number | null {
  const m = /Exporting (\d+) records/.exec(output);
  return m ? Number(m[1]) : null;
}
