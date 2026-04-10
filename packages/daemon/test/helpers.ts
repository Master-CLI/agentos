import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Retry rmSync for Windows where file handles may linger after watcher close.
 */
export function safeRmSync(dir: string, retries = 3): void {
  for (let i = 0; i < retries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (i === retries - 1) return; // Give up silently — temp dirs get cleaned by OS
      // Wait briefly for handles to release
      const start = Date.now();
      while (Date.now() - start < 200) { /* spin */ }
    }
  }
}

export function initAgentosDir(projectDir: string): string {
  const agentosDir = path.join(projectDir, '.agentos');
  fs.mkdirSync(agentosDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentosDir, 'config.json'),
    JSON.stringify({ version: '0.1.0', providers: [], port: 0 }),
  );
  return agentosDir;
}
