import React, { useRef, useEffect } from 'react';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { usePolarStore } from '../../store/usePolarStore';
import type { PolarData } from '../../types/polar';
import type { DetectedSegment } from '../../types/analysis';

const POLAR_COLORS = ['#00d4ff', '#00ff88', '#ffaa00', '#ff4444', '#aa66ff', '#ff66aa'];

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function polarToCanvas(cx: number, cy: number, twa: number, speed: number, scale: number) {
  const rad = degToRad(twa);
  return {
    x: cx + speed * scale * Math.sin(rad),
    y: cy - speed * scale * Math.cos(rad),
  };
}

function dotColor(percentPolar: number | null): string {
  if (percentPolar == null) return '#ffffff';
  if (percentPolar >= 100) return '#00ff88';
  if (percentPolar >= 90) return '#ffaa00';
  return '#ff4444';
}

function dotRadius(durationS: number): number {
  // Scale from 3px (60s) to 8px (600s+)
  return Math.min(8, Math.max(3, 3 + (durationS - 60) / 100));
}

export default function PolarOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const polarData = usePolarStore((s) => s.polarData);
  const segments = useAnalysisStore((s) => s.segments);
  const sailFilter = useAnalysisStore((s) => s.sailFilter);
  const twsFilter = useAnalysisStore((s) => s.twsFilter);
  const setSailFilter = useAnalysisStore((s) => s.setSailFilter);
  const setTwsFilter = useAnalysisStore((s) => s.setTwsFilter);

  // Get unique sail configs from segments
  const sailConfigs = [...new Set(segments.filter((s) => s.sailConfig).map((s) => s.sailConfig!))];

  // Filter segments
  const filteredSegments = segments.filter((seg) => {
    if (seg.excluded) return false;
    if (sailFilter && seg.sailConfig !== sailFilter) return false;
    if (twsFilter && (seg.meanTws < twsFilter[0] || seg.meanTws >= twsFilter[1])) return false;
    return true;
  });

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
    // Also consider segment STW values
    for (const seg of filteredSegments) {
      if (seg.meanStw > maxSpeed) maxSpeed = seg.meanStw;
    }
    if (maxSpeed === 0) return;
    const scale = maxRadius / maxSpeed;

    // Draw grid circles
    const gridStep = maxSpeed <= 8 ? 2 : maxSpeed <= 16 ? 4 : 5;
    for (let spd = gridStep; spd <= maxSpeed + gridStep; spd += gridStep) {
      const r = spd * scale;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${spd} kts`, cx + r + 4, cy + 3);
    }

    // Draw TWA angle lines
    for (let angle = 0; angle <= 180; angle += 30) {
      const pt = polarToCanvas(cx, cy, angle, maxSpeed * 1.1, scale);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(pt.x, pt.y);
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      const labelPt = polarToCanvas(cx, cy, angle, maxSpeed * 1.18, scale);
      ctx.fillStyle = '#555';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${angle}°`, labelPt.x, labelPt.y);
    }

    // Wind arrow
    ctx.fillStyle = '#444';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('WIND', cx, cy - maxRadius * 1.1 - 4);
    const arrowY = cy - maxRadius * 1.1;
    ctx.beginPath();
    ctx.moveTo(cx, arrowY);
    ctx.lineTo(cx - 5, arrowY - 10);
    ctx.lineTo(cx + 5, arrowY - 10);
    ctx.closePath();
    ctx.fillStyle = '#444';
    ctx.fill();

    // Draw polar curves
    polarData.tws.forEach((twsVal, twsIdx) => {
      const color = POLAR_COLORS[twsIdx % POLAR_COLORS.length];
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;

      for (let twaIdx = 0; twaIdx < polarData.twa.length; twaIdx++) {
        const speed = polarData.speeds[twsIdx]?.[twaIdx] ?? 0;
        const pt = polarToCanvas(cx, cy, polarData.twa[twaIdx], speed, scale);
        if (twaIdx === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();

      const lastIdx = polarData.twa.length - 1;
      const lastSpeed = polarData.speeds[twsIdx]?.[lastIdx] ?? 0;
      const lp = polarToCanvas(cx, cy, polarData.twa[lastIdx], lastSpeed, scale);
      ctx.fillStyle = color;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${twsVal}kt`, lp.x + 4, lp.y);
    });

    // Draw measured data points
    for (const seg of filteredSegments) {
      const pt = polarToCanvas(cx, cy, seg.meanTwa, seg.meanStw, scale);
      const r = dotRadius(seg.durationS);

      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = dotColor(seg.percentPolar);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }, [polarData, filteredSegments]);

  const twsBands: [number, number][] = [[6, 8], [8, 10], [10, 12], [12, 16], [16, 20]];

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Filters */}
      <div className="flex gap-3 items-center flex-wrap">
        <label className="text-xs text-gray-400 flex items-center gap-1">
          Sail:
          <select
            value={sailFilter || ''}
            onChange={(e) => setSailFilter(e.target.value || null)}
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-0.5 text-xs text-white"
          >
            <option value="">All sails</option>
            {sailConfigs.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-400 flex items-center gap-1">
          TWS:
          <select
            value={twsFilter ? `${twsFilter[0]}-${twsFilter[1]}` : ''}
            onChange={(e) => {
              if (!e.target.value) { setTwsFilter(null); return; }
              const [lo, hi] = e.target.value.split('-').map(Number);
              setTwsFilter([lo, hi]);
            }}
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-0.5 text-xs text-white"
          >
            <option value="">All TWS</option>
            {twsBands.map(([lo, hi]) => (
              <option key={`${lo}-${hi}`} value={`${lo}-${hi}`}>{lo}–{hi} kts</option>
            ))}
          </select>
        </label>
        <span className="text-xs text-gray-500 ml-auto">
          {filteredSegments.length} data points
        </span>
      </div>

      {/* Polar chart */}
      <div className="flex-1 min-h-0">
        <canvas ref={canvasRef} className="w-full h-full" style={{ minHeight: 350 }} />
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-xs text-gray-400">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-n2k-success inline-block" /> ≥100%
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-n2k-warning inline-block" /> 90–99%
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-n2k-danger inline-block" /> &lt;90%
        </span>
      </div>
    </div>
  );
}
