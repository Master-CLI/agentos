import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOC_DIRS = [
  'docs',
  'docs/concepts',
  'docs/goals',
  'docs/plans',
  'docs/tasks',
  'docs/sessions',
  'docs/decisions',
];

/** Template snippets that can be opted into at init time. */
export const AVAILABLE_MODES = [
  'documentation',
  'parallel',
  'event-sourcing',
  'multi-provider',
] as const;

export type ScaffoldMode = (typeof AVAILABLE_MODES)[number];

export interface ScaffoldOptions {
  /**
   * Which template snippets to embed in CLAUDE.md. `core.md` is always included.
   * Defaults to `['documentation']` to preserve historical behavior for callers
   * that don't pass modes.
   */
  modes?: ScaffoldMode[];
}

/**
 * Resolve the absolute path of the shipped templates/ directory.
 * Works whether called from dist/ (production) or a test that points directly
 * at the built file.
 */
function resolveTemplatesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // From packages/cli/dist/commands/scaffold-docs.js → packages/cli/templates
  const candidate = path.resolve(here, '..', '..', 'templates');
  if (fs.existsSync(candidate)) return candidate;
  // Fallback for running from src/ in dev
  const fallback = path.resolve(here, '..', '..', '..', 'templates');
  if (fs.existsSync(fallback)) return fallback;
  throw new Error(
    `[scaffold-docs] Could not locate templates directory (tried ${candidate} and ${fallback})`,
  );
}

function readTemplate(name: string): string {
  const file = path.join(resolveTemplatesDir(), `${name}.md`);
  return fs.readFileSync(file, 'utf-8');
}

export function scaffoldDocs(targetDir: string, options: ScaffoldOptions = {}): void {
  const modes = options.modes ?? ['documentation'];
  const includeDocumentation = modes.includes('documentation');

  if (includeDocumentation) {
    for (const dir of DOC_DIRS) {
      const fullPath = path.join(targetDir, dir);
      if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
      }
    }

    const indexPath = path.join(targetDir, 'docs', 'INDEX.md');
    if (!fs.existsSync(indexPath)) {
      fs.writeFileSync(indexPath, `# Project Documentation Index

> Auto-maintained by AgentOS. Updated when documents are created.

## Concepts
_(No entries yet)_

## Goals
_(No entries yet)_

## Plans
_(No entries yet)_

## Tasks
_(No entries yet)_

## Sessions
_(No entries yet)_

## Decisions
_(No entries yet)_
`);
    }
  }

  // Build CLAUDE.md from templates.
  const projectName = path.basename(path.resolve(targetDir));
  const parts: string[] = [`# ${projectName} — Project Rules\n`];
  parts.push(readTemplate('core'));

  for (const mode of modes) {
    const templateName: Record<ScaffoldMode, string> = {
      documentation: 'documentation-system',
      parallel: 'parallel-mode',
      'event-sourcing': 'event-sourcing',
      'multi-provider': 'multi-provider',
    };
    parts.push(readTemplate(templateName[mode]));
  }

  const claudeContent = parts.join('\n');
  const claudePath = path.join(targetDir, 'CLAUDE.md');

  if (fs.existsSync(claudePath)) {
    // Don't clobber an existing CLAUDE.md; append if our generated content is
    // new (cheap check: look for the Core section marker).
    const existing = fs.readFileSync(claudePath, 'utf-8');
    if (!existing.includes('## AgentOS')) {
      fs.writeFileSync(claudePath, existing + '\n' + claudeContent);
    }
  } else {
    fs.writeFileSync(claudePath, claudeContent);
  }
}

/**
 * Parse a comma-separated `--mode` flag value into a deduplicated mode list.
 * Accepts `all` as a shortcut for every mode. Unknown values throw.
 */
export function parseModes(input: string | undefined): ScaffoldMode[] {
  if (!input) return ['documentation'];
  const tokens = input.split(',').map((s) => s.trim()).filter(Boolean);
  if (tokens.includes('all')) return [...AVAILABLE_MODES];
  const result: ScaffoldMode[] = [];
  for (const token of tokens) {
    if (!(AVAILABLE_MODES as readonly string[]).includes(token)) {
      throw new Error(
        `Unknown mode '${token}'. Available: ${AVAILABLE_MODES.join(', ')}, or 'all'.`,
      );
    }
    const mode = token as ScaffoldMode;
    if (!result.includes(mode)) result.push(mode);
  }
  return result;
}
