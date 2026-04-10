import { simpleGit, type SimpleGit, type LogResult } from 'simple-git';
import type { EventBus } from '../events/event-bus.js';
import type { ProjectEvent } from '../events/types.js';
import type { Observer } from './types.js';

export interface GitObserverOptions {
  projectDir: string;
  projectId: string;
  eventBus: EventBus;
  pollIntervalMs?: number;
}

export class GitObserver implements Observer {
  private git: SimpleGit;
  private eventBus: EventBus;
  private projectId: string;
  private pollInterval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCommitHash: string | null = null;
  private knownBranches: Set<string> = new Set();

  constructor(opts: GitObserverOptions) {
    this.git = simpleGit(opts.projectDir);
    this.eventBus = opts.eventBus;
    this.projectId = opts.projectId;
    this.pollInterval = opts.pollIntervalMs ?? 3000;
  }

  start(): void {
    // Initialize: snapshot current state
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
    const log: LogResult = await this.git.log({ maxCount: 10 });
    if (!log.latest) return;

    if (this.lastCommitHash && log.latest.hash !== this.lastCommitHash) {
      // Find new commits
      const newCommits = [];
      for (const entry of log.all) {
        if (entry.hash === this.lastCommitHash) break;
        newCommits.push(entry);
      }

      // Emit in chronological order (oldest first)
      for (const commit of newCommits.reverse()) {
        let filesChanged: string[] = [];
        try {
          const diff = await this.git.diffSummary([`${commit.hash}~1`, commit.hash]);
          filesChanged = diff.files.map((f) => f.file);
        } catch {
          // First commit has no parent
        }

        const event: Omit<ProjectEvent, 'id' | 'timestamp'> = {
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
        };
        this.eventBus.publish(event as ProjectEvent);
      }
    }

    this.lastCommitHash = log.latest.hash;
  }

  private async checkNewBranches(): Promise<void> {
    const branches = await this.git.branchLocal();
    for (const name of branches.all) {
      if (!this.knownBranches.has(name)) {
        this.knownBranches.add(name);
        const event: Omit<ProjectEvent, 'id' | 'timestamp'> = {
          source: 'git',
          type: 'branch_created',
          payload: { branch: name },
          metadata: { project_id: this.projectId },
        };
        this.eventBus.publish(event as ProjectEvent);
      }
    }
  }
}
