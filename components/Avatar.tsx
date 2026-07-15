// Coloured circle with initials. glow adds an on-colour halo.
export function Avatar({ colour = '#19C3E6', initials, size = 42, glow, ring = true, status }:
  { colour?: string; initials?: string; size?: number; glow?: boolean; ring?: boolean;
    status?: 'idle' | 'running' | 'flagged' | 'error' }) {
  const statusColour: Record<string, string> = {
    idle: '#7B8DA8', running: '#19C3E6', flagged: '#F59E0B', error: '#F43F5E',
  };
  return (
    <span className="relative inline-grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{
        width: size, height: size, fontSize: size * 0.36,
        background: `linear-gradient(145deg, ${colour}, ${colour}bb)`,
        boxShadow: glow ? `0 0 14px ${colour}88, inset 0 0 0 1px ${colour}` : undefined,
        outline: ring ? `1px solid rgba(255,255,255,0.14)` : undefined,
      }}>
      {(initials || '··').slice(0, 2)}
      {status && (
        <span className="absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-[#0D1520]"
          style={{ width: size * 0.28, height: size * 0.28, background: statusColour[status],
            boxShadow: status === 'running' ? `0 0 8px ${statusColour[status]}` : undefined }} />
      )}
    </span>
  );
}
