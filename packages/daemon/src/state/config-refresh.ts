import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface ConfigRefreshOptions {
  configPath: string;
  projectDir: string;
  /** Polling interval in ms. Default 5 minutes. */
  intervalMs?: number;
}

/**
 * Re-derives the volatile fields under `project.{path,name,git_commit_count}`
 * on the existing `.agentos/config.json` so they don't drift from reality
 * after `agentos init` first wrote them.
 *
 * Real-world drift this fixes:
 *   - `project.path` written at init can point at an old directory if the
 *     repo was moved/renamed.
 *   - `git_commit_count` is frozen at init time (observed: stuck at 68 while
 *     the repo accumulated many more commits).
 *
 * Only the auto-derived fields are rewritten; user-edited keys are preserved.
 */
export class ConfigRefresher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;

  constructor(private opts: ConfigRefreshOptions) {
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  }

  start(): void {
    // Run once immediately so a freshly-started daemon corrects stale config
    // before its first observable read.
    this.refreshOnce();
    this.timer = setInterval(() => this.refreshOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  refreshOnce(): void {
    if (!fs.existsSync(this.opts.configPath)) return;
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(fs.readFileSync(this.opts.configPath, 'utf-8'));
    } catch {
      return;
    }

    const before = JSON.stringify(config.project ?? {});
    const project = (config.project ?? {}) as Record<string, unknown>;

    // Path / name from the *actual* daemon working dir, not the init-time
    // value. Useful when the project is moved after init.
    project.path = this.opts.projectDir;
    project.name = path.basename(this.opts.projectDir);

    // Git commit count + availability from the current HEAD.
    try {
      const count = execSync('git rev-list --count HEAD', {
        cwd: this.opts.projectDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
      const n = parseInt(count, 10);
      if (!Number.isNaN(n)) {
        project.git_commit_count = n;
        project.git_available = true;
      }
    } catch {
      project.git_available = false;
    }

    config.project = project;

    if (JSON.stringify(config.project) === before) return;

    try {
      fs.writeFileSync(this.opts.configPath, JSON.stringify(config, null, 2));
    } catch { /* writeback failure is non-fatal */ }
  }
}
