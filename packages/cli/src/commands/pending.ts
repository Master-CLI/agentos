import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanActiveTodos, type ActiveTodosSnapshot } from '@agentos/daemon';

export interface PendingOptions {
  json?: boolean;
}

/**
 * Render the same session-start bundle the daemon serves at
 * `/api/session/pending`. Tries the live daemon first; falls back to a
 * direct in-process scan when the daemon is offline.
 *
 * Designed for use as `! agentos pending` in a fresh Claude Code session —
 * the output is the union of:
 *   - active/draft TASK-*.md files in docs/tasks/
 *   - `type: project` entries in the user's MEMORY.md
 *   - git: branch / ahead / behind / unpushed tags / dirty count
 *   - CHANGELOG.md `[Unreleased]` state
 */
export async function showPending(opts: PendingOptions = {}): Promise<void> {
  const projectDir = process.cwd();
  const agentosDir = path.join(projectDir, '.agentos');
  if (!fs.existsSync(agentosDir)) {
    console.log('AgentOS not initialized in this directory. Run \'agentos init\' first.');
    process.exitCode = 1;
    return;
  }

  let snapshot: ActiveTodosSnapshot | null = null;
  let source: 'daemon' | 'local' = 'local';

  // Try the live daemon first — it has the same data but is the canonical
  // path other clients (web UI / dialog) read from.
  try {
    const configPath = path.join(agentosDir, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { port?: number };
    if (typeof config.port === 'number') {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      try {
        const res = await fetch(`http://localhost:${config.port}/api/session/pending`, {
          signal: controller.signal,
        });
        if (res.ok) {
          snapshot = (await res.json()) as ActiveTodosSnapshot;
          source = 'daemon';
        }
      } finally {
        clearTimeout(t);
      }
    }
  } catch { /* daemon offline — fall through to local scan */ }

  if (!snapshot) {
    snapshot = await scanActiveTodos(projectDir);
  }

  if (opts.json) {
    console.log(JSON.stringify({ source, ...snapshot }, null, 2));
    return;
  }

  printSnapshot(snapshot, source);
}

function printSnapshot(s: ActiveTodosSnapshot, source: 'daemon' | 'local'): void {
  const lines: string[] = [];
  lines.push(`Pending state — ${new Date(s.generatedAt).toLocaleTimeString()} (${source})`);
  lines.push('');

  // ── Git ──
  if (s.git) {
    const g = s.git;
    const ahead = g.ahead > 0 ? `↑${g.ahead}` : '';
    const behind = g.behind > 0 ? `↓${g.behind}` : '';
    const dirty = g.dirtyFiles > 0 ? `${g.dirtyFiles} dirty` : 'clean';
    const upstream = g.upstream ? `→ ${g.upstream}` : g.hasRemote ? '(no upstream)' : '(no remote)';
    const flags = [ahead, behind].filter(Boolean).join(' ');
    lines.push(`  git: ${g.branch ?? '(detached)'} ${upstream} ${flags} · ${dirty}`);
    if (g.unpushedTags.length > 0) {
      lines.push(`       unpushed tags: ${g.unpushedTags.join(', ')}`);
    }
  } else {
    lines.push(`  git: (not a git repo)`);
  }

  // ── CHANGELOG ──
  if (s.changelog) {
    const c = s.changelog;
    if (c.path) {
      const state = c.unreleasedPresent
        ? `${c.unreleasedBulletCount} bullet(s) — ready to release`
        : 'EMPTY — no user-visible changes queued';
      lines.push(`  CHANGELOG [Unreleased]: ${state} (${c.path})`);
    } else {
      lines.push(`  CHANGELOG: (no CHANGELOG.md found)`);
    }
  }

  lines.push('');

  // ── Tasks ──
  if (s.tasks.length === 0) {
    lines.push(`  Tasks: (no active/draft TASK-*.md in docs/tasks/)`);
  } else {
    lines.push(`  Tasks (${s.tasks.length}):`);
    for (const t of s.tasks) {
      const date = t.date ? ` · ${t.date}` : '';
      lines.push(`    [${t.status}] ${t.id} — ${t.title}${date}`);
      lines.push(`      ${t.path}`);
    }
  }

  lines.push('');

  // ── Memory backlog pointers ──
  if (s.memory.length === 0) {
    lines.push(`  Project memory: (no type:project entries)`);
  } else {
    lines.push(`  Project memory (${s.memory.length}):`);
    for (const m of s.memory) {
      lines.push(`    ${m.title}`);
      lines.push(`      ${m.description}`);
      lines.push(`      ${m.file}`);
    }
  }

  if (s.errors.length > 0) {
    lines.push('');
    lines.push(`  Warnings:`);
    for (const e of s.errors) lines.push(`    ${e}`);
  }

  console.log(lines.join('\n'));
}
