import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchGlob } from '../api/gating.js';

export interface SyncRule {
  /** Human-readable rule name shown in the suggestion summary. */
  name: string;
  /** Glob — if a changed file matches this, the `requires` are expected too. */
  trigger: string;
  /**
   * Files that must also appear in the same commit when the trigger fires.
   * Each entry is either a literal path or a glob.
   */
  requires: string[];
  /** Optional — reason / decision-doc reference cited in the suggestion. */
  reason?: string;
}

export interface SyncRuleConfig {
  rules: SyncRule[];
}

export interface SyncViolation {
  rule: SyncRule;
  /** Files in the commit that triggered the rule. */
  triggeredBy: string[];
  /** Required entries that no file in the commit satisfied. */
  missing: string[];
}

/**
 * Reads `.agentos/sync-rules.json`. Returns `{ rules: [] }` when missing or
 * invalid — agents can drop a rules file in any time without restarting.
 */
export function loadSyncRules(projectDir: string): SyncRuleConfig {
  const p = path.join(projectDir, '.agentos', 'sync-rules.json');
  if (!fs.existsSync(p)) return { rules: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as SyncRuleConfig;
    if (!parsed || !Array.isArray(parsed.rules)) return { rules: [] };
    return parsed;
  } catch {
    return { rules: [] };
  }
}

/**
 * Compares a commit's file list against the configured rules and returns
 * one violation per rule that triggered but is missing one or more requires.
 *
 * A file path "satisfies" a `requires` entry when either:
 *   - it equals the entry literally (case-sensitive), OR
 *   - the entry is a glob and the file matches it.
 *
 * `triggered` rules with no missing requires produce no violation.
 */
export function checkSyncPaths(filesChanged: string[], rules: SyncRule[]): SyncViolation[] {
  const violations: SyncViolation[] = [];
  if (filesChanged.length === 0) return violations;
  const normalised = filesChanged.map((f) => f.replace(/\\/g, '/'));

  for (const rule of rules) {
    const triggeredBy = normalised.filter((f) => matchGlob(rule.trigger, f));
    if (triggeredBy.length === 0) continue;

    const missing: string[] = [];
    for (const req of rule.requires) {
      const satisfied = normalised.some((f) => f === req || matchGlob(req, f));
      if (!satisfied) missing.push(req);
    }
    if (missing.length === 0) continue;

    violations.push({ rule, triggeredBy, missing });
  }
  return violations;
}

/**
 * Renders a SyncViolation into the suggestion fields the daemon emits.
 * Kept as a helper so the daemon's wiring can stay one-liner.
 */
export function formatViolation(v: SyncViolation, commitHash: string): {
  summary: string;
  detail: string;
} {
  const summary = `Sync paths incomplete: ${v.rule.name}`;
  const reasonLine = v.rule.reason ? `\n${v.rule.reason}\n` : '';
  const detail = [
    `Commit ${commitHash.slice(0, 8)} touched ${v.triggeredBy[0]} (trigger: ${v.rule.trigger}).`,
    reasonLine,
    `Required paths not touched in the same commit:`,
    ...v.missing.map((m) => `  - ${m}`),
    '',
    `If this commit is supposed to be self-contained, update the missing paths`,
    `now (or revise the rule in .agentos/sync-rules.json if it is no longer valid).`,
  ].join('\n');
  return { summary, detail };
}
