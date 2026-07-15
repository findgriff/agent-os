// Inline SVG sparkline. Renders a smooth polyline + soft gradient fill.
export function Sparkline({ data, colour = '#19C3E6', height = 32, width = 120, showAxis = false }:
  { data: number[]; colour?: string; height?: number; width?: number; showAxis?: boolean }) {
  if (!data.length) return <svg width={width} height={height} />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = width / Math.max(1, data.length - 1);
  const pts = data.map((v, i) => [i * step, height - ((v - min) / range) * (height - 4) - 2]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const id = `sg-${colour.replace('#', '')}`;
  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity="0.35" />
          <stop offset="100%" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>
      {showAxis && <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="rgba(255,255,255,0.08)" />}
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={colour} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      {pts.length > 0 && (
        <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.4" fill={colour} />
      )}
    </svg>
  );
}
