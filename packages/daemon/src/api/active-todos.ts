import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { simpleGit, type SimpleGit } from 'simple-git';

export interface TaskTodo {
  kind: 'task';
  id: string;
  title: string;
  status: string;
  date?: string;
  path: string;
}

export interface MemoryTodo {
  kind: 'memory';
  title: string;
  description: string;
  file: string;
}

export interface GitSummary {
  branch: string | null;
  ahead: number;
  behind: number;
  unpushedTags: string[];
  dirtyFiles: number;
  hasRemote: boolean;
  upstream: string | null;
}

export interface ChangelogSummary {
  path: string | null;
  unreleasedPresent: boolean;
  unreleasedBulletCount: number;
}

export interface ActiveTodosSnapshot {
  generatedAt: string;
  projectDir: string;
  memoryDir: string | null;
  tasks: TaskTodo[];
  memory: MemoryTodo[];
  git: GitSummary | null;
  changelog: ChangelogSummary | null;
  errors: string[];
}

const TASK_KEEP_STATUSES = new Set(['active', 'draft', 'in_progress', 'in-progress']);

/**
 * Reproduces Claude Code's per-project memory directory naming:
 * absolute project path with `:`, `\`, and `/` replaced by `-`.
 *
 * Example: `C:\Users\Shado\Downloads\T2\PipeBuilder`
 *       →  `~/.claude/projects/C--Users-Shado-Downloads-T2-PipeBuilder/memory`
 *
 * Returns null if the resulting directory doesn't exist.
 */
function deriveClaudeMemoryDir(projectDir: string): string | null {
  const home = os.homedir();
  const slug = projectDir.replace(/[:\\/]/g, '-');
  const candidate = path.join(home, '.claude', 'projects', slug, 'memory');
  if (!fsSync.existsSync(candidate)) return null;
  return candidate;
}

function parseFrontmatter(raw: string): Record<string, string> {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return {};
  const body = raw.slice(3, end).trim();
  const out: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

async function scanTasks(projectDir: string, errors: string[]): Promise<TaskTodo[]> {
  const tasksDir = path.join(projectDir, 'docs', 'tasks');
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch {
    return [];
  }

  const out: TaskTodo[] = [];
  for (const name of entries) {
    if (!/^TASK-.*\.md$/i.test(name)) continue;
    const full = path.join(tasksDir, name);
    try {
      const raw = await fs.readFile(full, 'utf-8');
      const fm = parseFrontmatter(raw);
      const status = (fm.status || 'unknown').toLowerCase();
      if (!TASK_KEEP_STATUSES.has(status)) continue;
      const idMatch = name.match(/^(TASK-\d+)/i);
      out.push({
        kind: 'task',
        id: idMatch ? idMatch[1].toUpperCase() : name.replace(/\.md$/i, ''),
        title: fm.title || name.replace(/\.md$/i, ''),
        status,
        date: fm.date,
        path: path.relative(projectDir, full).replace(/\\/g, '/'),
      });
    } catch (err) {
      errors.push(`tasks: failed to read ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Reads the user's MEMORY.md index and returns each bullet entry that points
 * at a `type: project` memory file. Format the index uses:
 *
 *   - [Title](file.md) — one-line hook
 */
async function scanMemory(memoryDir: string | null, errors: string[]): Promise<MemoryTodo[]> {
  if (!memoryDir) return [];
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf-8');
  } catch {
    return [];
  }

  const out: MemoryTodo[] = [];
  const bullet = /^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.+?)\s*$/;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(bullet);
    if (!m) continue;
    const [, title, file, description] = m;
    if (!file.endsWith('.md')) continue;
    const memFull = path.join(memoryDir, file);
    let isProject = false;
    try {
      const memRaw = await fs.readFile(memFull, 'utf-8');
      const fm = parseFrontmatter(memRaw);
      isProject = (fm.type || '').toLowerCase() === 'project';
    } catch (err) {
      errors.push(`memory: failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!isProject) continue;
    out.push({ kind: 'memory', title, description, file });
  }
  return out;
}

/**
 * Branch / ahead / behind / unpushed-tags / dirty summary. Returns null when
 * the project isn't a git repo. Doesn't fetch — `ahead`/`behind` reflect the
 * cached remote ref, which is fine for a session-start hint.
 */
async function scanGit(projectDir: string, errors: string[]): Promise<GitSummary | null> {
  let git: SimpleGit;
  try {
    git = simpleGit(projectDir);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) return null;
  } catch {
    return null;
  }

  const summary: GitSummary = {
    branch: null,
    ahead: 0,
    behind: 0,
    unpushedTags: [],
    dirtyFiles: 0,
    hasRemote: false,
    upstream: null,
  };

  try {
    const status = await git.status();
    summary.branch = status.current ?? null;
    summary.ahead = status.ahead ?? 0;
    summary.behind = status.behind ?? 0;
    summary.upstream = status.tracking ?? null;
    summary.dirtyFiles =
      status.modified.length +
      status.staged.length +
      status.not_added.length +
      status.created.length +
      status.deleted.length +
      status.renamed.length +
      status.conflicted.length;
  } catch (err) {
    errors.push(`git: status failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const remotes = await git.getRemotes(false);
    summary.hasRemote = remotes.length > 0;
  } catch { /* ignore */ }

  // Unpushed tags: tags that exist locally but not on origin. If no remote,
  // skip — the comparison would error.
  if (summary.hasRemote) {
    try {
      const localTagsRaw = await git.raw(['tag', '--list']);
      const localTags = localTagsRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (localTags.length > 0) {
        // `git ls-remote --tags origin` lists `<sha>\trefs/tags/<name>` and
        // also `refs/tags/<name>^{}` peeled entries. Normalise to a set.
        const lsRemoteRaw = await git.raw(['ls-remote', '--tags', 'origin']);
        const remoteTags = new Set<string>();
        for (const line of lsRemoteRaw.split(/\r?\n/)) {
          const m = line.match(/refs\/tags\/(.+?)(\^\{\})?$/);
          if (m) remoteTags.add(m[1]);
        }
        summary.unpushedTags = localTags.filter((t) => !remoteTags.has(t));
      }
    } catch {
      // Network failure / no origin reachable — leave empty.
    }
  }

  return summary;
}

/**
 * Looks for a top-level CHANGELOG.md and reports whether the `[Unreleased]`
 * section has any bullets (or any non-heading content). This is the canonical
 * pre-release readiness signal in the PipeBuilder workflow.
 */
async function scanChangelog(projectDir: string, errors: string[]): Promise<ChangelogSummary | null> {
  // Standard locations: project root, then `web/` (PipeBuilder convention).
  const candidates = [
    path.join(projectDir, 'CHANGELOG.md'),
    path.join(projectDir, 'web', 'CHANGELOG.md'),
  ];
  let foundPath: string | null = null;
  let raw: string | null = null;
  for (const c of candidates) {
    try {
      raw = await fs.readFile(c, 'utf-8');
      foundPath = c;
      break;
    } catch { /* try next */ }
  }
  if (!raw || !foundPath) return { path: null, unreleasedPresent: false, unreleasedBulletCount: 0 };

  const lines = raw.split(/\r?\n/);
  let inUnreleased = false;
  let bulletCount = 0;
  let nonHeadingLines = 0;
  for (const line of lines) {
    if (/^##\s+\[Unreleased\]/i.test(line)) {
      inUnreleased = true;
      continue;
    }
    if (inUnreleased && /^##\s+\[/.test(line)) {
      // Hit the next release header → stop.
      break;
    }
    if (!inUnreleased) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^-\s+/.test(trimmed)) bulletCount += 1;
    if (!/^###\s+/.test(trimmed)) nonHeadingLines += 1;
  }

  // Track read errors only if literally nothing parsed.
  if (lines.length === 0) {
    errors.push(`changelog: ${foundPath} appears empty`);
  }

  return {
    path: path.relative(projectDir, foundPath).replace(/\\/g, '/'),
    unreleasedPresent: bulletCount > 0 || nonHeadingLines > 0,
    unreleasedBulletCount: bulletCount,
  };
}

export async function scanActiveTodos(projectDir: string): Promise<ActiveTodosSnapshot> {
  const errors: string[] = [];
  const memoryDir = deriveClaudeMemoryDir(projectDir);
  const [tasks, memory, git, changelog] = await Promise.all([
    scanTasks(projectDir, errors),
    scanMemory(memoryDir, errors),
    scanGit(projectDir, errors),
    scanChangelog(projectDir, errors),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    projectDir,
    memoryDir,
    tasks,
    memory,
    git,
    changelog,
    errors,
  };
}
