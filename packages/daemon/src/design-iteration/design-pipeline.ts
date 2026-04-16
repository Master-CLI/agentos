import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DesignTaskManager } from './design-task-manager.js';
import type { DesignTask, DesignVariant, RenderEntry, DesignReview } from './types.js';
import { extractConstraints } from './constraint-extractor.js';

export interface DesignPipelineOptions {
  taskManager: DesignTaskManager;
  chromePath?: string;
  renderBaseUrl?: string;
  renderOutDir?: string;
  renderConcurrency?: number;
}

/**
 * Orchestrates the 5-stage design iteration cycle:
 *   1. VariantGenerate  (stub — needs LLM)
 *   2. BatchRender      (concrete)
 *   3. AIPreScore       (stub — needs LLM)
 *   4. HumanReview      (sets status, waits for API call)
 *   5. ConvergenceCheck  (concrete)
 */
export class DesignPipeline {
  private tm: DesignTaskManager;
  private explicitChromePath: string | undefined;
  private resolvedChromePath: string | null = null;
  private renderBaseUrl: string;
  private renderOutDir: string;
  private renderConcurrency: number;

  constructor(opts: DesignPipelineOptions) {
    this.tm = opts.taskManager;
    // Chrome is only required at Stage 2 render time — resolve lazily so the
    // daemon can boot on machines that will never run a design task.
    this.explicitChromePath = opts.chromePath;
    this.renderBaseUrl = opts.renderBaseUrl ?? 'http://localhost:5173';
    this.renderOutDir = opts.renderOutDir ?? './renders';
    this.renderConcurrency = Math.max(1, opts.renderConcurrency ?? 2);
  }

  private getChromePath(): string {
    if (this.resolvedChromePath) return this.resolvedChromePath;
    this.resolvedChromePath = this.resolveChromePath(this.explicitChromePath);
    return this.resolvedChromePath;
  }

  /**
   * Resolve the path to a headless-capable Chrome/Edge binary.
   *
   * Priority:
   *   1. If an explicit path is provided, validate and use it.
   *   2. Otherwise scan well-known install locations per platform.
   *   3. Throw a clear error if none are found.
   */
  private resolveChromePath(explicit?: string): string {
    if (explicit) {
      if (!existsSync(explicit)) {
        throw new Error(`[DesignPipeline] Explicit chromePath does not exist: ${explicit}`);
      }
      return explicit;
    }

    const candidates: string[] = [];
    const platform = process.platform;

    if (platform === 'win32') {
      candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
      candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        candidates.push(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      }
      // Edge fallback
      candidates.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
      candidates.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    } else if (platform === 'darwin') {
      candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
      candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
      candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    } else {
      // linux / others
      candidates.push('/usr/bin/google-chrome');
      candidates.push('/usr/bin/google-chrome-stable');
      candidates.push('/usr/bin/chromium');
      candidates.push('/usr/bin/chromium-browser');
      candidates.push('/snap/bin/chromium');
      candidates.push('/usr/bin/microsoft-edge');
    }

    for (const c of candidates) {
      if (existsSync(c)) return c;
    }

    throw new Error(
      `[DesignPipeline] No Chrome/Edge found. Tried: ${candidates.join(', ')}. ` +
        `Pass opts.chromePath explicitly to override.`,
    );
  }

  /**
   * Run a Chrome process to screenshot a single URL. Resolves with render
   * statistics; never throws — failures are signaled via render_ok=0.
   */
  private runRender(url: string, pngPath: string): Promise<{ ok: boolean; ms: number; error?: string }> {
    return new Promise((resolve) => {
      const started = Date.now();
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        `--screenshot=${pngPath}`,
        '--window-size=1280,960',
        url,
      ];

      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (ok: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ ok, ms: Date.now() - started, error });
      };

      let chromePath: string;
      try {
        chromePath = this.getChromePath();
      } catch (err) {
        finish(false, err instanceof Error ? err.message : String(err));
        return;
      }

      const child = spawn(chromePath, args, { stdio: 'ignore' });

      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(false, 'timeout');
      }, 30_000);

      child.on('error', (err) => finish(false, err.message));
      child.on('exit', (code) => {
        if (code === 0) finish(true);
        else finish(false, `exit code ${code}`);
      });
    });
  }

  /**
   * Minimal bounded-concurrency runner. Processes jobs with at most
   * `limit` running in parallel, preserving output order.
   */
  private async runWithLimit<T, R>(items: T[], limit: number, worker: (item: T, idx: number) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const runners: Promise<void>[] = [];
    const n = Math.min(limit, items.length);
    for (let w = 0; w < n; w++) {
      runners.push(
        (async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= items.length) return;
            results[idx] = await worker(items[idx], idx);
          }
        })(),
      );
    }
    await Promise.all(runners);
    return results;
  }

  /**
   * Run a full iteration round for the given task.
   * Returns true if converged, false if another round is needed.
   */
  async executeRound(taskId: string): Promise<boolean> {
    const task = this.tm.get(taskId);
    if (!task) throw new Error(`DesignTask ${taskId} not found`);
    if (task.status !== 'active') throw new Error(`Task ${taskId} is not active (status=${task.status})`);

    // Stage 1: VariantGenerate (stub)
    const variants = await this.stageVariantGenerate(task);

    // Stage 2: BatchRender
    const renders = await this.stageBatchRender(task, variants);
    this.tm.addRenders(taskId, renders);

    // Stage 3: AIPreScore (stub)
    await this.stageAIPreScore(task, variants, renders);

    // Stage 4: HumanReview — mark awaiting and return
    this.stageHumanReview(task);

    // Stage 5 runs after review is submitted (see completeReview)
    return false;
  }

  /**
   * Called after a human submits their review via the API.
   * Runs Stage 5 and either converges or advances to the next round.
   */
  completeReview(taskId: string, review: DesignReview): { converge: boolean; bestVariant: string; reason: string } {
    this.tm.submitReview(taskId, review);

    // Extract constraints from comments
    const constraints = extractConstraints(review, review.round);
    for (const c of constraints) {
      this.tm.addConstraint(taskId, c);
    }

    // Stage 5: ConvergenceCheck
    const result = shouldConverge(review);

    if (result.converge) {
      this.tm.converge(taskId, result.bestVariant);
    } else {
      this.tm.nextRound(taskId);
    }

    return result;
  }

  // ── Stage 1: VariantGenerate ──────────────────────────────────

  private async stageVariantGenerate(task: DesignTask): Promise<DesignVariant[]> {
    // TODO: implement with ReasoningRouter
    // Will call router.execute({ type: 'design-variant', ... }) to generate N variant code files
    console.log(`[DesignPipeline] Stage 1 (VariantGenerate): TODO — implement with ReasoningRouter (task=${task.id}, round=${task.round})`);
    return this.tm.getVariants(task.id, task.round);
  }

  // ── Stage 2: BatchRender ──────────────────────────────────────

  private async stageBatchRender(task: DesignTask, variants: DesignVariant[]): Promise<RenderEntry[]> {
    interface RenderJob {
      variant: DesignVariant;
      configLabel: string;
      url: string;
      pngPath: string;
    }

    const jobs: RenderJob[] = [];
    for (const variant of variants) {
      for (const config of task.param_matrix) {
        const paramQuery = Object.entries(config.params)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&');
        const url = `${this.renderBaseUrl}?variant=${variant.key}&${paramQuery}`;
        const filename = `r${task.round}_${variant.key}_${config.label}.png`;
        const pngPath = join(this.renderOutDir, task.id, filename);
        jobs.push({ variant, configLabel: config.label, url, pngPath });
      }
    }

    const entries = await this.runWithLimit<RenderJob, RenderEntry>(jobs, this.renderConcurrency, async (job) => {
      const result = await this.runRender(job.url, job.pngPath);
      const stats: Record<string, number> = {
        render_ok: result.ok ? 1 : 0,
        render_ms: result.ms,
      };
      if (!result.ok) {
        console.error(
          `[DesignPipeline] Render failed for ${job.variant.key}/${job.configLabel}: ${result.error ?? 'unknown'}`,
        );
      }
      return {
        variant_id: job.variant.id,
        config_label: job.configLabel,
        png_path: job.pngPath,
        stats,
      };
    });

    return entries;
  }

  // ── Stage 3: AIPreScore ───────────────────────────────────────

  private async stageAIPreScore(
    task: DesignTask,
    variants: DesignVariant[],
    _renders: RenderEntry[],
  ): Promise<void> {
    // TODO: implement with ReasoningRouter
    // Will send render images + constraints to vision model for scoring
    console.log(`[DesignPipeline] Stage 3 (AIPreScore): TODO — implement with ReasoningRouter (task=${task.id}, round=${task.round})`);

    // Initialize empty scores so the data structure is consistent
    for (const variant of variants) {
      const scores: Record<string, number> = {};
      const comments: Record<string, string> = {};
      for (const config of task.param_matrix) {
        scores[config.label] = 0;
        comments[config.label] = 'AI scoring pending';
      }
      this.tm.setAIScores(task.id, variant.key, scores, comments);
    }
  }

  // ── Stage 4: HumanReview ──────────────────────────────────────

  private stageHumanReview(task: DesignTask): void {
    // Transition to awaiting_review through the event-sourced manager API so
    // the status change is persisted and replayable.
    this.tm.markAwaitingReview(task.id);
  }
}

// ── Stage 5: ConvergenceCheck ─────────────────────────────────

/**
 * Determine whether the design iteration should converge based on the review.
 *
 * Convergence criteria:
 *   - Best variant average score >= 4.0
 *   - No 1-star ratings anywhere in the review
 */
export function shouldConverge(review: DesignReview): { converge: boolean; bestVariant: string; reason: string } {
  if (review.ratings.length === 0) {
    return { converge: false, bestVariant: '', reason: 'No ratings submitted' };
  }

  // Compute average score per variant
  const totals: Record<string, { sum: number; count: number }> = {};
  for (const r of review.ratings) {
    if (!totals[r.variant_key]) totals[r.variant_key] = { sum: 0, count: 0 };
    totals[r.variant_key].sum += r.stars;
    totals[r.variant_key].count += 1;
  }

  const avgScores: Record<string, number> = {};
  for (const [key, { sum, count }] of Object.entries(totals)) {
    avgScores[key] = sum / count;
  }

  // Find best variant
  let bestKey = '';
  let bestAvg = -Infinity;
  for (const [key, avg] of Object.entries(avgScores)) {
    if (avg > bestAvg) {
      bestAvg = avg;
      bestKey = key;
    }
  }

  const hasOneStar = review.ratings.some((r) => r.stars <= 1);

  if (bestAvg >= 4.0 && !hasOneStar) {
    return {
      converge: true,
      bestVariant: bestKey,
      reason: `Best variant '${bestKey}' avg=${bestAvg.toFixed(2)}, no 1-star ratings`,
    };
  }

  const reasons: string[] = [];
  if (bestAvg < 4.0) reasons.push(`best avg=${bestAvg.toFixed(2)} < 4.0`);
  if (hasOneStar) reasons.push('has 1-star ratings');

  return {
    converge: false,
    bestVariant: bestKey,
    reason: `Not converged: ${reasons.join(', ')}`,
  };
}
