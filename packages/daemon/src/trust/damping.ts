/**
 * Cooldown and alert fatigue prevention.
 *
 * - Region cooldown: suppress duplicate suggestions for the same code region within a time window
 * - Flow detection: suppress suggestions during high-frequency commit bursts
 * - Rate limiting: cap total suggestions per time window
 */
export class DampingController {
  // region → last suggestion timestamp
  private regionCooldowns: Map<string, number> = new Map();
  private cooldownMs: number;

  // Flow detection
  private recentCommitTimestamps: number[] = [];
  private flowThreshold: number;    // commits within window to trigger flow mode
  private flowWindowMs: number;
  private flowQuietMs: number;      // how long to stay quiet after last burst commit
  private lastCommitTime = 0;

  // Rate limiting
  private recentSuggestionTimestamps: number[] = [];
  private maxSuggestionsPerWindow: number;
  private rateWindowMs: number;

  constructor(opts?: {
    cooldownMs?: number;
    flowThreshold?: number;
    flowWindowMs?: number;
    flowQuietMs?: number;
    maxSuggestionsPerWindow?: number;
    rateWindowMs?: number;
  }) {
    this.cooldownMs = opts?.cooldownMs ?? 86400000; // 24h
    this.flowThreshold = opts?.flowThreshold ?? 5;
    this.flowWindowMs = opts?.flowWindowMs ?? 10000;  // 10s
    this.flowQuietMs = opts?.flowQuietMs ?? 30000;    // 30s
    this.maxSuggestionsPerWindow = opts?.maxSuggestionsPerWindow ?? 10;
    this.rateWindowMs = opts?.rateWindowMs ?? 3600000; // 1h
  }

  /**
   * Record a commit event for flow detection.
   */
  recordCommit(): void {
    const now = Date.now();
    this.lastCommitTime = now;
    this.recentCommitTimestamps.push(now);
    // Prune old timestamps
    const cutoff = now - this.flowWindowMs;
    this.recentCommitTimestamps = this.recentCommitTimestamps.filter((t) => t >= cutoff);
  }

  /**
   * Check if a suggestion should be suppressed.
   * Returns null if OK, or a reason string if suppressed.
   */
  shouldSuppress(region?: string): string | null {
    const now = Date.now();

    // 1. Region cooldown
    if (region) {
      const lastTime = this.regionCooldowns.get(region);
      if (lastTime && (now - lastTime) < this.cooldownMs) {
        return 'region_cooldown';
      }
    }

    // 2. Flow detection — developer is in a burst
    const recentCommits = this.recentCommitTimestamps.filter(
      (t) => t >= now - this.flowWindowMs
    ).length;
    if (recentCommits >= this.flowThreshold) {
      return 'flow_active';
    }
    // Also suppress during quiet period after a burst
    if (this.lastCommitTime > 0 && (now - this.lastCommitTime) < this.flowQuietMs) {
      const commitsDuringWindow = this.recentCommitTimestamps.filter(
        (t) => t >= this.lastCommitTime - this.flowWindowMs
      ).length;
      if (commitsDuringWindow >= this.flowThreshold) {
        return 'flow_quiet_period';
      }
    }

    // 3. Rate limiting
    this.recentSuggestionTimestamps = this.recentSuggestionTimestamps.filter(
      (t) => t >= now - this.rateWindowMs
    );
    if (this.recentSuggestionTimestamps.length >= this.maxSuggestionsPerWindow) {
      return 'rate_limited';
    }

    return null;
  }

  /**
   * Mark a suggestion as sent for a given region.
   */
  recordSuggestion(region?: string): void {
    const now = Date.now();
    if (region) {
      this.regionCooldowns.set(region, now);
    }
    this.recentSuggestionTimestamps.push(now);
  }

  /**
   * Check if developer is currently in flow state.
   */
  isInFlow(): boolean {
    const now = Date.now();
    const recentCommits = this.recentCommitTimestamps.filter(
      (t) => t >= now - this.flowWindowMs
    ).length;
    return recentCommits >= this.flowThreshold;
  }
}
