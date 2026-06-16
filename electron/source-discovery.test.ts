import { describe, it, expect, beforeEach } from 'vitest';
import { SourceDiscovery } from './source-discovery';

describe('SourceDiscovery', () => {
  let sd: SourceDiscovery;

  beforeEach(() => {
    sd = new SourceDiscovery();
  });

  describe('observe()', () => {
    it('returns true for the first time a source is seen for a PGN', () => {
      expect(sd.observe(130306, 16)).toBe(true);
    });

    it('returns false for a repeated (pgn, src) pair', () => {
      sd.observe(130306, 16);
      expect(sd.observe(130306, 16)).toBe(false);
    });

    it('returns true when a new source is seen for an already-known PGN', () => {
      sd.observe(130306, 16);
      expect(sd.observe(130306, 22)).toBe(true);
    });

    it('tracks different PGNs independently', () => {
      expect(sd.observe(130306, 16)).toBe(true);
      expect(sd.observe(127250, 16)).toBe(true); // same src, different PGN — still new
      expect(sd.observe(127250, 16)).toBe(false);
    });
  });

  describe('getDiscoveredSources()', () => {
    it('returns empty object before any observations', () => {
      expect(sd.getDiscoveredSources()).toEqual({});
    });

    it('returns observed sources per PGN', () => {
      sd.observe(130306, 16);
      sd.observe(130306, 22);
      sd.observe(130306, 8);
      sd.observe(127250, 3);

      const result = sd.getDiscoveredSources();
      expect(result[130306]).toEqual([8, 16, 22]); // sorted
      expect(result[127250]).toEqual([3]);
    });

    it('returns a plain object (not a Map)', () => {
      sd.observe(130306, 16);
      const result = sd.getDiscoveredSources();
      expect(typeof result).toBe('object');
      expect(result).not.toBeInstanceOf(Map);
    });
  });

  describe('shouldAccept()', () => {
    it('accepts any source when no preference is set for the PGN', () => {
      expect(sd.shouldAccept(130306, 16, {})).toBe(true);
      expect(sd.shouldAccept(130306, 22, {})).toBe(true);
    });

    it('accepts the preferred source', () => {
      expect(sd.shouldAccept(130306, 16, { 130306: 16 })).toBe(true);
    });

    it('rejects a non-preferred source', () => {
      expect(sd.shouldAccept(130306, 22, { 130306: 16 })).toBe(false);
      expect(sd.shouldAccept(130306, 8, { 130306: 16 })).toBe(false);
    });

    it('only applies preference to the specified PGN', () => {
      const prefs = { 130306: 16 };
      expect(sd.shouldAccept(127250, 22, prefs)).toBe(true); // different PGN, no pref set
    });
  });

  describe('clear()', () => {
    it('resets all observations', () => {
      sd.observe(130306, 16);
      sd.observe(127250, 3);
      sd.clear();
      expect(sd.getDiscoveredSources()).toEqual({});
    });

    it('returns true for previously-seen sources after clear', () => {
      sd.observe(130306, 16);
      sd.clear();
      expect(sd.observe(130306, 16)).toBe(true);
    });
  });
});
