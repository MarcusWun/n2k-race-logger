import { describe, it, expect, beforeEach } from 'vitest';
import { FromPgn, encodeActisense, toPgn } from '@canboat/canboatjs';
import { N2KParser } from './n2k-parser';

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
// Test: PGN filtering — only configured PGNs pass through
// ===================================================================
describe('PGN filtering', () => {
  let parser: N2KParser;

  const ALLOWED_PGNS = [128259, 130306, 127250];

  beforeEach(() => {
    parser = new N2KParser({ pgnFilter: ALLOWED_PGNS });
  });

  it('passes through allowed PGNs (Speed 128259)', () => {
    const data = toPgn({ pgn: 128259, 'Speed of Water': 2.5, Source: 0 })!;
    const actisense = makeActisense(128259, data);
    const result = parser.parse(actisense);
    expect(result).not.toBeNull();
    expect(result!.pgn).toBe(128259);
  });

  it('passes through wind data (130306)', () => {
    const data = toPgn({
      pgn: 130306,
      'Wind Speed': 5.5,
      'Wind Angle': 600,
      'Wind Reference': 'Apparent',
      Source: 0,
    })!;
    const actisense = makeActisense(130306, data);
    const result = parser.parse(actisense);
    expect(result).not.toBeNull();
    expect(result!.pgn).toBe(130306);
  });

  it('passes through heading (127250)', () => {
    const data = toPgn({
      pgn: 127250,
      'Heading, Magnetic': 1800,
      'Heading, True': 1800,
      Source: 0,
    })!;
    const actisense = makeActisense(127250, data);
    const result = parser.parse(actisense);
    expect(result).not.toBeNull();
    expect(result!.pgn).toBe(127250);
  });
});
