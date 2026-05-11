import * as fs from 'node:fs';
import * as path from 'node:path';
import { allocateNextTaskId, type NextTaskIdResponse } from '@agentos/daemon';

export interface NextTaskIdCmdOptions {
  json?: boolean;
}

/**
 * `agentos next-task-id` — reserve the next TASK-NNN id. Tries the live
 * daemon first so concurrent sessions share one counter; falls back to a
 * direct in-process allocation.
 *
 * The id is reserved on disk (in `.agentos/task-counter.json`) but no file
 * is created — the caller is expected to write `docs/tasks/<id>-<slug>.md`.
 */
export async function nextTaskIdCommand(opts: NextTaskIdCmdOptions = {}): Promise<void> {
  const projectDir = process.cwd();
  if (!fs.existsSync(path.join(projectDir, '.agentos'))) {
    console.log('AgentOS not initialized in this directory. Run \'agentos init\' first.');
    process.exitCode = 1;
    return;
  }

  let result: Awaited<ReturnType<typeof allocateNextTaskId>> | null = null;
  let source: 'daemon' | 'local' = 'local';
  try {
    const configPath = path.join(projectDir, '.agentos', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { port?: number };
    if (typeof config.port === 'number') {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      try {
        const res = await fetch(`http://localhost:${config.port}/api/task/next-id`, {
          method: 'POST',
          signal: controller.signal,
        });
        if (res.ok) {
          result = (await res.json()) as NextTaskIdResponse;
          source = 'daemon';
        }
      } finally {
        clearTimeout(t);
      }
    }
  } catch { /* daemon offline — local fallback */ }

  if (!result) {
    result = await allocateNextTaskId(projectDir);
  }

  if (opts.json) {
    console.log(JSON.stringify({ source, ...result }, null, 2));
    return;
  }

  console.log(result.nextId);
  if (result.reserved.length > 0) {
    console.error(
      `(note: ${result.reserved.length} id(s) reserved but not yet written: ${result.reserved.join(', ')})`,
    );
  }
}
