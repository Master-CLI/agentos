import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Pick a unique port based on existing registered projects.
 * Base port 3382, each subsequent project gets +1.
 */
function pickPort(targetDir: string): number {
  const BASE_PORT = 3382;
  try {
    const registryPath = path.join(os.homedir(), '.agentos-projects.json');
    if (!fs.existsSync(registryPath)) return BASE_PORT;
    const projects: string[] = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    // If this project is already registered, keep its existing port
    const normalized = path.resolve(targetDir);
    const idx = projects.findIndex((p) => path.resolve(p) === normalized);
    if (idx >= 0) return BASE_PORT + idx;
    // New project → next port
    return BASE_PORT + projects.length;
  } catch {
    return BASE_PORT;
  }
}

interface ProviderInfo {
  name: string;
  version: string | null;
  path: string | null;
  available: boolean;
}

function detectProvider(cmd: string, versionFlag = '--version'): ProviderInfo {
  try {
    const output = execSync(`${cmd} ${versionFlag}`, {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    let binPath: string | null = null;
    try {
      binPath = execSync(`${whichCmd} ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0];
    } catch { /* ignore */ }
    return { name: cmd, version: output, path: binPath, available: true };
  } catch {
    return { name: cmd, version: null, path: null, available: false };
  }
}

function detectOllama(): { available: boolean; version: string | null } {
  try {
    const output = execSync('ollama --version', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { available: true, version: output };
  } catch {
    return { available: false, version: null };
  }
}

export async function initProject(targetDir: string): Promise<void> {
  const agentosDir = path.join(targetDir, '.agentos');

  if (fs.existsSync(agentosDir)) {
    console.log('.agentos/ already exists, re-initializing config...');
  } else {
    fs.mkdirSync(agentosDir, { recursive: true });
  }

  // Detect environment
  console.log('Detecting environment...');
  const ollama = detectOllama();
  const providers: ProviderInfo[] = [
    detectProvider('claude'),
    detectProvider('codex', '--version'),
    detectProvider('gemini', '--version'),
  ];

  const availableProviders = providers.filter((p) => p.available);

  // Scan project structure
  const projectInfo: Record<string, unknown> = {
    path: targetDir,
    name: path.basename(targetDir),
  };

  const pkgJsonPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      projectInfo.package_name = pkg.name;
      projectInfo.dependencies_count = Object.keys(pkg.dependencies || {}).length +
        Object.keys(pkg.devDependencies || {}).length;
    } catch { /* ignore */ }
  }

  // Git info
  try {
    const commitCount = execSync('git rev-list --count HEAD', {
      cwd: targetDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    projectInfo.git_commit_count = parseInt(commitCount, 10);
    projectInfo.git_available = true;
  } catch {
    projectInfo.git_available = false;
  }

  // Write config
  const config = {
    version: '0.1.0',
    project: projectInfo,
    ollama: {
      available: ollama.available,
      version: ollama.version,
      endpoint: 'http://localhost:11434',
    },
    providers,
    port: pickPort(targetDir),
  };

  fs.writeFileSync(
    path.join(agentosDir, 'config.json'),
    JSON.stringify(config, null, 2),
  );

  // Write init report
  const report = {
    structure: projectInfo,
    dependencies: projectInfo.dependencies_count ?? 0,
    git_summary: {
      available: projectInfo.git_available,
      commit_count: projectInfo.git_commit_count ?? 0,
    },
    environment: {
      ollama: ollama.available ? `ready (${ollama.version})` : 'not found',
      cli_agents: availableProviders.length > 0
        ? availableProviders.map((p) => `${p.name} (${p.version})`).join(', ')
        : 'none detected',
    },
  };

  // Persist report for programmatic access
  fs.writeFileSync(
    path.join(agentosDir, 'init-report.json'),
    JSON.stringify(report, null, 2),
  );

  console.log('\n--- AgentOS Init Report ---');
  console.log(JSON.stringify(report, null, 2));
  console.log('\n.agentos/ created successfully.');
  console.log(`  Ollama:     ${report.environment.ollama}`);
  console.log(`  CLI Agents: ${report.environment.cli_agents}`);
  // Write usage guide
  const guideContent = `# AgentOS

Project-level intelligent coordination system.

## Quick Start

\`\`\`bash
agentos start          # Start the daemon
agentos open           # Open the web console in browser
\`\`\`

## Commands

| Command          | Description                    |
|------------------|--------------------------------|
| \`agentos init\`   | Initialize AgentOS (done)      |
| \`agentos start\`  | Start the daemon               |
| \`agentos open\`   | Open the web console           |
| \`agentos status\` | Show daemon status             |
| \`agentos stop\`   | Stop the daemon                |
| \`agentos list\`   | List all registered projects   |

## How It Works

1. **Start** \u2014 The daemon begins watching your project files and git activity
2. **Ask** \u2014 Type a request in the console (e.g. "refactor the auth module")
3. **Review** \u2014 Agent A writes code, Agent B writes tests, Agent C reviews
4. **Accept** \u2014 Review the diff, then accept or discard

The system continuously observes your project in the background.
Suggestions appear in the inbox when risks or opportunities are detected.

## Configuration

Settings are stored in \`.agentos/config.json\`.
Edit via the web console Settings panel or:

\`\`\`bash
curl -X PUT http://localhost:${config.port}/api/settings \\
  -H "Content-Type: application/json" \\
  -d '{"auto_execute": false}'
\`\`\`

## Environment

- Daemon API: \`http://localhost:${config.port}\`
- WebSocket: \`ws://localhost:${config.port}/ws\`
- Data: \`.agentos/\` (events, state, suggestions)
`;

  const guidePath = path.join(targetDir, 'AGENTOS.md');
  if (!fs.existsSync(guidePath)) {
    fs.writeFileSync(guidePath, guideContent);
  }

  // Register in global project list (skip temp directories from tests)
  const isTempDir = targetDir.includes(os.tmpdir()) || targetDir.includes('\\Temp\\') || targetDir.includes('/tmp/');
  if (!isTempDir) {
    try {
      const { registerProject } = await import('./list.js');
      registerProject(targetDir);
    } catch { /* ignore if list module not available */ }
  }

  console.log(`\nRun 'agentos start' to launch the daemon.`);
  console.log(`Run 'agentos open' to open the web console.`);
}
