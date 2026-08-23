import { describe, it, expect, beforeEach } from 'vitest';
import { FromPgn, toPgn } from '@canboat/canboatjs';
import { N2KParser } from './n2k-parser';
import type { ParsedPGN } from './serial-manager';

// Helper: generate a valid Actisense serial format string from a PGN + data
function makeActisense(pgn: number, data: Buffer): string {
  const ts = '2026-06-01T12:00:00.000Z';
  const hexBytes = data
    .slice(0, 8)
    .toString('hex')
    .match(/.{1,2}/g)!
    .join(',');
  return `${ts},2,${pgn},0,255,${data.length},${hexBytes}`;
}

// Helper: create a ParsedPGN object for testing normalizeParsedPgn
function makeParsedPGN(pgn: number, fields: Record<string, any> = {}, src?: number): ParsedPGN {
  return {
    pgn,
    src,
    fields,
    timestamp: new Date().toISOString(),
  };
}

// ===================================================================
// Test: canboatjs parser — Actisense ASCII → PGN JSON
// ===================================================================
describe('canboatjs parser', () => {
  let fromPgn: FromPgn;

  beforeEach(() => {
    fromPgn = new FromPgn({ url: 'about:blank', debug: () => {} });
  });

  it('parses a Speed - Water Referenced (PGN 128259) Actisense message', () => {
    const data = toPgn({ pgn: 128259, 'Speed of Water': 2.5, Source: 0 })!;
    const actisense = makeActisense(128259, data);
    const result = fromPgn.parseString(actisense);
    expect(result).toBeDefined();
    expect(Number(result!.pgn)).toBe(128259);
  });

  it('parses Wind Data (PGN 130306) Actisense message', () => {
    const data = toPgn({
      pgn: 130306,
      'Wind Speed': 5.5,
      'Wind Angle': 600,
      'Wind Reference': 'Apparent',
      Source: 0,
    })!;
    const actisense = makeActisense(130306, data);
    const result = fromPgn.parseString(actisense);
    expect(result).toBeDefined();
    expect(Number(result!.pgn)).toBe(130306);
    expect(result!.fields).toBeDefined();
    expect((result!.fields as any).windSpeed).toBe(5.5);
  });

  it('parses Vessel Heading (PGN 127250) Actisense message', () => {
    const data = toPgn({
      pgn: 127250,
      'Heading, Magnetic': 1800,
      'Heading, True': 1800,
      Source: 0,
    })!;
    const actisense = makeActisense(127250, data);
    const result = fromPgn.parseString(actisense);
    expect(result).toBeDefined();
    expect(Number(result!.pgn)).toBe(127250);
  });
});

// ===================================================================
// Test: PGN normalization — normalizeParsedPgn passes all PGNs through
// (PRD §3.8 — pgnFilter abstraction removed; all PGNs are accepted)
// ===================================================================
describe('PGN normalization (BE8 — PRD §3.8)', () => {
  let parser: N2KParser;

  beforeEach(() => {
    parser = new N2KParser();
  });

  it('normalizes Speed (PGN 128259) into PGNMessage format', () => {
    const parsed = makeParsedPGN(128259, { speedWaterReferenced: 2.5 });
    const result = parser.normalizeParsedPgn(parsed);
    expect(result).not.toBeNull();
    expect(result!.pgn).toBe(128259);
    expect(result!.fields.speedWaterReferenced).toBe(2.5);
  });

  it('normalizes Wind Data (PGN 130306)', () => {
    const parsed = makeParsedPGN(130306, { windSpeed: 5.5, windAngle: 0.6, windReference: 'Apparent' });
    const result = parser.normalizeParsedPgn(parsed);
    expect(result).not.toBeNull();
    expect(result!.pgn).toBe(130306);
  });

  it('normalizes Heading (PGN 127250)', () => {
    const parsed = makeParsedPGN(127250, { heading: 3.14 });
    const result = parser.normalizeParsedPgn(parsed);
    expect(result).not.toBeNull();
    expect(result!.pgn).toBe(127250);
  });

  it('passes through any PGN regardless of PGN number', () => {
    // Arbitrary PGNs that were previously "outside a filter" still pass through
    for (const pgn of [129029, 60928, 99999, 1, 999999]) {
      const parsed = makeParsedPGN(pgn, { latitude: 42.0 });
      expect(parser.normalizeParsedPgn(parsed)).not.toBeNull();
    }
  });

  it('passes through src when present', () => {
    const parsed = makeParsedPGN(130306, { windSpeed: 5.5 }, 16);
    const result = parser.normalizeParsedPgn(parsed);
    expect(result).not.toBeNull();
    expect(result!.src).toBe(16);
  });

  it('src is undefined when not provided', () => {
    const parsed = makeParsedPGN(128259, { speedWaterReferenced: 2.5 });
    const result = parser.normalizeParsedPgn(parsed);
    expect(result).not.toBeNull();
    expect(result!.src).toBeUndefined();
  });

  it('returns null for a parsed PGN with a null pgn field', () => {
    const parsed = { pgn: null as any, fields: {}, timestamp: new Date().toISOString() };
    expect(parser.normalizeParsedPgn(parsed)).toBeNull();
  });

  it('uses current time as timestamp fallback when timestamp is missing', () => {
    const parsed = { pgn: 128259, fields: {}, src: undefined } as ParsedPGN;
    const result = parser.normalizeParsedPgn(parsed);
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBeTruthy();
    expect(() => new Date(result!.timestamp)).not.toThrow();
  });
});
