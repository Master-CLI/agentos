import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { ReasoningProvider, ReasoningTask, ReasoningResult, ProviderName, OutputCallback } from './types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

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
 * Conservative argv element allowlist.
 *
 * Flags (--foo, -f) and simple values (alphanumeric, hyphens, underscores,
 * dots, slashes, colons for paths, equals signs for --key=val) are permitted.
 * Anything else is rejected before we ever hand it to spawn.
 *
 * IMPORTANT: buildArgs must NEVER place untrusted data (user input, file
 * content, LLM output) directly on argv. Untrusted content must go via stdin.
 */
const SAFE_ARG_RE = /^[a-zA-Z0-9_\-./:\\=@]*$/;

function assertSafeArgv(args: readonly string[]): void {
  for (const arg of args) {
    if (!SAFE_ARG_RE.test(arg)) {
      throw new Error(
        `Unsafe argv element rejected (contains shell metacharacters): ${JSON.stringify(arg)}`,
      );
    }
  }
}

/**
 * On Windows many CLIs ship as `.cmd` / `.bat` shims. With `shell: false`,
 * Node's `spawn` invokes `CreateProcess` directly (no PATHEXT lookup).
 *
 * We resolve the real executable path by walking PATH and checking PATHEXT
 * extensions so we can call `spawn(realExe, args, { shell: false })` directly
 * — NO `cmd.exe` wrapper. The previous wrapper re-introduced cmd.exe
 * metacharacter parsing (CVE-2024-27980 class) and left the child as a zombie
 * on timeout because killing cmd.exe does not kill its spawned child.
 */
function resolveWindowsExecutable(command: string): string {
  // If caller already gave an absolute path with extension, trust it as-is.
  if (path.isAbsolute(command) && fs.existsSync(command)) {
    return command;
  }

  const pathExt = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').toUpperCase().split(';');
  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter);

  for (const dir of pathDirs) {
    // Try the name as-is first (already has extension).
    const direct = path.join(dir, command);
    if (fs.existsSync(direct)) return direct;

    // Try each PATHEXT extension.
    for (const ext of pathExt) {
      const candidate = path.join(dir, command + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Fall back to the bare name; spawn will error with ENOENT if not found,
  // which is preferable to routing through cmd.exe.
  return command;
}

function resolveSpawnTarget(command: string, args: string[]): { cmd: string; argv: string[] } {
  if (process.platform === 'win32') {
    return { cmd: resolveWindowsExecutable(command), argv: args };
  }
  return { cmd: command, argv: args };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const AVAILABILITY_TIMEOUT_MS = 5_000;
/** After SIGTERM we give the child this long to exit cleanly before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** Maximum bytes accumulated from child stdout + stderr before we abort. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Kill the entire process tree rooted at `pid`.
 *
 * On win32: `taskkill /T /F /PID <pid>` (no shell interpolation — the pid is
 * a number, not a user-supplied string, so numeric-only is guaranteed).
 * On POSIX: SIGTERM then SIGKILL after grace period.
 */
function treeKill(child: ChildProcess): void {
  if (process.platform === 'win32') {
    if (child.pid === undefined) return;
    // pid is always a safe positive integer — no shell metachar risk.
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    } satisfies SpawnOptions);
    killer.on('error', () => { /* best-effort */ });
  } else {
    if (!child.killed) {
      try { child.kill('SIGTERM'); } catch { /* child already gone */ }
      setTimeout(() => {
        if (!child.killed) {
          try { child.kill('SIGKILL'); } catch { /* child already gone */ }
        }
      }, KILL_GRACE_MS);
    }
  }
}

/**
 * Arm a hard timeout on a child process. On timeout the returned token exposes
 * `timedOut === true` and kills the whole process tree. Caller must `clear()`
 * on normal exit so we don't leak timers.
 */
function armTimeout(child: ChildProcess, ms: number): { clear: () => void; timedOut: () => boolean } {
  let timedOut = false;
  const softTimer = setTimeout(() => {
    timedOut = true;
    treeKill(child);
  }, ms);

  return {
    clear: () => { clearTimeout(softTimer); },
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

      // Validate argv elements before spawn.
      try { assertSafeArgv(versionArgs); } catch {
        this.available = false;
        resolve(false);
        return;
      }

      const { cmd, argv } = resolveSpawnTarget(this.config.command, versionArgs);

      const child = spawn(cmd, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });

      const timer = armTimeout(child, AVAILABILITY_TIMEOUT_MS);
      let stdout = '';
      let stdoutBytes = 0;
      child.stdout?.on('data', (d: Buffer) => {
        stdoutBytes += d.length;
        if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += d.toString();
      });
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

    // Validate argv elements before spawn — untrusted data must go via stdin, not argv.
    assertSafeArgv(args);

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
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputOverflow = false;
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

      const checkOverflow = () => {
        if (!outputOverflow && stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES) {
          outputOverflow = true;
          treeKill(child);
          settleReject(new Error(
            `CLI agent ${this.name} output exceeded ${MAX_OUTPUT_BYTES} bytes — killed`,
          ));
        }
      };

      child.stdout?.on('data', (d: Buffer) => {
        // Always invoke the streaming callback so callers get live output.
        const chunk = d.toString();
        onOutput?.(chunk, 'stdout');
        // Only accumulate into the retained buffer up to the cap.
        stdoutBytes += d.length;
        if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += chunk;
        checkOverflow();
      });
      child.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        onOutput?.(chunk, 'stderr');
        stderrBytes += d.length;
        if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += chunk;
        checkOverflow();
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
