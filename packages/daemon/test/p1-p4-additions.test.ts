import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanActiveTodos } from '../src/api/active-todos.js';
import { globToRegExp, matchGlob, lookupGating, writeDefaultGatingIfMissing } from '../src/api/gating.js';
import { allocateNextTaskId } from '../src/api/task-id.js';
import { checkSyncPaths, loadSyncRules } from '../src/suggestions/sync-paths-check.js';
import { ConfigRefresher } from '../src/state/config-refresh.js';
import { safeRmSync } from './helpers.js';

function mkTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-p1p4-'));
  fs.mkdirSync(path.join(dir, '.agentos'), { recursive: true });
  return dir;
}

describe('P3 — globToRegExp', () => {
  it('* matches anything but /', () => {
    expect(matchGlob('docs/*.md', 'docs/a.md')).toBe(true);
    expect(matchGlob('docs/*.md', 'docs/sub/a.md')).toBe(false);
  });

  it('** crosses /', () => {
    expect(matchGlob('docs/**/*.md', 'docs/a.md')).toBe(true);
    expect(matchGlob('docs/**/*.md', 'docs/sub/a.md')).toBe(true);
    expect(matchGlob('docs/**/*.md', 'docs/sub/deep/a.md')).toBe(true);
  });

  it('literal slashes match exactly', () => {
    expect(matchGlob('a/b.md', 'a/b.md')).toBe(true);
    expect(matchGlob('a/b.md', 'a/b/c.md')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    const re = globToRegExp('a.b+c');
    expect(re.test('a.b+c')).toBe(true);
    expect(re.test('axbxc')).toBe(false);
  });

  it('normalises Windows backslashes', () => {
    expect(matchGlob('docs/*.md', 'docs\\a.md')).toBe(true);
  });
});

describe('P3 — lookupGating', () => {
  let project: string;
  beforeEach(() => { project = mkTempProject(); });
  afterEach(() => safeRmSync(project));

  it('returns matches when rules are configured', async () => {
    fs.writeFileSync(
      path.join(project, '.agentos', 'gating.json'),
      JSON.stringify({
        rules: [
          { glob: 'src/foo.ts', readBefore: ['docs/RULES.md'], reason: 'rule one' },
          { glob: '**/*.ts', readBefore: ['docs/TS.md'] },
        ],
      }),
    );
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(project, 'docs', 'RULES.md'), '# rules');
    const result = await lookupGating(project, 'src/foo.ts');
    expect(result.configured).toBe(true);
    expect(result.matches.length).toBe(2);
    expect(result.matches[0].existingDocs).toEqual(['docs/RULES.md']);
    expect(result.matches[1].existingDocs).toEqual([]); // TS.md doesn't exist
  });

  it('falls back to defaults when gating.json missing', async () => {
    const result = await lookupGating(project, 'CHANGELOG.md');
    expect(result.configured).toBe(false);
    // Default ruleset matches CHANGELOG.md.
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it('writeDefaultGatingIfMissing is a no-op when file exists', () => {
    const target = path.join(project, '.agentos', 'gating.json');
    fs.writeFileSync(target, '{"rules":[]}');
    const wrote = writeDefaultGatingIfMissing(project);
    expect(wrote).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('{"rules":[]}');
  });
});

describe('P3 — allocateNextTaskId', () => {
  let project: string;
  beforeEach(() => { project = mkTempProject(); });
  afterEach(() => safeRmSync(project));

  it('returns TASK-001 on an empty project', async () => {
    const r = await allocateNextTaskId(project);
    expect(r.nextId).toBe('TASK-001');
    expect(r.scanned).toBe(0);
  });

  it('reads existing task ids from disk', async () => {
    const tasksDir = path.join(project, 'docs', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'TASK-001-foo.md'), '');
    fs.writeFileSync(path.join(tasksDir, 'TASK-007-bar.md'), '');
    const r = await allocateNextTaskId(project);
    expect(r.nextId).toBe('TASK-008');
    expect(r.scanned).toBe(2);
  });

  it('respects cached counter when no file written yet', async () => {
    const r1 = await allocateNextTaskId(project);
    const r2 = await allocateNextTaskId(project);
    const r3 = await allocateNextTaskId(project);
    expect(r1.nextId).toBe('TASK-001');
    expect(r2.nextId).toBe('TASK-002');
    expect(r3.nextId).toBe('TASK-003');
    // r2 + r3 are reserved but not on disk.
    expect(r3.reserved).toEqual(['TASK-001', 'TASK-002']);
  });
});

describe('P4 — checkSyncPaths', () => {
  it('returns no violations when trigger does not match', () => {
    const v = checkSyncPaths(['src/foo.ts'], [
      { name: 'r', trigger: 'migrations/**', requires: ['x.ts'] },
    ]);
    expect(v).toEqual([]);
  });

  it('returns a violation when trigger fires but requires are missing', () => {
    const v = checkSyncPaths(
      ['migrations/001_add_col.js', 'src/unrelated.ts'],
      [{ name: 'pb-sync', trigger: 'migrations/**', requires: ['sync/mirror.ts', 'sync/exportBundle.ts'] }],
    );
    expect(v.length).toBe(1);
    expect(v[0].missing).toEqual(['sync/mirror.ts', 'sync/exportBundle.ts']);
    expect(v[0].triggeredBy).toEqual(['migrations/001_add_col.js']);
  });

  it('passes when all requires satisfied', () => {
    const v = checkSyncPaths(
      ['migrations/001.js', 'sync/mirror.ts', 'sync/exportBundle.ts'],
      [{ name: 'pb-sync', trigger: 'migrations/**', requires: ['sync/mirror.ts', 'sync/exportBundle.ts'] }],
    );
    expect(v).toEqual([]);
  });

  it('requires entries can be globs', () => {
    const v = checkSyncPaths(
      ['fittings/types.ts', 'render/FittingRenderer.tsx'],
      [{ name: 'r', trigger: 'fittings/types.ts', requires: ['render/*Renderer.tsx', 'bom/data.ts'] }],
    );
    expect(v.length).toBe(1);
    expect(v[0].missing).toEqual(['bom/data.ts']);
  });

  it('loadSyncRules returns empty when file missing', () => {
    const project = mkTempProject();
    try {
      expect(loadSyncRules(project).rules).toEqual([]);
    } finally {
      safeRmSync(project);
    }
  });
});

describe('P1 — scanActiveTodos includes git + changelog', () => {
  let project: string;
  beforeEach(() => { project = mkTempProject(); });
  afterEach(() => safeRmSync(project));

  it('CHANGELOG with bullets under [Unreleased] reports present', async () => {
    fs.writeFileSync(
      path.join(project, 'CHANGELOG.md'),
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### Added',
        '- New feature X',
        '- New feature Y',
        '',
        '## [0.1.0] - 2026-01-01',
        '',
        '- old',
      ].join('\n'),
    );
    const s = await scanActiveTodos(project);
    expect(s.changelog?.path).toBe('CHANGELOG.md');
    expect(s.changelog?.unreleasedPresent).toBe(true);
    expect(s.changelog?.unreleasedBulletCount).toBe(2);
  });

  it('CHANGELOG with empty [Unreleased] reports not-present', async () => {
    fs.writeFileSync(
      path.join(project, 'CHANGELOG.md'),
      ['# Changelog', '', '## [Unreleased]', '', '## [0.1.0]', '- shipped'].join('\n'),
    );
    const s = await scanActiveTodos(project);
    expect(s.changelog?.unreleasedPresent).toBe(false);
    expect(s.changelog?.unreleasedBulletCount).toBe(0);
  });

  it('non-git dir returns git: null without error', async () => {
    const s = await scanActiveTodos(project);
    expect(s.git).toBe(null);
    expect(s.errors).toEqual([]);
  });

  it('reads tasks with active/draft status only', async () => {
    const tasksDir = path.join(project, 'docs', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const fm = (status: string) => `---\ntype: task\ntitle: t\nstatus: ${status}\n---\nbody`;
    fs.writeFileSync(path.join(tasksDir, 'TASK-001-a.md'), fm('active'));
    fs.writeFileSync(path.join(tasksDir, 'TASK-002-b.md'), fm('completed'));
    fs.writeFileSync(path.join(tasksDir, 'TASK-003-c.md'), fm('draft'));
    const s = await scanActiveTodos(project);
    const ids = s.tasks.map((t) => t.id);
    expect(ids).toEqual(['TASK-001', 'TASK-003']);
  });
});

describe('P1 — ConfigRefresher', () => {
  let project: string;
  beforeEach(() => { project = mkTempProject(); });
  afterEach(() => safeRmSync(project));

  it('refreshOnce overwrites stale path/name fields', () => {
    const configPath = path.join(project, '.agentos', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: '0.1.0',
        project: { path: 'C:/some/old/path', name: 'OldName', git_commit_count: 0 },
        port: 3382,
      }),
    );
    const r = new ConfigRefresher({ configPath, projectDir: project });
    r.refreshOnce();
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.project.path).toBe(project);
    expect(after.project.name).toBe(path.basename(project));
    // Other top-level keys preserved.
    expect(after.port).toBe(3382);
  });

  it('refreshOnce on non-git dir marks git_available false', () => {
    const configPath = path.join(project, '.agentos', 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ project: { git_available: true, git_commit_count: 999 } }),
    );
    const r = new ConfigRefresher({ configPath, projectDir: project });
    r.refreshOnce();
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(after.project.git_available).toBe(false);
  });
});
