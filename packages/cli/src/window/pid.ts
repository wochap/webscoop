import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FindPidOptions {
  /** Give up after this long. Default 5000. */
  deadlineMs?: number;
  /** Interval between scans. Default 100. */
  pollMs?: number;
  /** Root of the process tree. Default `/proc`. */
  procDir?: string;
}

/**
 * Process id of the Chromium main process for a profile: the process whose
 * command line carries `--user-data-dir=<profileDir>` and no `--type=`
 * (renderers and utility processes have one). Null when none shows up in time.
 * A profile path containing spaces is matched only as long as Chromium keeps
 * its arguments NUL-separated.
 */
export async function findBrowserPid(profileDir: string, opts: FindPidOptions = {}): Promise<number | null> {
  const deadline = Date.now() + (opts.deadlineMs ?? 5000);
  const procDir = opts.procDir ?? '/proc';
  const wanted = `--user-data-dir=${profileDir}`;
  for (;;) {
    const pid = await scan(procDir, wanted);
    if (pid !== null) return pid;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(opts.pollMs ?? 100, left)));
  }
}

async function scan(procDir: string, wanted: string): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir(procDir);
  } catch {
    return null;
  }
  const pids = entries.filter((e) => /^\d+$/.test(e)).map(Number).sort((a, b) => a - b);
  for (const pid of pids) {
    let cmdline: string;
    try {
      cmdline = await readFile(join(procDir, String(pid), 'cmdline'), 'utf8');
    } catch {
      // The process ended or is not ours to read.
      continue;
    }
    // Chromium rewrites its argv into one space-separated string, so split on both.
    const padded = ` ${cmdline.replace(/\0/g, ' ')} `;
    if (padded.includes(` ${wanted} `) && !padded.includes(' --type=')) return pid;
  }
  return null;
}
