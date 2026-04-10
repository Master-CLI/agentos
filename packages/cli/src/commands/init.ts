import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

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
    port: 3382,
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

  console.log('\n--- AgentOS Init Report ---');
  console.log(JSON.stringify(report, null, 2));
  console.log('\n.agentos/ created successfully.');
  console.log(`  Ollama:     ${report.environment.ollama}`);
  console.log(`  CLI Agents: ${report.environment.cli_agents}`);
  console.log(`\nRun 'agentos start' to launch the daemon.`);
}
