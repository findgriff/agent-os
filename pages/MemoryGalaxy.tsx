// Memory Galaxy — full-screen interactive 3D showpiece. Every star is a memory.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store';
import { api } from '../lib/api';
import type { GalaxyStar } from '../lib/types';
import { Galaxy, CONSTELLATION_COLOUR } from '../components/Galaxy';
import { Badge, EmptyState, Icon } from '../components/ui';
import { Logo } from '../components/Logo';
import { useSpaceAmbient, AmbientToggle } from '../components/SpaceAmbient';

const FILTERS = ['all', 'customer', 'property', 'crew', 'policy', 'general'] as const;
const cap = (s: string) => (s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1));
const dotColour = (key: string) => CONSTELLATION_COLOUR[key] || '#E8EDF5';

const fmtDate = (ts?: number | null) => {
  if (!ts) return 'unknown';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
};

interface Hover { m: GalaxyStar; x: number; y: number }

export default function MemoryGalaxy() {
  const { selectedTenant } = useApp();
  const { playing, toggle: toggleAmbient } = useSpaceAmbient();
  const [stars, setStars] = useState<GalaxyStar[]>([]);
  const [constellations, setConstellations] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<GalaxyStar | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const hoverRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await api.galaxy(selectedTenant ?? undefined);
        if (!alive) return;
        setStars(res.memories || []);
        setConstellations(res.constellations || []);
        setCount(res.count ?? (res.memories || []).length);
      } catch {
        if (!alive) return;
        setStars([]);
        setConstellations([]);
        setCount(0);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [selectedTenant]);

  // Reset selection/hover when the data set changes.
  useEffect(() => { setSelected(null); setHover(null); }, [selectedTenant]);

  // ESC closes the detail panel.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // Resolve a star's wikilink edges to the memories they point at.
  const starById = useMemo(() => {
    const map = new Map<number, GalaxyStar>();
    stars.forEach(s => map.set(s.id, s));
    return map;
  }, [stars]);
  const related = useMemo(() =>
    (selected?.connected_to || [])
      .map(id => starById.get(id)).filter((s): s is GalaxyStar => !!s).slice(0, 6),
    [selected, starById]);

  const handleHover = (m: GalaxyStar | null, x: number, y: number) => {
    if (hoverRef.current) cancelAnimationFrame(hoverRef.current);
    hoverRef.current = requestAnimationFrame(() => {
      setHover(m ? { m, x, y } : null);
    });
  };

  // Legend entries — constellations present in the data, falling back to the map.
  const legend = useMemo(() => {
    const keys = constellations.length
      ? constellations
      : Array.from(new Set(stars.map(s => s.constellation)));
    return keys.filter(k => k in CONSTELLATION_COLOUR).length
      ? keys
      : Object.keys(CONSTELLATION_COLOUR);
  }, [constellations, stars]);

  return (
    <div className="relative w-full h-[calc(100vh-4rem)] bg-bg overflow-hidden">
      {loading ? (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3 animate-pulse">
            <Logo size={44} showText={false} />
            <div className="font-display text-sm text-muted">Mapping the galaxy…</div>
          </div>
        </div>
      ) : count === 0 ? (
        <div className="absolute inset-0 grid place-items-center px-4">
          <EmptyState
            icon="auto_awesome"
            accent="#A78BFA"
            large
            title="Explore the memory galaxy"
            hint="Every memory your agents form becomes a star here. Deploy an agent and let it learn — the galaxy lights up on its own."
          />
        </div>
      ) : (
        <>
          {/* 3D galaxy fills the container */}
          <Galaxy
            memories={stars}
            interactive
            bloom
            filter={filter}
            onMemoryClick={setSelected}
            onHover={handleHover}
          />

          {/* Top-left title overlay */}
          <div className="pointer-events-none absolute left-5 top-5 z-10 max-w-xs animate-fadeInUp">
            <h1 className="font-display text-2xl font-bold text-ink drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]">
              Memory Galaxy
            </h1>
            <p className="mt-1 text-sm text-muted">
              Each star is a memory. Brighter = higher confidence.
            </p>
            <div className="mt-2 text-xs font-mono text-muted/80">
              {count} memories · {constellations.length} constellations
            </div>
          </div>

          {/* Top-right filter chips */}
          <div className="absolute right-4 top-5 z-10 flex flex-wrap justify-end gap-2 max-w-[60%]">
            <AmbientToggle playing={playing} onToggle={toggleAmbient} />
            {FILTERS.map(f => {
              const active = filter === f;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-all active:scale-95
                    ${active
                      ? 'glass-raised border-accent/40 text-ink shadow-[0_0_16px_rgba(25,195,230,0.25)]'
                      : 'glass border-white/10 text-muted hover:text-ink'}`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: f === 'all' ? '#19C3E6' : dotColour(f) }}
                  />
                  {cap(f)}
                </button>
              );
            })}
          </div>

          {/* Legend (bottom-left) */}
          <div className="pointer-events-none absolute bottom-5 left-5 z-10 hidden sm:block animate-fadeInUp">
            <div className="glass rounded-xl px-3 py-2.5">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
                Constellations
              </div>
              <div className="flex flex-col gap-1">
                {legend.map(k => (
                  <div key={k} className="flex items-center gap-2 text-xs text-muted">
                    <span className="h-2 w-2 rounded-full" style={{ background: dotColour(k) }} />
                    {cap(k)}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Hover tooltip */}
          {hover && (
            <div
              className="pointer-events-none fixed z-30 max-w-[240px] glass rounded-lg px-3 py-2 text-xs text-ink shadow-xl"
              style={{ left: hover.x + 14, top: hover.y + 14 }}
            >
              <div className="mb-0.5 flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: dotColour(hover.m.constellation) }}
                />
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                  {cap(hover.m.constellation)}
                </span>
              </div>
              <div className="line-clamp-2 leading-snug">{hover.m.fact}</div>
            </div>
          )}

          {/* Click detail panel — full-width, slides up from the bottom */}
          {selected && (
            <>
              {/* transparent click-catcher: click outside closes */}
              <div className="absolute inset-0 z-10" onClick={() => setSelected(null)} />
              <div className="absolute bottom-0 left-0 right-0 z-20 px-3 pb-3 animate-fadeInUp"
                onClick={e => e.stopPropagation()}>
                <div className="mx-auto max-w-4xl glass-raised rounded-2xl p-5 shadow-2xl">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="info" dot>{cap(selected.constellation)}</Badge>
                      <Badge tone={selected.type === 'collective' ? 'violet' : 'neutral'}>
                        {selected.type === 'collective' ? 'Collective' : 'Personal'}
                      </Badge>
                      {selected.source && (
                        <Badge tone="neutral">via {selected.source}</Badge>
                      )}
                    </div>
                    <button onClick={() => setSelected(null)}
                      className="shrink-0 text-muted transition-colors hover:text-ink"
                      aria-label="Close"><Icon name="close" size={20} /></button>
                  </div>

                  <p className="text-[15px] leading-relaxed text-ink">{selected.fact}</p>

                  <div className="mt-4 grid gap-4 sm:grid-cols-[1.4fr_1fr]">
                    {/* left: confidence bar + meta */}
                    <div className="space-y-3">
                      <div>
                        <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
                          <span>Confidence</span>
                          <span className="font-mono text-ink">{Math.round(selected.confidence * 100)}%</span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-white/8">
                          <div className="h-full rounded-full transition-all"
                            style={{ width: `${Math.round(selected.confidence * 100)}%`,
                              background: `linear-gradient(90deg, ${dotColour(selected.constellation)}, #19C3E6)` }} />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-xs">
                        <span className="flex items-center gap-1.5 text-muted">
                          <Icon name="smart_toy" size={15} />
                          <span className="text-ink">{selected.agent_name}</span>
                        </span>
                        <span className="flex items-center gap-1.5 text-muted">
                          <Icon name="visibility" size={15} />
                          <span className="text-ink">{selected.usage_count}</span> uses
                        </span>
                        <span className="flex items-center gap-1.5 text-muted">
                          <Icon name="calendar_today" size={15} />
                          <span className="text-ink">{fmtDate(selected.created_at)}</span>
                        </span>
                      </div>
                    </div>

                    {/* right: related memories from wikilinks */}
                    <div>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
                        Related {related.length ? `· ${related.length}` : ''}
                      </div>
                      {related.length === 0 ? (
                        <div className="text-xs text-muted/70">No linked memories.</div>
                      ) : (
                        <div className="flex flex-col gap-1.5">
                          {related.map(r => (
                            <button key={r.id} onClick={() => setSelected(r)}
                              className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/4 px-2.5 py-1.5 text-left text-xs text-muted transition-all hover:border-accent/40 hover:text-ink">
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ background: dotColour(r.constellation) }} />
                              <span className="line-clamp-1">{r.fact}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
