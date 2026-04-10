/**
 * Tracks historical accept/reject rates per suggestion category
 * and adjusts confidence scores accordingly.
 */
export class ConfidenceCalibrator {
  // category → { accepted, rejected }
  private history: Map<string, { accepted: number; rejected: number }> = new Map();

  record(category: string, accepted: boolean): void {
    let entry = this.history.get(category);
    if (!entry) {
      entry = { accepted: 0, rejected: 0 };
      this.history.set(category, entry);
    }
    if (accepted) entry.accepted++;
    else entry.rejected++;
  }

  /**
   * Adjust a raw confidence score based on historical acceptance rate.
   * Returns clamped value in [0, 1].
   */
  adjust(category: string, rawConfidence: number): number {
    const entry = this.history.get(category);
    if (!entry) return rawConfidence;

    const total = entry.accepted + entry.rejected;
    if (total < 3) return rawConfidence; // Not enough data

    const acceptRate = entry.accepted / total;
    // Blend raw confidence with historical acceptance rate
    const adjusted = rawConfidence * 0.6 + acceptRate * 0.4;
    return Math.max(0, Math.min(1, adjusted));
  }

  getStats(category: string): { accepted: number; rejected: number; rate: number } | null {
    const entry = this.history.get(category);
    if (!entry) return null;
    const total = entry.accepted + entry.rejected;
    return { ...entry, rate: total > 0 ? entry.accepted / total : 0 };
  }
}
