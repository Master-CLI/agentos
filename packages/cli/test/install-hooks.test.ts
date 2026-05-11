import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { installPreCommitHook } from '../src/commands/install-hooks.js';

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-hooks-'));
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  return dir;
}

function rm(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('install-hooks — overwrite safety', () => {
  let project: string;
  beforeEach(() => { project = mkRepo(); });
  afterEach(() => rm(project));

  it('installs into .git/hooks/pre-commit on a fresh repo', () => {
    const r = installPreCommitHook(project);
    expect(r.status).toBe('installed');
    expect(r.hookPath).toContain('pre-commit');
    expect(fs.readFileSync(r.hookPath!, 'utf-8')).toContain('AGENTOS-MANAGED-HOOK');
  });

  it('refuses to overwrite a foreign hook without --force', () => {
    const hookPath = path.join(project, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho user hook\n');
    const r = installPreCommitHook(project);
    expect(r.status).toBe('skipped-foreign');
    expect(fs.readFileSync(hookPath, 'utf-8')).toBe('#!/bin/sh\necho user hook\n');
  });

  it('overwrites a foreign hook when forced', () => {
    const hookPath = path.join(project, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho user hook\n');
    const r = installPreCommitHook(project, { force: true });
    expect(r.status).toBe('updated');
    expect(fs.readFileSync(hookPath, 'utf-8')).toContain('AGENTOS-MANAGED-HOOK');
  });

  it('is a no-op on a second call (idempotent)', () => {
    installPreCommitHook(project);
    const r2 = installPreCommitHook(project);
    expect(r2.status).toBe('unchanged');
  });

  it('updates an agentos-managed hook if content drifted', () => {
    const hookPath = path.join(project, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\n# AGENTOS-MANAGED-HOOK v0\nexit 0\n');
    const r = installPreCommitHook(project);
    expect(r.status).toBe('updated');
    expect(fs.readFileSync(hookPath, 'utf-8')).toContain('AGENTOS-MANAGED-HOOK v1');
  });

  it('returns skipped-not-git on a non-git directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-nongit-'));
    try {
      const r = installPreCommitHook(dir);
      expect(r.status).toBe('skipped-not-git');
    } finally {
      rm(dir);
    }
  });
});
