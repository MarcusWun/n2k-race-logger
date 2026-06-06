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
    const cx = w / 2;
    const cy = h * 0.05;
    const maxRadius = Math.min(w / 2, h * 0.85) * 0.9;

    ctx.clearRect(0, 0, w, h);

    if (!polarData) {
      ctx.fillStyle = '#666';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No polar data loaded', cx, h / 2);
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

    // Draw grid circles
    const gridSteps = Math.ceil(maxSpeed / 2);
    for (let i = 1; i <= gridSteps; i++) {
      const r = (i * 2) * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI);
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${i * 2}`, cx + r + 8, cy + 4);
    }

    // Draw angle lines
    for (let angle = 0; angle <= 180; angle += 30) {
      const rad = degToRad(angle);
      const x = cx + maxRadius * Math.sin(rad);
      const y = cy + maxRadius * Math.cos(rad);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      ctx.fillStyle = '#555';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${angle}°`, x + (angle < 90 ? 12 : angle > 90 ? -12 : 0), y + 14);
    }

    // Draw polar curves
    polarData.tws.forEach((twsVal, twsIdx) => {
      const color = COLORS[twsIdx % COLORS.length];
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;

      for (let twaIdx = 0; twaIdx < polarData.twa.length; twaIdx++) {
        const speed = polarData.speeds[twsIdx]?.[twaIdx] ?? 0;
        const angle = degToRad(polarData.twa[twaIdx]);
        const r = speed * scale;
        const x = cx + r * Math.sin(angle);
        const y = cy + r * Math.cos(angle);

        if (twaIdx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Label
      const lastTwaIdx = polarData.twa.length - 1;
      const lastSpeed = polarData.speeds[twsIdx]?.[lastTwaIdx] ?? 0;
      const lastAngle = degToRad(polarData.twa[lastTwaIdx]);
      const lx = cx + lastSpeed * scale * Math.sin(lastAngle);
      const ly = cy + lastSpeed * scale * Math.cos(lastAngle);
      ctx.fillStyle = color;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${twsVal}kt`, lx + 4, ly);
    });

    // Draw live performance dot
    if (twa !== null && stw !== null && twa > 0) {
      const angle = degToRad(twa);
      const r = stw * scale;
      const x = cx + r * Math.sin(angle);
      const y = cy + r * Math.cos(angle);

      let dotColor = '#ffffff';
      if (performance.percentPolar !== null) {
        if (performance.percentPolar >= 100) dotColor = '#00ff88';
        else if (performance.percentPolar >= 90) dotColor = '#ffaa00';
        else dotColor = '#ff4444';
      }

      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
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
