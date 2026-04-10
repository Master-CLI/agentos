import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const REGISTRY_PATH = path.join(os.homedir(), '.agentos-projects.json');

export function registerProject(projectDir: string): void {
  const projects = loadRegistry();
  if (!projects.includes(projectDir)) {
    projects.push(projectDir);
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(projects, null, 2));
  }
}

export function loadRegistry(): string[] {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

export async function listProjects(): Promise<void> {
  const projects = loadRegistry();

  if (projects.length === 0) {
    console.log('No AgentOS projects registered. Run \'agentos init\' in a project directory.');
    return;
  }

  console.log(`AgentOS Projects (${projects.length}):\n`);

  for (const dir of projects) {
    const agentosDir = path.join(dir, '.agentos');
    const exists = fs.existsSync(agentosDir);
    const configPath = path.join(agentosDir, 'config.json');

    let name = path.basename(dir);
    let status = 'unknown';

    if (exists && fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        name = config.project?.name ?? name;
      } catch { /* ignore */ }

      const pidPath = path.join(agentosDir, 'daemon.pid');
      if (fs.existsSync(pidPath)) {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
        try {
          process.kill(pid, 0);
          status = 'running';
        } catch {
          status = 'stopped';
        }
      } else {
        status = 'stopped';
      }
    } else {
      status = 'not initialized';
    }

    console.log(`  ${name}`);
    console.log(`    Path:   ${dir}`);
    console.log(`    Status: ${status}`);
    console.log();
  }
}
