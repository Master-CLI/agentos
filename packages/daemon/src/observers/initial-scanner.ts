import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { EventStore } from '../events/event-store.js';

const IGNORED = [
  'node_modules', '.git', '.agentos', 'dist', 'build',
  '.next', '.nuxt', 'coverage', '.DS_Store', 'Thumbs.db',
];

/**
 * Scan existing project files and git history on startup,
 * so the daemon has context about the current state.
 * Only runs if the event store is empty (first start).
 */
export async function initialScan(projectDir: string, eventStore: EventStore, projectId: string): Promise<number> {
  // Skip if already have events (not first start)
  if (eventStore.count() > 0) return 0;

  let count = 0;

  // 1. Scan file tree
  const files = walkDir(projectDir, projectDir);
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      eventStore.append({
        source: 'scanner',
        type: 'file_exists',
        payload: {
          path: file,
          relative: path.relative(projectDir, file),
          size: stat.size,
          ext: path.extname(file),
        },
        metadata: { project_id: projectId },
      });
      count++;
    } catch { /* skip unreadable */ }
  }

  // 2. Scan git log (recent 20 commits)
  try {
    const log = execSync(
      'git log --oneline -20 --format="%H|||%s|||%an|||%aI"',
      { cwd: projectDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (log) {
      for (const line of log.split('\n').reverse()) {
        const [hash, message, author, date] = line.split('|||');
        if (hash) {
          eventStore.append({
            source: 'scanner',
            type: 'commit_exists',
            payload: { hash, message, author, date },
            metadata: { project_id: projectId },
          });
          count++;
        }
      }
    }
  } catch { /* not a git repo */ }

  // 3. Scan package.json for dependency info
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      eventStore.append({
        source: 'scanner',
        type: 'project_info',
        payload: {
          name: pkg.name ?? path.basename(projectDir),
          description: pkg.description ?? '',
          dependencies: Object.keys(pkg.dependencies ?? {}),
          devDependencies: Object.keys(pkg.devDependencies ?? {}),
          scripts: Object.keys(pkg.scripts ?? {}),
        },
        metadata: { project_id: projectId },
      });
      count++;
    } catch { /* skip */ }
  }

  return count;
}

function walkDir(dir: string, root: string, maxDepth = 4, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const results: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (IGNORED.includes(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, root, maxDepth, depth + 1));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}
