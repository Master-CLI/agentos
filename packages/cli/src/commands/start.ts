import * as fs from 'node:fs';
import * as path from 'node:path';

export async function startDaemon(port: string | number): Promise<void> {
  const projectDir = process.cwd();
  const agentosDir = path.join(projectDir, '.agentos');

  if (!fs.existsSync(agentosDir)) {
    console.error('Error: .agentos/ not found. Run \'agentos init\' first.');
    process.exit(1);
  }

  // Check if already running
  const pidPath = path.join(agentosDir, 'daemon.pid');
  if (fs.existsSync(pidPath)) {
    const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    try {
      process.kill(existingPid, 0);
      console.error(`Error: Daemon already running (PID ${existingPid}). Run 'agentos stop' first.`);
      process.exit(1);
    } catch {
      // Process not found, stale PID file — clean up
      fs.unlinkSync(pidPath);
    }
  }

  // Read port from config if not specified on CLI
  let resolvedPort = typeof port === 'string' ? parseInt(port, 10) : port;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentosDir, 'config.json'), 'utf-8'));
    if (resolvedPort === 3382 && config.port) {
      resolvedPort = config.port;
    }
  } catch { /* use default */ }

  // Check if port is already in use
  try {
    const res = await fetch(`http://localhost:${resolvedPort}/health`);
    if (res.ok) {
      console.error(`Error: Port ${resolvedPort} is already in use (another AgentOS instance?).`);
      console.error(`  Try: agentos start --port ${resolvedPort + 1}`);
      process.exit(1);
    }
  } catch { /* port is free, good */ }

  const { Daemon } = await import('@agentos/daemon');

  const daemon = new Daemon({
    projectDir,
    port: resolvedPort,
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await daemon.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await daemon.start();
  console.log(`AgentOS daemon started (PID ${process.pid}, port ${daemon.port})`);
  console.log(`  Health: http://localhost:${daemon.port}/health`);
  console.log(`  WebSocket: ws://localhost:${daemon.port}/ws`);
  console.log('\nPress Ctrl+C to stop.');
}
