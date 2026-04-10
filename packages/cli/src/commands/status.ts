import * as fs from 'node:fs';
import * as path from 'node:path';

export async function showStatus(): Promise<void> {
  const agentosDir = path.join(process.cwd(), '.agentos');

  if (!fs.existsSync(agentosDir)) {
    console.log('AgentOS not initialized in this directory. Run \'agentos init\' first.');
    return;
  }

  // Read config
  const configPath = path.join(agentosDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    console.log('Config not found. Run \'agentos init\' to re-initialize.');
    return;
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  // Check daemon
  const pidPath = path.join(agentosDir, 'daemon.pid');
  let daemonStatus = 'stopped';
  let pid: number | null = null;

  if (fs.existsSync(pidPath)) {
    pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0);
      daemonStatus = 'running';
    } catch {
      daemonStatus = 'stopped (stale PID)';
    }
  }

  // Health check if running
  let healthOk = false;
  if (daemonStatus === 'running') {
    try {
      const res = await fetch(`http://localhost:${config.port}/health`);
      healthOk = res.ok;
    } catch {
      healthOk = false;
    }
  }

  console.log(`AgentOS Status`);
  console.log(`  Project:  ${config.project?.name || 'unknown'}`);
  console.log(`  Daemon:   ${daemonStatus}${pid ? ` (PID ${pid})` : ''}`);
  console.log(`  Health:   ${healthOk ? 'ok' : 'unreachable'}`);
  console.log(`  Port:     ${config.port}`);
  console.log(`  Ollama:   ${config.ollama?.available ? 'available' : 'not found'}`);

  const availableAgents = (config.providers || []).filter((p: { available: boolean }) => p.available);
  console.log(`  Agents:   ${availableAgents.length > 0 ? availableAgents.map((p: { name: string }) => p.name).join(', ') : 'none'}`);
}
