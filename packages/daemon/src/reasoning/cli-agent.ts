import { spawn, type ChildProcess } from 'node:child_process';
import type { ReasoningProvider, ReasoningTask, ReasoningResult, ProviderName, OutputCallback } from './types.js';

/**
 * Result of buildArgs: argv to pass to the CLI, plus (optionally) a prompt to
 * stream in via stdin. We prefer stdin for prompt content to avoid any risk of
 * shell interpretation and to keep process lists clean.
 */
export interface CliInvocation {
  args: string[];
  stdin?: string;
}

export interface CliAgentConfig {
  name: ProviderName;
  command: string;
  /** argv for `--version` style liveness probe (no shell, no prompt). */
  versionArgs?: string[];
  buildArgs: (task: ReasoningTask) => CliInvocation;
  parseOutput: (stdout: string) => { output: string; structured?: Record<string, unknown> };
  timeoutMs?: number;
}

const SYSTEM_PREFIX =
  `You are a pure text-output assistant. You MUST NOT request permissions, ` +
  `create files, modify files, or use any tools. You MUST NOT say "I need write access" ` +
  `or ask the user to approve anything. Simply output code in markdown fenced code blocks ` +
  `with the filename as a comment on the first line. Example:\n` +
  "```typescript\n// src/hello.ts\nexport function hello() { return 'world'; }\n```\n\n";

/**
 * Per-provider argv + stdin strategy.
 *
 * We NEVER pass the prompt on argv under a shell. Two safe options exist:
 *   (a) argv + `shell: false` — arguments are passed as-is to execve, the
 *       shell never sees them, so `` ` ``, `$`, `;`, `&&` etc. are inert.
 *   (b) stdin — the prompt is written to the child's stdin pipe; nothing on
 *       the command line references it.
 *
 * We use (b) for all three vendors since their CLIs document stdin support,
 * which also keeps prompts out of `ps`/audit-log argv dumps:
 *
 *   - claude:  `claude -p` (no positional prompt) reads from stdin in --print mode.
 *   - codex:   `codex exec` with no positional prompt reads from stdin
 *              (`If not provided as an argument (or if `-` is used), instructions are read from stdin`).
 *              NOTE: the previous `codex -q <prompt>` form referenced a flag that does not
 *              exist in the current Codex CLI (`-q` is unassigned; `-p` is profile).
 *   - gemini:  `gemini -p ""` + stdin — the gemini help states the prompt arg is
 *              "Appended to input on stdin (if any)", so stdin carries the real payload.
 */
const PROVIDER_CONFIGS: Record<string, Omit<CliAgentConfig, 'name'>> = {
  'claude-code': {
    command: 'claude',
    versionArgs: ['--version'],
    buildArgs: (task) => ({
      args: ['-p'],
      stdin: SYSTEM_PREFIX + task.prompt,
    }),
    parseOutput: (stdout) => {
      // claude -p outputs raw text (or JSON if --output-format json).
      // We use raw text mode for reliability.
      return { output: stdout };
    },
  },
  codex: {
    command: 'codex',
    versionArgs: ['--version'],
    buildArgs: (task) => ({
      args: ['exec'],
      stdin: SYSTEM_PREFIX + task.prompt,
    }),
    parseOutput: (stdout) => ({ output: stdout }),
  },
  gemini: {
    command: 'gemini',
    versionArgs: ['--version'],
    // gemini requires -p to trigger non-interactive mode; we pass an empty
    // string and rely on stdin being appended ("Appended to input on stdin").
    buildArgs: (task) => ({
      args: ['-p', ''],
      stdin: SYSTEM_PREFIX + task.prompt,
    }),
    parseOutput: (stdout) => ({ output: stdout }),
  },
};

/**
 * On Windows many CLIs ship as `.cmd` / `.bat` shims. With `shell: false`,
 * Node's `spawn` requires the explicit extension (or a `cmd.exe /c` wrapper)
 * because it invokes `CreateProcess` directly and there is no PATHEXT fallback.
 *
 * We detect Windows and translate `cmd` → `cmd.exe /c cmd <args...>` so we
 * keep `shell: false` (no shell string parsing) while still letting PATHEXT
 * resolve the shim. The arguments we forward never go through a shell.
 */
function resolveSpawnTarget(command: string, args: string[]): { cmd: string; argv: string[] } {
  if (process.platform === 'win32') {
    return { cmd: 'cmd.exe', argv: ['/d', '/s', '/c', command, ...args] };
  }
  return { cmd: command, argv: args };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const AVAILABILITY_TIMEOUT_MS = 5_000;
/** After SIGTERM we give the child this long to exit cleanly before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * Arm a hard timeout on a child process. On timeout the returned token exposes
 * `timedOut === true` and escalates SIGTERM → SIGKILL. Caller must `clear()`
 * on normal exit so we don't leak timers.
 */
function armTimeout(child: ChildProcess, ms: number): { clear: () => void; timedOut: () => boolean } {
  let timedOut = false;
  const softTimer = setTimeout(() => {
    timedOut = true;
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch { /* child already gone */ }
    }
    hardTimer = setTimeout(() => {
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch { /* child already gone */ }
      }
    }, KILL_GRACE_MS);
  }, ms);

  let hardTimer: NodeJS.Timeout | null = null;

  return {
    clear: () => {
      clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
    },
    timedOut: () => timedOut,
  };
}

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
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async checkAvailability(): Promise<boolean> {
    return new Promise((resolve) => {
      const versionArgs = this.config.versionArgs ?? ['--version'];
      const { cmd, argv } = resolveSpawnTarget(this.config.command, versionArgs);

      const child = spawn(cmd, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });

      const timer = armTimeout(child, AVAILABILITY_TIMEOUT_MS);
      let stdout = '';
      child.stdout?.on('data', (d) => { stdout += d; });
      // Drain stderr so the pipe buffer never blocks.
      child.stderr?.on('data', () => {});

      child.on('close', (code) => {
        timer.clear();
        if (timer.timedOut()) {
          this.available = false;
          resolve(false);
          return;
        }
        this.available = code === 0 && stdout.trim().length > 0;
        resolve(this.available);
      });

      child.on('error', () => {
        timer.clear();
        this.available = false;
        resolve(false);
      });
    });
  }

  async invoke(task: ReasoningTask, onOutput?: OutputCallback): Promise<ReasoningResult> {
    const start = Date.now();
    const { args, stdin } = this.config.buildArgs(task);
    const { cmd, argv } = resolveSpawnTarget(this.config.command, args);

    return new Promise((resolve, reject) => {
      const child = spawn(cmd, argv, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });

      const timer = armTimeout(child, this.timeoutMs);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        timer.clear();
        reject(err);
      };
      const settleResolve = (r: ReasoningResult) => {
        if (settled) return;
        settled = true;
        timer.clear();
        resolve(r);
      };

      child.stdout?.on('data', (d) => {
        const chunk = d.toString();
        stdout += chunk;
        onOutput?.(chunk, 'stdout');
      });
      child.stderr?.on('data', (d) => {
        const chunk = d.toString();
        stderr += chunk;
        onOutput?.(chunk, 'stderr');
      });

      // Feed the prompt via stdin; we never place prompt content on argv.
      if (child.stdin) {
        child.stdin.on('error', () => {
          // EPIPE etc. — the child closed stdin early. The `close` handler
          // below still fires with the exit code, so we let it own the outcome.
        });
        if (stdin !== undefined) {
          child.stdin.end(stdin);
        } else {
          child.stdin.end();
        }
      }

      child.on('close', (code, signal) => {
        const latency = Date.now() - start;
        if (timer.timedOut()) {
          settleReject(new Error(
            `CLI agent ${this.name} timed out after ${this.timeoutMs}ms (killed via ${signal ?? 'SIGTERM'})`,
          ));
          return;
        }
        if (code !== 0) {
          settleReject(new Error(`CLI agent ${this.name} exited with code ${code}: ${stderr}`));
          return;
        }
        const parsed = this.config.parseOutput(stdout);
        settleResolve({
          task_id: task.id,
          provider: this.name,
          output: parsed.output,
          structured: parsed.structured,
          confidence: 0.85, // Higher base confidence for CLI agents
          latency_ms: latency,
        });
      });

      child.on('error', (err) => {
        settleReject(new Error(`Failed to spawn ${this.name}: ${err.message}`));
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
