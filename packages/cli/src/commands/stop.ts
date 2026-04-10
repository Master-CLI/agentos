import * as fs from 'node:fs';
import * as path from 'node:path';

export async function stopDaemon(): Promise<void> {
  const agentosDir = path.join(process.cwd(), '.agentos');
  const pidPath = path.join(agentosDir, 'daemon.pid');

  if (!fs.existsSync(pidPath)) {
    console.log('No running daemon found.');
    return;
  }

  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (PID ${pid}).`);

    // Wait briefly for cleanup
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check if still alive
    try {
      process.kill(pid, 0);
      // Still alive, force kill
      process.kill(pid, 'SIGKILL');
      console.log('Force killed daemon.');
    } catch {
      // Process gone, good
    }
  } catch {
    console.log(`Daemon (PID ${pid}) is not running. Cleaning up stale PID file.`);
  }

  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }

  console.log('Daemon stopped.');
}
