/**
 * Tracks which source addresses have been observed for each PGN on the N2K bus.
 * Used to populate source selection dropdowns in Settings and to filter incoming
 * PGN data to only the user-preferred source per PGN.
 */
export class SourceDiscovery {
  private sources: Map<number, Set<number>> = new Map();

  /**
   * Record an observed (pgn, src) pair. Returns true if this is the first time
   * this source has been seen for this PGN (signals UI should refresh).
   */
  observe(pgn: number, src: number): boolean {
    let set = this.sources.get(pgn);
    if (!set) {
      set = new Set();
      this.sources.set(pgn, set);
    }
    if (set.has(src)) return false;
    set.add(src);
    return true;
  }

  /**
   * Returns a plain serializable snapshot of all discovered sources.
   * Shape: { [pgn]: number[] }
   */
  getDiscoveredSources(): Record<number, number[]> {
    const result: Record<number, number[]> = {};
    for (const [pgn, set] of this.sources.entries()) {
      result[pgn] = Array.from(set).sort((a, b) => a - b);
    }
    return result;
  }

  /**
   * Returns true if the message from (pgn, src) should be accepted given the
   * user's source preferences. A PGN with no preference set accepts any source.
   */
  shouldAccept(pgn: number, src: number, preferences: Record<number, number>): boolean {
    const preferred = preferences[pgn];
    if (preferred == null) return true;
    return src === preferred;
  }

  /**
   * Clear all accumulated source observations (for rescan).
   */
  clear(): void {
    this.sources.clear();
  }
}
