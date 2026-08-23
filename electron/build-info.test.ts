/**
 * Fix #3 — build-info module import validity test (BE3 regression guard)
 *
 * Verifies that:
 * 1. electron/build-info.ts is importable and exports the expected string fields.
 * 2. electron/build-info.default.ts (committed fallback) is importable and exports
 *    the same fields with placeholder string values.
 *
 * These tests catch the case where a bad gen-build-info.js write produces a
 * TypeScript file that cannot be imported or has incorrect types.
 */

import { describe, it, expect } from 'vitest';
import { GIT_COMMIT, APP_VERSION, GIT_BRANCH, BUILD_TIME } from './build-info';
import {
  GIT_COMMIT as DEFAULT_COMMIT,
  APP_VERSION as DEFAULT_VERSION,
  GIT_BRANCH as DEFAULT_BRANCH,
  BUILD_TIME as DEFAULT_BUILD_TIME,
} from './build-info.default';

describe('Fix #3 — build-info import validity (BE3 regression guard)', () => {
  it('build-info.ts exports GIT_COMMIT as a string', () => {
    expect(typeof GIT_COMMIT).toBe('string');
    expect(GIT_COMMIT.length).toBeGreaterThan(0);
  });

  it('build-info.ts exports APP_VERSION as a string', () => {
    expect(typeof APP_VERSION).toBe('string');
    expect(APP_VERSION.length).toBeGreaterThan(0);
  });

  it('build-info.ts exports GIT_BRANCH as a string', () => {
    expect(typeof GIT_BRANCH).toBe('string');
  });

  it('build-info.ts exports BUILD_TIME as a string', () => {
    expect(typeof BUILD_TIME).toBe('string');
  });
});

describe('Fix #3 — build-info.default.ts fallback validity (BE3 regression guard)', () => {
  it('build-info.default.ts exports GIT_COMMIT as "dev"', () => {
    expect(DEFAULT_COMMIT).toBe('dev');
  });

  it('build-info.default.ts exports APP_VERSION as a non-empty string', () => {
    expect(typeof DEFAULT_VERSION).toBe('string');
    expect(DEFAULT_VERSION.length).toBeGreaterThan(0);
  });

  it('build-info.default.ts exports GIT_BRANCH as "dev"', () => {
    expect(DEFAULT_BRANCH).toBe('dev');
  });

  it('build-info.default.ts exports BUILD_TIME as a string (empty is valid for dev)', () => {
    expect(typeof DEFAULT_BUILD_TIME).toBe('string');
  });
});
