import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import type { TimeSeriesPoint, DetectedSegment, SailTag } from '../../types/analysis';

const METRIC_CONFIGS: { key: string; label: string; unit: string; color: string }[] = [
  { key: 'tws', label: 'TWS', unit: 'kts', color: '#00d4ff' },
  { key: 'twa', label: 'TWA', unit: '°', color: '#00ff88' },
  { key: 'stw', label: 'STW', unit: 'kts', color: '#ffaa00' },
  { key: 'aws', label: 'AWS', unit: 'kts', color: '#aa66ff' },
  { key: 'awa', label: 'AWA', unit: '°', color: '#ff66aa' },
  { key: 'heading', label: 'HDG', unit: '°', color: '#66aaff' },
  { key: 'sog', label: 'SOG', unit: 'kts', color: '#ff8844' },
  { key: 'cog', label: 'COG', unit: '°', color: '#88ff44' },
];

const STRIP_HEIGHT = 80;
const OVERVIEW_HEIGHT = 40;
const SAIL_BAR_HEIGHT = 24;
const LEFT_MARGIN = 48;
const RIGHT_MARGIN = 16;
const SEGMENT_COLOR = 'rgba(0, 212, 255, 0.15)';
const SEGMENT_BORDER = 'rgba(0, 212, 255, 0.4)';

function formatElapsed(ms: number, startMs: number): string {
  const s = Math.floor((ms - startMs) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

interface StripChartsProps {
  segments: DetectedSegment[];
  sailTags: SailTag[];
  onCursorTime?: (time: number | null) => void;
}

const SAIL_COLORS = ['#00d4ff', '#00ff88', '#ffaa00', '#ff4444', '#aa66ff', '#ff66aa', '#66aaff', '#ff8844'];

export default function StripCharts({ segments, sailTags, onCursorTime }: StripChartsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overviewRef = useRef<HTMLCanvasElement>(null);
  const metrics = useAnalysisStore((s) => s.metrics);
  const timeRange = useAnalysisStore((s) => s.timeRange);
  const viewStart = useAnalysisStore((s) => s.viewStart);
  const viewEnd = useAnalysisStore((s) => s.viewEnd);
  const setViewRange = useAnalysisStore((s) => s.setViewRange);
  const [visibleMetrics, setVisibleMetrics] = useState<Set<string>>(
    new Set(METRIC_CONFIGS.map((m) => m.key)),
  );
  const [cursorX, setCursorX] = useState<number | null>(null);

  const visibleConfigs = METRIC_CONFIGS.filter((m) => visibleMetrics.has(m.key));
  const totalHeight = visibleConfigs.length * STRIP_HEIGHT + SAIL_BAR_HEIGHT;

  const toggleMetric = (key: string) => {
    setVisibleMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Main chart rendering
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !metrics || !timeRange || viewStart == null || viewEnd == null) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = totalHeight * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const chartWidth = w - LEFT_MARGIN - RIGHT_MARGIN;

    ctx.clearRect(0, 0, w, totalHeight);

    const timeToX = (t: number) =>
      LEFT_MARGIN + ((t - viewStart) / (viewEnd - viewStart)) * chartWidth;

    // Draw each metric strip
    visibleConfigs.forEach((config, stripIdx) => {
      const y0 = stripIdx * STRIP_HEIGHT;
      const y1 = y0 + STRIP_HEIGHT;
      const series = (metrics as any)[config.key] as TimeSeriesPoint[];
      if (!series) return;

      // Background
      ctx.fillStyle = stripIdx % 2 === 0 ? '#0d0d0d' : '#111111';
      ctx.fillRect(0, y0, w, STRIP_HEIGHT);

      // Segment overlays
      for (const seg of segments) {
        if (seg.excluded) continue;
        const st = new Date(seg.startTime).getTime();
        const et = new Date(seg.endTime).getTime();
        if (et < viewStart || st > viewEnd) continue;
        const sx = Math.max(timeToX(st), LEFT_MARGIN);
        const ex = Math.min(timeToX(et), w - RIGHT_MARGIN);
        ctx.fillStyle = SEGMENT_COLOR;
        ctx.fillRect(sx, y0, ex - sx, STRIP_HEIGHT);
        ctx.strokeStyle = SEGMENT_BORDER;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(sx, y0, ex - sx, STRIP_HEIGHT);
      }

      // Find value range for scaling
      let minVal = Infinity, maxVal = -Infinity;
      for (const p of series) {
        if (p.time < viewStart || p.time > viewEnd) continue;
        if (p.value != null) {
          if (p.value < minVal) minVal = p.value;
          if (p.value > maxVal) maxVal = p.value;
        }
      }
      if (minVal === Infinity) return;

      const padding = (maxVal - minVal) * 0.1 || 1;
      minVal -= padding;
      maxVal += padding;

      const valToY = (v: number) =>
        y0 + STRIP_HEIGHT - 12 - ((v - minVal) / (maxVal - minVal)) * (STRIP_HEIGHT - 20);

      // Draw line
      ctx.beginPath();
      ctx.strokeStyle = config.color;
      ctx.lineWidth = 1.5;
      let drawing = false;

      for (const p of series) {
        if (p.time < viewStart || p.time > viewEnd) continue;
        const px = timeToX(p.time);
        if (p.value == null) {
          drawing = false;
          continue;
        }
        const py = valToY(p.value);
        if (!drawing) { ctx.moveTo(px, py); drawing = true; }
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Y-axis label
      ctx.fillStyle = config.color;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`${config.label} (${config.unit})`, LEFT_MARGIN - 4, y0 + 2);

      // Min/max labels
      ctx.fillStyle = '#555';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(maxVal.toFixed(1), LEFT_MARGIN - 4, y0 + 14);
      ctx.textBaseline = 'bottom';
      ctx.fillText(minVal.toFixed(1), LEFT_MARGIN - 4, y1 - 2);
    });

    // Sail tag bar
    const sailY = visibleConfigs.length * STRIP_HEIGHT;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, sailY, w, SAIL_BAR_HEIGHT);

    const uniqueSails = [...new Set(sailTags.map((t) => t.sailConfig))];
    for (const tag of sailTags) {
      const st = new Date(tag.startTime).getTime();
      const et = new Date(tag.endTime).getTime();
      if (et < viewStart || st > viewEnd) continue;
      const sx = Math.max(timeToX(st), LEFT_MARGIN);
      const ex = Math.min(timeToX(et), w - RIGHT_MARGIN);
      const colorIdx = uniqueSails.indexOf(tag.sailConfig);
      ctx.fillStyle = SAIL_COLORS[colorIdx % SAIL_COLORS.length] + '40';
      ctx.fillRect(sx, sailY + 2, ex - sx, SAIL_BAR_HEIGHT - 4);
      ctx.strokeStyle = SAIL_COLORS[colorIdx % SAIL_COLORS.length];
      ctx.lineWidth = 1;
      ctx.strokeRect(sx, sailY + 2, ex - sx, SAIL_BAR_HEIGHT - 4);

      // Label if wide enough
      if (ex - sx > 40) {
        ctx.fillStyle = '#fff';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag.sailConfig, (sx + ex) / 2, sailY + SAIL_BAR_HEIGHT / 2);
      }
    }

    // Time axis ticks
    const timeSpan = viewEnd - viewStart;
    let tickInterval = 60000; // 1 minute
    if (timeSpan > 3600000) tickInterval = 600000; // 10 min
    else if (timeSpan > 600000) tickInterval = 120000; // 2 min
    else if (timeSpan < 60000) tickInterval = 10000; // 10 sec

    const firstTick = Math.ceil(viewStart / tickInterval) * tickInterval;
    ctx.fillStyle = '#444';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    for (let t = firstTick; t <= viewEnd; t += tickInterval) {
      const x = timeToX(t);
      ctx.fillText(formatElapsed(t, timeRange.start), x, totalHeight + 12);
    }

    // Cursor line
    if (cursorX != null && cursorX >= LEFT_MARGIN && cursorX <= w - RIGHT_MARGIN) {
      ctx.strokeStyle = '#ffffff40';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(cursorX, 0);
      ctx.lineTo(cursorX, totalHeight);
      ctx.stroke();
      ctx.setLineDash([]);

      // Value readout at cursor
      const cursorTime = viewStart + ((cursorX - LEFT_MARGIN) / chartWidth) * (viewEnd - viewStart);
      ctx.fillStyle = '#888';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(formatElapsed(cursorTime, timeRange.start), cursorX + 4, 10);

      // Per-strip values
      visibleConfigs.forEach((config, stripIdx) => {
        const series = (metrics as any)[config.key] as TimeSeriesPoint[];
        if (!series) return;
        // Find nearest point
        let nearest: TimeSeriesPoint | null = null;
        let bestDist = Infinity;
        for (const p of series) {
          const d = Math.abs(p.time - cursorTime);
          if (d < bestDist && d < 2000) { bestDist = d; nearest = p; }
        }
        if (nearest?.value != null) {
          const y0 = stripIdx * STRIP_HEIGHT;
          ctx.fillStyle = config.color;
          ctx.textAlign = 'left';
          ctx.fillText(nearest.value.toFixed(1), cursorX + 4, y0 + 14);
        }
      });
    }
  }, [metrics, timeRange, viewStart, viewEnd, visibleConfigs, segments, sailTags, cursorX, totalHeight]);

  // Overview bar rendering
  const drawOverview = useCallback(() => {
    const canvas = overviewRef.current;
    if (!canvas || !metrics || !timeRange) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = OVERVIEW_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    ctx.clearRect(0, 0, w, OVERVIEW_HEIGHT);
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, w, OVERVIEW_HEIGHT);

    const { start, end } = timeRange;
    const duration = end - start;
    if (duration <= 0) return;

    // Draw TWS mini-line
    const tws = metrics.tws;
    if (tws.length > 0) {
      let min = Infinity, max = -Infinity;
      for (const p of tws) {
        if (p.value != null) {
          if (p.value < min) min = p.value;
          if (p.value > max) max = p.value;
        }
      }
      if (min !== Infinity) {
        const range = max - min || 1;
        ctx.beginPath();
        ctx.strokeStyle = '#00d4ff40';
        ctx.lineWidth = 1;
        let started = false;
        for (const p of tws) {
          const x = ((p.time - start) / duration) * w;
          if (p.value == null) { started = false; continue; }
          const y = OVERVIEW_HEIGHT - 4 - ((p.value - min) / range) * (OVERVIEW_HEIGHT - 8);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // Viewport rectangle
    if (viewStart != null && viewEnd != null) {
      const vx0 = ((viewStart - start) / duration) * w;
      const vx1 = ((viewEnd - start) / duration) * w;
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(vx0, 0, vx1 - vx0, OVERVIEW_HEIGHT);
      ctx.strokeStyle = '#ffffff40';
      ctx.lineWidth = 1;
      ctx.strokeRect(vx0, 0, vx1 - vx0, OVERVIEW_HEIGHT);
    }
  }, [metrics, timeRange, viewStart, viewEnd]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => { drawOverview(); }, [drawOverview]);

  // Mouse interaction: zoom, pan, cursor
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!timeRange || viewStart == null || viewEnd == null) return;
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const chartWidth = rect.width - LEFT_MARGIN - RIGHT_MARGIN;
    const mouseX = e.clientX - rect.left;
    const frac = Math.max(0, Math.min(1, (mouseX - LEFT_MARGIN) / chartWidth));
    const span = viewEnd - viewStart;
    const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;
    const newSpan = Math.max(10000, Math.min(timeRange.end - timeRange.start, span * zoomFactor));

    const pivot = viewStart + frac * span;
    let newStart = pivot - frac * newSpan;
    let newEnd = pivot + (1 - frac) * newSpan;

    // Clamp
    if (newStart < timeRange.start) { newStart = timeRange.start; newEnd = newStart + newSpan; }
    if (newEnd > timeRange.end) { newEnd = timeRange.end; newStart = newEnd - newSpan; }

    setViewRange(Math.max(newStart, timeRange.start), Math.min(newEnd, timeRange.end));
  }, [timeRange, viewStart, viewEnd, setViewRange]);

  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; viewStart: number; viewEnd: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (viewStart == null || viewEnd == null) return;
    setDragging(true);
    dragStartRef.current = { x: e.clientX, viewStart, viewEnd };
  }, [viewStart, viewEnd]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect) setCursorX(e.clientX - rect.left);

    if (dragging && dragStartRef.current && timeRange) {
      const dx = e.clientX - dragStartRef.current.x;
      const chartWidth = (rect?.width || 800) - LEFT_MARGIN - RIGHT_MARGIN;
      const span = dragStartRef.current.viewEnd - dragStartRef.current.viewStart;
      const timeDelta = -(dx / chartWidth) * span;

      let newStart = dragStartRef.current.viewStart + timeDelta;
      let newEnd = dragStartRef.current.viewEnd + timeDelta;
      if (newStart < timeRange.start) { newStart = timeRange.start; newEnd = newStart + span; }
      if (newEnd > timeRange.end) { newEnd = timeRange.end; newStart = newEnd - span; }
      setViewRange(newStart, newEnd);
    }

    // Notify parent of cursor time
    if (rect && viewStart != null && viewEnd != null && onCursorTime) {
      const chartWidth = rect.width - LEFT_MARGIN - RIGHT_MARGIN;
      const mouseX = e.clientX - rect.left;
      const frac = (mouseX - LEFT_MARGIN) / chartWidth;
      if (frac >= 0 && frac <= 1) {
        onCursorTime(viewStart + frac * (viewEnd - viewStart));
      }
    }
  }, [dragging, timeRange, viewStart, viewEnd, setViewRange, onCursorTime]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
    dragStartRef.current = null;
  }, []);

  const handleMouseLeave = useCallback(() => {
    setCursorX(null);
    setDragging(false);
    dragStartRef.current = null;
    if (onCursorTime) onCursorTime(null);
  }, [onCursorTime]);

  // Overview bar click to pan
  const handleOverviewClick = useCallback((e: React.MouseEvent) => {
    if (!timeRange || viewStart == null || viewEnd == null) return;
    const rect = overviewRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const clickTime = timeRange.start + frac * (timeRange.end - timeRange.start);
    const span = viewEnd - viewStart;
    let newStart = clickTime - span / 2;
    let newEnd = clickTime + span / 2;
    if (newStart < timeRange.start) { newStart = timeRange.start; newEnd = newStart + span; }
    if (newEnd > timeRange.end) { newEnd = timeRange.end; newStart = newEnd - span; }
    setViewRange(newStart, newEnd);
  }, [timeRange, viewStart, viewEnd, setViewRange]);

  if (!metrics || !timeRange) {
    return <div className="text-gray-500 text-sm">No data loaded</div>;
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Metric visibility toggles */}
      <div className="flex gap-2 flex-wrap mb-1">
        {METRIC_CONFIGS.map((m) => (
          <label key={m.key} className="flex items-center gap-1 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={visibleMetrics.has(m.key)}
              onChange={() => toggleMetric(m.key)}
              className="accent-cyan-400"
            />
            <span style={{ color: m.color }}>{m.label}</span>
          </label>
        ))}
      </div>

      {/* Main strip charts */}
      <canvas
        ref={canvasRef}
        className="w-full cursor-crosshair"
        style={{ height: totalHeight + 16 }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />

      {/* Overview bar */}
      <canvas
        ref={overviewRef}
        className="w-full cursor-pointer"
        style={{ height: OVERVIEW_HEIGHT }}
        onClick={handleOverviewClick}
      />
    </div>
  );
}
