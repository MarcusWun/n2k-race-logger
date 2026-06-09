import React, { useRef, useEffect } from 'react';
import type { PolarData } from '../../types/polar';
import { usePolarStore } from '../../store/usePolarStore';
import { useN2KStore } from '../../store/useN2KStore';

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

export default function PolarDiagram({ polarData }: PolarDiagramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const performance = usePolarStore((s) => s.performance);
  const twa = useN2KStore((s) => s.twa);
  const stw = useN2KStore((s) => s.stw);

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

    // Draw polar curves for each TWS
    polarData.tws.forEach((twsVal, twsIdx) => {
      const color = COLORS[twsIdx % COLORS.length];
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;

      for (let twaIdx = 0; twaIdx < polarData.twa.length; twaIdx++) {
        const speed = polarData.speeds[twsIdx]?.[twaIdx] ?? 0;
        const pt = polarToCanvas(cx, cy, polarData.twa[twaIdx], speed, scale);

        if (twaIdx === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();

      // Label at the end of each curve
      const lastIdx = polarData.twa.length - 1;
      const lastSpeed = polarData.speeds[twsIdx]?.[lastIdx] ?? 0;
      const lp = polarToCanvas(cx, cy, polarData.twa[lastIdx], lastSpeed, scale);
      ctx.fillStyle = color;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${twsVal}kt`, lp.x + 4, lp.y);
    });

    // Draw live performance dot
    if (twa !== null && stw !== null && twa > 0) {
      const pt = polarToCanvas(cx, cy, twa, stw, scale);

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
  }, [polarData, twa, stw, performance]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ minHeight: 400 }}
    />
  );
}
