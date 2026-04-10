import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from 'node:child_process';

export async function openConsole(): Promise<void> {
  const agentosDir = path.join(process.cwd(), '.agentos');
  const configPath = path.join(agentosDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    console.error('Error: .agentos/ not found. Run \'agentos init\' first.');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const port = config.port ?? 3382;
  const url = `http://localhost:${port}`;

  // Check if daemon is running
  const pidPath = path.join(agentosDir, 'daemon.pid');
  if (!fs.existsSync(pidPath)) {
    console.error('Daemon is not running. Run \'agentos start\' first.');
    process.exit(1);
  }

  console.log(`Opening AgentOS Console: ${url}`);

  // Cross-platform browser open
  const cmd = process.platform === 'win32' ? `start ${url}`
    : process.platform === 'darwin' ? `open ${url}`
    : `xdg-open ${url}`;

  exec(cmd, (err) => {
    if (err) console.error('Failed to open browser:', err.message);
  });
}
