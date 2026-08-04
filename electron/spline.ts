/**
 * 1-D spline interpolation module — main-process entry point.
 *
 * The actual implementation lives in src/lib/spline.ts so that both the
 * Electron main process (this file) and the renderer (PolarDiagram.tsx) can
 * import the same pure-math functions without duplication.
 *
 * Re-exports pchip and akima unchanged.
 */
export { pchip, akima } from '../src/lib/spline';
