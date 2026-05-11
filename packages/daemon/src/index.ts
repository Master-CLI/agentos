export { Daemon } from './daemon.js';
export { EventStore } from './events/event-store.js';
export { EventBus } from './events/event-bus.js';
export { FileWatcher } from './observers/file-watcher.js';
export { GitObserver } from './observers/git-observer.js';
export { scanActiveTodos } from './api/active-todos.js';
export type {
  ActiveTodosSnapshot,
  TaskTodo,
  MemoryTodo,
  GitSummary,
  ChangelogSummary,
} from './api/active-todos.js';
export {
  lookupGating,
  matchGlob,
  globToRegExp,
  writeDefaultGatingIfMissing,
  DEFAULT_GATING_CONFIG,
} from './api/gating.js';
export type { GatingRule, GatingConfig, GatingMatch, GatingResponse } from './api/gating.js';
export { allocateNextTaskId } from './api/task-id.js';
export type { NextTaskIdResponse } from './api/task-id.js';
export { loadSyncRules, checkSyncPaths, formatViolation } from './suggestions/sync-paths-check.js';
export type { SyncRule, SyncRuleConfig, SyncViolation } from './suggestions/sync-paths-check.js';
export type { ProjectEvent } from './events/types.js';
export type { Observer } from './observers/types.js';
