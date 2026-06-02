import { simpleGit, type SimpleGit, type LogResult, type TaskOptions } from 'simple-git';
import type { EmitEventFn } from '../events/types.js';
import type { Observer } from './types.js';

export interface GitObserverOptions {
  projectDir: string;
  projectId: string;
  publishEvent: EmitEventFn;
  pollIntervalMs?: number;
}

export class GitObserver implements Observer {
  private git: SimpleGit;
  private publishEvent: EmitEventFn;
  private projectId: string;
  private pollInterval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCommitHash: string | null = null;
  private knownBranches: Set<string> = new Set();

  constructor(opts: GitObserverOptions) {
    this.git = simpleGit(opts.projectDir);
    this.publishEvent = opts.publishEvent;
    this.projectId = opts.projectId;
    this.pollInterval = opts.pollIntervalMs ?? 3000;
  }

  start(): void {
    this.snapshot().then(() => {
      this.timer = setInterval(() => this.poll(), this.pollInterval);
    }).catch(() => {
      // Not a git repo — silently skip
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async snapshot(): Promise<void> {
    try {
      const log = await this.git.log({ maxCount: 1 });
      if (log.latest) {
        this.lastCommitHash = log.latest.hash;
      }
      const branches = await this.git.branchLocal();
      for (const name of branches.all) {
        this.knownBranches.add(name);
      }
    } catch {
      // Ignore — may not be a git repo
    }
  }

  private async poll(): Promise<void> {
    try {
      await this.checkNewCommits();
      await this.checkNewBranches();
    } catch {
      // Silently handle errors (e.g., git operations during rebase)
    }
  }

  private async checkNewCommits(): Promise<void> {
    if (!this.lastCommitHash) {
      // No prior baseline — snapshot the current HEAD and start from here.
      const log: LogResult = await this.git.log({ maxCount: 1 });
      if (log.latest) this.lastCommitHash = log.latest.hash;
      return;
    }

    // Page through git log in batches until we find the last known commit (or
    // exhaust history). This ensures bursts > 10 commits in one poll interval
    // are never silently dropped.
    const PAGE_SIZE = 50;
    let skip = 0;
    const newCommits: LogResult['all'][number][] = [];
    let foundAnchor = false;

    while (true) {
      // simple-git TaskOptions accepts a string[] of raw git flags.
      const pageOpts: TaskOptions = [`--max-count=${PAGE_SIZE}`, `--skip=${skip}`];
      const page: LogResult = await this.git.log(pageOpts);

      if (!page.all.length) break; // History exhausted (or first commit with no parents)

      for (const entry of page.all) {
        if (entry.hash === this.lastCommitHash) {
          foundAnchor = true;
          break;
        }
        newCommits.push(entry);
      }

      if (foundAnchor) break;
      skip += PAGE_SIZE;

      // Safety: if every commit in history is "new" (e.g. force-push rewrote
      // history), stop after a reasonable cap to avoid unbounded work.
      if (newCommits.length >= 1000) break;
    }

    if (newCommits.length === 0) return;

    // Advance the anchor BEFORE emitting events and making diffSummary calls.
    // This prevents a re-entrant poll() (setInterval fires while this await
    // chain is still running) from re-collecting the same commits.
    // newCommits[0] before reverse() is the newest commit (git log order).
    this.lastCommitHash = newCommits[0]!.hash;

    for (const commit of newCommits.reverse()) {
      let filesChanged: string[] = [];
      try {
        const diff = await this.git.diffSummary([`${commit.hash}~1`, commit.hash]);
        filesChanged = diff.files.map((f) => f.file);
      } catch {
        // First commit has no parent — files_changed stays empty.
      }

      this.publishEvent({
        source: 'git',
        type: 'commit_pushed',
        payload: {
          hash: commit.hash,
          message: commit.message,
          author: commit.author_name,
          date: commit.date,
          files_changed: filesChanged,
        },
        metadata: { project_id: this.projectId },
      });
    }
  }

  private async checkNewBranches(): Promise<void> {
    const branches = await this.git.branchLocal();
    for (const name of branches.all) {
      if (!this.knownBranches.has(name)) {
        this.knownBranches.add(name);
        this.publishEvent({
          source: 'git',
          type: 'branch_created',
          payload: { branch: name },
          metadata: { project_id: this.projectId },
        });
      }
    }
  }
}
