import type { FileDiff, ChangeLevel } from './types.js';

/**
 * Classify the change level based on diff characteristics.
 *
 * - light:    single file, <50 lines total change, no interface/type exports
 * - standard: multiple files within same module, or >50 lines
 * - major:    cross-module, changes to interface/type exports, data structures
 */
export function classifyChangeLevel(diffs: FileDiff[], moduleCount: number): ChangeLevel {
  if (diffs.length === 0) return 'light';

  const totalLines = diffs.reduce((sum, d) => sum + d.additions + d.deletions, 0);

  // Cross-module changes are always major
  if (moduleCount > 1) return 'major';

  // Check for interface/type changes in content
  const hasInterfaceChange = diffs.some((d) => {
    const content = d.content || '';
    return /^[+-]\s*export\s+(interface|type|enum)\s/m.test(content);
  });
  if (hasInterfaceChange) return 'major';

  // Single file, small change
  if (diffs.length === 1 && totalLines < 50) return 'light';

  return 'standard';
}
