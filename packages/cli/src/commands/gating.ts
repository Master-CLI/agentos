import * as fs from 'node:fs';
import * as path from 'node:path';
import { lookupGating, type GatingResponse } from '@agentos/daemon';

export interface GatingCmdOptions {
  json?: boolean;
}

/**
 * `agentos gating <file>` — prints the gating rules that apply to <file>.
 * Tries the running daemon first (so the answer comes from the same source
 * other clients see); falls back to a direct in-process lookup if offline.
 */
export async function gatingCommand(file: string, opts: GatingCmdOptions = {}): Promise<void> {
  if (!file) {
    console.log('Usage: agentos gating <relative-file-path>');
    process.exitCode = 1;
    return;
  }
  const projectDir = process.cwd();
  if (!fs.existsSync(path.join(projectDir, '.agentos'))) {
    console.log('AgentOS not initialized in this directory. Run \'agentos init\' first.');
    process.exitCode = 1;
    return;
  }

  let result: Awaited<ReturnType<typeof lookupGating>> | null = null;
  let source: 'daemon' | 'local' = 'local';
  try {
    const configPath = path.join(projectDir, '.agentos', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { port?: number };
    if (typeof config.port === 'number') {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      try {
        const res = await fetch(
          `http://localhost:${config.port}/api/gating?file=${encodeURIComponent(file)}`,
          { signal: controller.signal },
        );
        if (res.ok) {
          result = (await res.json()) as GatingResponse;
          source = 'daemon';
        }
      } finally {
        clearTimeout(t);
      }
    }
  } catch { /* fall back to local lookup */ }

  if (!result) {
    result = await lookupGating(projectDir, file);
  }

  if (opts.json) {
    console.log(JSON.stringify({ source, ...result }, null, 2));
    return;
  }

  if (!result.configured) {
    console.log(`(.agentos/gating.json missing — falling back to default ruleset)`);
    console.log('');
  }

  if (result.matches.length === 0) {
    console.log(`No gating rules match ${file}.`);
    return;
  }

  console.log(`Read-first rules for ${file} (${source}):`);
  for (const m of result.matches) {
    console.log('');
    console.log(`  pattern: ${m.rule.glob}`);
    if (m.rule.reason) console.log(`  reason:  ${m.rule.reason}`);
    console.log(`  read before editing:`);
    for (const doc of m.existingDocs) {
      console.log(`    - ${doc}`);
    }
    const missing = m.rule.readBefore.filter((d) => !m.existingDocs.includes(d));
    if (missing.length > 0) {
      console.log(`  (referenced but not found on disk:)`);
      for (const doc of missing) console.log(`    - ${doc}`);
    }
  }
}
