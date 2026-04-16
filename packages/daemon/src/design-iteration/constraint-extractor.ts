import { ulid } from 'ulid';
import type { DesignReview, DesignConstraint } from './types.js';

interface PatternRule {
  patterns: RegExp[];
  rule: string;
  description: string;
}

const CONSTRAINT_PATTERNS: PatternRule[] = [
  {
    patterns: [/窄条/, /sliver/i, /narrow\s*room/i],
    rule: 'min_room_narrow',
    description: 'Room narrow side must meet minimum width',
  },
  {
    patterns: [/路不通/, /不通/, /disconnected/i, /unreachable/i],
    rule: 'corridor_connectivity',
    description: 'All rooms must be reachable from the corridor',
  },
  {
    patterns: [/放弃/, /abandoned/i, /废弃/],
    rule: 'no_abandoned_cells',
    description: 'No abandoned (unassigned) cells allowed',
  },
  {
    patterns: [/太大/, /oversized/i, /过大/],
    rule: 'max_room_area',
    description: 'Room area must not exceed maximum threshold',
  },
  {
    patterns: [/太碎/, /fragmented/i, /碎片/],
    rule: 'min_room_area',
    description: 'Room area must meet minimum threshold',
  },
  {
    patterns: [/靠墙/, /flush/i, /沿墙/],
    rule: 'corridor_wall_alignment',
    description: 'Corridor should be flush against walls',
  },
  {
    patterns: [/core.{0,6}(?:去掉|移除|remove|avoid)/i, /(?:去掉|移除|remove|avoid).{0,6}core/i],
    rule: 'core_avoidance',
    description: 'Avoid placing rooms in core region',
  },
];

/**
 * Extract design constraints from review comments using pattern matching.
 * Scans both per-rating comments and the overall comment.
 */
export function extractConstraints(review: DesignReview, round: number): DesignConstraint[] {
  const found: DesignConstraint[] = [];
  const seenRules = new Set<string>();

  const tryMatch = (text: string): void => {
    if (!text) return;
    for (const { patterns, rule, description } of CONSTRAINT_PATTERNS) {
      if (seenRules.has(rule)) continue;
      for (const re of patterns) {
        if (re.test(text)) {
          seenRules.add(rule);
          found.push({
            id: ulid(),
            created_at: new Date().toISOString(),
            round,
            rule,
            description,
            source_comment: text,
          });
          break;
        }
      }
    }
  };

  // Check overall comment
  tryMatch(review.overall_comment);

  // Check each rating comment
  for (const rating of review.ratings) {
    tryMatch(rating.comment);
  }

  return found;
}
