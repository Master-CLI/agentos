import type { ProviderName } from '../reasoning/types.js';

export type TaskStatus = 'queued' | 'implementing' | 'testing' | 'reviewing' | 'awaiting_user' | 'completed' | 'cancelled';
export type TaskOrigin = 'user' | 'system';
export type ChangeLevel = 'light' | 'standard' | 'major';
export type ReviewVerdict = 'approve' | 'request_changes' | 'reject';
export type ConcernSeverity = 'info' | 'warning' | 'error';
export type ConcernCategory = 'logic' | 'security' | 'performance' | 'compatibility' | 'style' | 'test_coverage';

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  content: string;
}

export interface ReviewConcern {
  file: string;
  line?: number;
  severity: ConcernSeverity;
  category: ConcernCategory;
  message: string;
  suggested_fix?: string;
}

export interface ReviewReport {
  reviewer: ProviderName;
  verdict: ReviewVerdict;
  concerns: ReviewConcern[];
  started_at: string;
  completed_at: string;
}

export interface TaskPipeline {
  implementation: {
    provider: ProviderName | null;
    diff: FileDiff[];
    started_at: string | null;
    completed_at: string | null;
  };
  testing: {
    provider: ProviderName | null;
    test_files: string[];
    run_result: {
      passed: boolean;
      total: number;
      failed: number;
    } | null;
  };
  reviews: ReviewReport[];
  consensus: 'pending' | 'pass' | 'concerns' | 'reject';
  fix_attempts: number;
}

export interface CodeTask {
  id: string;
  created_at: string;
  origin: TaskOrigin;
  source_suggestion_id?: string;
  prompt: string;
  context: {
    related_modules: string[];
    project_id: string;
  };
  change_level: ChangeLevel;
  pipeline: TaskPipeline;
  status: TaskStatus;
}
