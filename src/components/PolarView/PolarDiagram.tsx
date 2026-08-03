import React, { useRef, useEffect } from 'react';
import type { PolarData } from '../../types/polar';
import { usePolarStore } from '../../store/usePolarStore';
import { useN2KStore } from '../../store/useN2KStore';
import { normalizedWindAngleValue } from '../../utils/angles';

interface PolarDiagramProps {
  polarData: PolarData | null;
}

const COLORS = ['#00d4ff', '#00ff88', '#ffaa00', '#ff4444', '#aa66ff', '#ff66aa'];

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Convert TWA (0°=top/upwind, 180°=bottom/downwind) and speed to canvas coordinates.
 * Standard sailing polar: wind from top, starboard half (0-180°) on the right.
 */
function polarToCanvas(
  cx: number,
  cy: number,
  twa: number,
  speed: number,
  scale: number,
): { x: number; y: number } {
  const rad = degToRad(twa);
  return {
    x: cx + speed * scale * Math.sin(rad),
    y: cy - speed * scale * Math.cos(rad),
  };
}

/**
 * 1-D linear interpolation within a single TWS row.
 * twaAxis and speedRow are parallel arrays from polarData.
 */
function interpolateRowSpeed(
  twaAxis: number[],
  speedRow: number[],
  targetTwa: number,
): number {
  if (twaAxis.length === 0) return 0;
  if (targetTwa <= twaAxis[0]) return speedRow[0] ?? 0;
  if (targetTwa >= twaAxis[twaAxis.length - 1]) return speedRow[twaAxis.length - 1] ?? 0;
  for (let i = 0; i < twaAxis.length - 1; i++) {
    if (twaAxis[i] <= targetTwa && twaAxis[i + 1] >= targetTwa) {
      const t = (targetTwa - twaAxis[i]) / (twaAxis[i + 1] - twaAxis[i]);
      return speedRow[i] * (1 - t) + speedRow[i + 1] * t;
    }
  }
  return 0;
}

export default function PolarDiagram({ polarData }: PolarDiagramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const performance = usePolarStore((s) => s.performance);
  const twa = useN2KStore((s) => s.twa);
  const stw = useN2KStore((s) => s.stw);
  const normalizedTwa = twa !== null ? normalizedWindAngleValue(twa) : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;

    // Origin at center of canvas — TWA 0° goes up, 180° goes down
    const cx = w * 0.15;
    const cy = h * 0.5;
    const maxRadius = Math.min(w * 0.8, h * 0.45) * 0.9;

    ctx.clearRect(0, 0, w, h);

    if (!polarData) {
      ctx.fillStyle = '#666';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No polar data loaded', w / 2, h / 2);
      return;
    }

    // Find max speed for scaling
    let maxSpeed = 0;
    for (const row of polarData.speeds) {
      for (const s of row) {
        if (s > maxSpeed) maxSpeed = s;
      }
    }
    if (maxSpeed === 0) return;
    const scale = maxRadius / maxSpeed;

    // Draw grid circles (speed rings)
    const gridStep = maxSpeed <= 8 ? 2 : maxSpeed <= 16 ? 4 : 5;
    for (let spd = gridStep; spd <= maxSpeed + gridStep; spd += gridStep) {
      const r = spd * scale;
      ctx.beginPath();
      // Draw arc from -90° to +90° (top half to bottom half on starboard side)
      ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Speed label on the right
      ctx.fillStyle = '#555';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${spd} kts`, cx + r + 4, cy + 3);
    }

    // Draw TWA angle lines at 30° intervals
    for (let angle = 0; angle <= 180; angle += 30) {
      const pt = polarToCanvas(cx, cy, angle, maxSpeed * 1.1, scale);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(pt.x, pt.y);
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Angle label
      const labelPt = polarToCanvas(cx, cy, angle, maxSpeed * 1.18, scale);
      ctx.fillStyle = '#555';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${angle}°`, labelPt.x, labelPt.y);
    }

    // Wind arrow at top
    ctx.fillStyle = '#444';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('WIND', cx, cy - maxRadius * 1.1 - 4);
    // Small arrow
    const arrowY = cy - maxRadius * 1.1;
    ctx.beginPath();
    ctx.moveTo(cx, arrowY);
    ctx.lineTo(cx - 5, arrowY - 10);
    ctx.lineTo(cx + 5, arrowY - 10);
    ctx.closePath();
    ctx.fillStyle = '#444';
    ctx.fill();

    // Draw polar curves for each TWS.
    // Render at uniform 1° increments rather than at raw data TWA values.
    // This decouples rendering resolution from data density — the source data
    // may have clustered VMG angles and sparse standard angles, which causes
    // kinks when connected directly. Uniform 1° spacing + lineTo is visually
    // smooth without needing splines.
    polarData.tws.forEach((twsVal, twsIdx) => {
      const color = COLORS[twsIdx % COLORS.length];
      const twaAxis = polarData.twa;
      const speedRow = polarData.speeds[twsIdx] ?? [];

      // Find the VMG angle: first TWA in the axis where the row has BSP > 0
      const vmgIdx = speedRow.findIndex((s) => s > 0);
      const startTwa = vmgIdx >= 0 ? Math.ceil(twaAxis[vmgIdx] ?? 0) : 1;

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;

      let started = false;
      for (let deg = startTwa; deg <= 180; deg++) {
        const speed = interpolateRowSpeed(twaAxis, speedRow, deg);
        if (speed <= 0) continue;
        const pt = polarToCanvas(cx, cy, deg, speed, scale);
        if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
        else ctx.lineTo(pt.x, pt.y);
      }
      if (started) ctx.stroke();

      // Label at 180°
      const endSpeed = interpolateRowSpeed(twaAxis, speedRow, 180);
      if (endSpeed > 0) {
        const lp = polarToCanvas(cx, cy, 180, endSpeed, scale);
        ctx.fillStyle = color;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${twsVal}kt`, lp.x + 4, lp.y);
      }
    });

    // Draw live performance dot
    if (normalizedTwa !== null && stw !== null && normalizedTwa > 0) {
      const pt = polarToCanvas(cx, cy, normalizedTwa, stw, scale);

      let dotColor = '#ffffff';
      if (performance.percentPolar !== null) {
        if (performance.percentPolar >= 100) dotColor = '#00ff88';
        else if (performance.percentPolar >= 90) dotColor = '#ffaa00';
        else dotColor = '#ff4444';
      }

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [polarData, normalizedTwa, stw, performance]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ minHeight: 400 }}
    />
  );
}
