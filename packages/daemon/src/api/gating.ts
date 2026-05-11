import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

export interface GatingRule {
  /** Glob pattern matched against the file path relative to the project root. */
  glob: string;
  /** Decision-doc / convention-doc paths the agent should read before editing. */
  readBefore: string[];
  /** Optional human-readable reason — surfaced in the API response. */
  reason?: string;
}

export interface GatingConfig {
  rules: GatingRule[];
}

export interface GatingMatch {
  rule: GatingRule;
  /** Subset of `rule.readBefore` paths that actually exist on disk. */
  existingDocs: string[];
}

export interface GatingResponse {
  file: string;
  matches: GatingMatch[];
  /** True when the projectDir has a .agentos/gating.json. */
  configured: boolean;
}

/**
 * Default ruleset shipped on `agentos init`. Generic enough to be useful for
 * any TypeScript + docs/decisions project; users can edit freely afterwards.
 * AgentOS never overwrites an existing gating.json.
 */
export const DEFAULT_GATING_CONFIG: GatingConfig = {
  rules: [
    {
      glob: 'docs/decisions/**/*.md',
      readBefore: ['docs/decisions/'],
      reason: 'Decision docs are append-only / revision-with-history. Read the existing doc before editing.',
    },
    {
      glob: '**/migrations/**',
      readBefore: ['docs/decisions/'],
      reason: 'Migrations are forward-only. Check existing migration shape before adding a new file.',
    },
    {
      glob: 'CHANGELOG.md',
      readBefore: ['docs/development/release-process.md'],
      reason: 'CHANGELOG bullets are product copy under [Unreleased]. See the release-process doc for conventions.',
    },
  ],
};

/**
 * Compiles a `*`/`**`/`?` glob to a RegExp. Supports:
 *   `*`   — anything except `/`
 *   `**`  — anything including `/`
 *   `?`   — single char (not `/`)
 *   `.`, `+`, `(`, `)`, `[`, `]`, `{`, `}`, `^`, `$`, `|`, `\\` — literal
 *
 * Not a full minimatch implementation; covers the practical cases for
 * directory-prefix and extension matching that gating rules need.
 */
export function globToRegExp(glob: string): RegExp {
  // Normalise path separators in the input.
  const normalised = glob.replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < normalised.length) {
    const c = normalised[i];
    if (c === '*') {
      if (normalised[i + 1] === '*') {
        re += '.*';
        i += 2;
        // Eat trailing `/` after `**` so `foo/**/bar` matches both
        // `foo/bar` and `foo/x/bar`.
        if (normalised[i] === '/') i += 1;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if ('.+()[]{}^$|\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
      continue;
    }
    re += c;
    i += 1;
  }
  return new RegExp('^' + re + '$');
}

export function matchGlob(glob: string, filePath: string): boolean {
  const normalised = filePath.replace(/\\/g, '/');
  return globToRegExp(glob).test(normalised);
}

async function readConfig(projectDir: string): Promise<{ config: GatingConfig; configured: boolean }> {
  const cfgPath = path.join(projectDir, '.agentos', 'gating.json');
  if (!fsSync.existsSync(cfgPath)) {
    return { config: DEFAULT_GATING_CONFIG, configured: false };
  }
  try {
    const raw = await fs.readFile(cfgPath, 'utf-8');
    const parsed = JSON.parse(raw) as GatingConfig;
    if (!parsed || !Array.isArray(parsed.rules)) {
      return { config: DEFAULT_GATING_CONFIG, configured: false };
    }
    return { config: parsed, configured: true };
  } catch {
    return { config: DEFAULT_GATING_CONFIG, configured: false };
  }
}

export async function lookupGating(projectDir: string, file: string): Promise<GatingResponse> {
  const { config, configured } = await readConfig(projectDir);
  const matches: GatingMatch[] = [];
  for (const rule of config.rules) {
    if (!matchGlob(rule.glob, file)) continue;
    const existingDocs: string[] = [];
    for (const doc of rule.readBefore) {
      // A trailing slash in `readBefore` means "this directory" — surface as-is
      // since the agent will list the dir; otherwise check the file exists.
      if (doc.endsWith('/') || doc.endsWith('\\')) {
        existingDocs.push(doc);
        continue;
      }
      if (fsSync.existsSync(path.join(projectDir, doc))) {
        existingDocs.push(doc);
      }
    }
    matches.push({ rule, existingDocs });
  }
  return { file, matches, configured };
}

/**
 * Writes the default gating.json into `.agentos/` if it doesn't already exist.
 * No-op when a user-edited file is already present.
 */
export function writeDefaultGatingIfMissing(projectDir: string): boolean {
  const cfgPath = path.join(projectDir, '.agentos', 'gating.json');
  if (fsSync.existsSync(cfgPath)) return false;
  fsSync.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fsSync.writeFileSync(cfgPath, JSON.stringify(DEFAULT_GATING_CONFIG, null, 2) + '\n');
  return true;
}
