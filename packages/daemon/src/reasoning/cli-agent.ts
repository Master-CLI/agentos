import { spawn } from 'node:child_process';
import type { ReasoningProvider, ReasoningTask, ReasoningResult, ProviderName } from './types.js';

export interface CliAgentConfig {
  name: ProviderName;
  command: string;
  buildArgs: (task: ReasoningTask) => string[];
  parseOutput: (stdout: string) => { output: string; structured?: Record<string, unknown> };
  timeoutMs?: number;
}

const PROVIDER_CONFIGS: Record<string, Omit<CliAgentConfig, 'name'>> = {
  'claude-code': {
    command: 'claude',
    buildArgs: (task) => ['-p', task.prompt, '--output-format', 'json'],
    parseOutput: (stdout) => {
      try {
        const parsed = JSON.parse(stdout);
        // Claude Code JSON output has a result field
        const text = parsed.result ?? parsed.content ?? stdout;
        return { output: String(text), structured: parsed };
      } catch {
        return { output: stdout };
      }
    },
  },
  codex: {
    command: 'codex',
    buildArgs: (task) => ['-q', task.prompt],
    parseOutput: (stdout) => ({ output: stdout }),
  },
  gemini: {
    command: 'gemini',
    buildArgs: (task) => ['-p', task.prompt],
    parseOutput: (stdout) => ({ output: stdout }),
  },
};

export class CliAgentProvider implements ReasoningProvider {
  readonly name: ProviderName;
  available = false;
  private config: Omit<CliAgentConfig, 'name'>;
  private timeoutMs: number;

  constructor(name: ProviderName) {
    const config = PROVIDER_CONFIGS[name];
    if (!config) {
      throw new Error(`Unknown CLI agent provider: ${name}`);
    }
    this.name = name;
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? 120000;
  }

  async checkAvailability(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.config.command, ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        timeout: 5000,
      });

      let stdout = '';
      child.stdout?.on('data', (d) => { stdout += d; });

      child.on('close', (code) => {
        this.available = code === 0 && stdout.trim().length > 0;
        resolve(this.available);
      });

      child.on('error', () => {
        this.available = false;
        resolve(false);
      });
    });
  }

  async invoke(task: ReasoningTask): Promise<ReasoningResult> {
    const start = Date.now();
    const args = this.config.buildArgs(task);

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        timeout: this.timeoutMs,
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });

      child.on('close', (code) => {
        const latency = Date.now() - start;
        if (code !== 0) {
          reject(new Error(`CLI agent ${this.name} exited with code ${code}: ${stderr}`));
          return;
        }
        const parsed = this.config.parseOutput(stdout);
        resolve({
          task_id: task.id,
          provider: this.name,
          output: parsed.output,
          structured: parsed.structured,
          confidence: 0.85, // Higher base confidence for CLI agents
          latency_ms: latency,
        });
      });

      child.on('error', (err) => {
        reject(new Error(`Failed to spawn ${this.name}: ${err.message}`));
      });
    });
  }
}

/**
 * Detect all available CLI agent providers.
 */
export async function detectCliAgents(): Promise<CliAgentProvider[]> {
  const names: ProviderName[] = ['claude-code', 'codex', 'gemini'];
  const providers: CliAgentProvider[] = [];

  for (const name of names) {
    const provider = new CliAgentProvider(name);
    await provider.checkAvailability();
    providers.push(provider);
  }

  return providers;
}
