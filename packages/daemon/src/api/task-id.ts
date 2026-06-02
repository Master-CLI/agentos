import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

export interface NextTaskIdResponse {
  nextId: string;
  scanned: number;
  reserved: string[];
}

/**
 * Allocates the next TASK-NNN identifier without creating a placeholder file.
 *
 * Concurrency model: the cached counter under `.agentos/task-counter.json`
 * stores the highest id ever issued. Each call returns `max(disk_scan, cache) + 1`
 * and immediately bumps the cache, so two near-simultaneous callers cannot
 * receive the same id even when neither has written its task file yet.
 *
 * The Node API server is single-threaded so the read-modify-write window is
 * implicit; no extra lock needed.
 */
const COUNTER_FILE = 'task-counter.json';

interface CounterFile {
  highest: number;
  updatedAt: string;
}

function parseTaskId(name: string): number | null {
  const m = name.match(/^TASK-(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

async function scanHighestOnDisk(projectDir: string): Promise<{ highest: number; count: number; ids: string[] }> {
  const tasksDir = path.join(projectDir, 'docs', 'tasks');
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch {
    return { highest: 0, count: 0, ids: [] };
  }
  let highest = 0;
  let count = 0;
  const ids: string[] = [];
  for (const name of entries) {
    if (!/^TASK-.*\.md$/i.test(name)) continue;
    const n = parseTaskId(name);
    if (n == null) continue;
    count += 1;
    ids.push(`TASK-${String(n).padStart(3, '0')}`);
    if (n > highest) highest = n;
  }
  return { highest, count, ids };
}

function readCounter(agentosDir: string): CounterFile {
  const p = path.join(agentosDir, COUNTER_FILE);
  if (!fsSync.existsSync(p)) return { highest: 0, updatedAt: '' };
  try {
    return JSON.parse(fsSync.readFileSync(p, 'utf-8')) as CounterFile;
  } catch {
    return { highest: 0, updatedAt: '' };
  }
}

function writeCounter(agentosDir: string, highest: number): void {
  const p = path.join(agentosDir, COUNTER_FILE);
  fsSync.mkdirSync(agentosDir, { recursive: true });
  fsSync.writeFileSync(p, JSON.stringify({ highest, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

export async function allocateNextTaskId(projectDir: string): Promise<NextTaskIdResponse> {
  const agentosDir = path.join(projectDir, '.agentos');
  const disk = await scanHighestOnDisk(projectDir);
  const cache = readCounter(agentosDir);
  const next = Math.max(disk.highest, cache.highest) + 1;
  writeCounter(agentosDir, next);
  const id = `TASK-${String(next).padStart(3, '0')}`;
  // Treat anything from `cache.highest`-but-not-on-disk as "reserved" so the
  // caller can warn the user about outstanding allocations.
  const reserved: string[] = [];
  for (let n = disk.highest + 1; n < next; n += 1) {
    reserved.push(`TASK-${String(n).padStart(3, '0')}`);
  }
  return { nextId: id, scanned: disk.count, reserved };
}
