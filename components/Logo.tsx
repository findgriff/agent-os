// AGENT OS wordmark — a glowing hex sigil + type. Pure SVG, no asset.
// `draw` plays the trace-on entrance (hex draws, ring follows, core pops).
export function Logo({ size = 34, showText = true, className = '', draw = false }:
  { size?: number; showText?: boolean; className?: string; draw?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none"
        className={draw ? 'logo-draw' : undefined}>
        <defs>
          <linearGradient id="lg-a" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#19C3E6" />
            <stop offset="100%" stopColor="#A78BFA" />
          </linearGradient>
        </defs>
        <path d="M24 3 L42 13.5 V34.5 L24 45 L6 34.5 V13.5 Z" stroke="url(#lg-a)"
          strokeWidth="2" fill="rgba(25,195,230,0.06)" />
        <circle cx="24" cy="24" r="6.5" fill="url(#lg-a)" />
        <circle cx="24" cy="24" r="11" stroke="#19C3E6" strokeWidth="1" opacity="0.5" />
      </svg>
      {showText && (
        <div className="leading-none">
          <div className="font-display text-[15px] font-bold tracking-wide text-ink">AGENT OS</div>
          <div className="text-[9px] uppercase tracking-[0.25em] text-muted">command centre</div>
        </div>
      )}
    </div>
  );
}
