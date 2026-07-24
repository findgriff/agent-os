// Memory Galaxy — full-screen interactive 3D showpiece. Every star is a memory.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store';
import { api } from '../lib/api';
import type { GalaxyStar } from '../lib/types';
import { Galaxy, CONSTELLATION_COLOUR } from '../components/Galaxy';
import { Badge, Button, EmptyState, Icon } from '../components/ui';
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
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<GalaxyStar | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const hoverRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const res = await api.galaxy(selectedTenant ?? undefined);
        if (!alive) return;
        setStars(res.memories || []);
        setConstellations(res.constellations || []);
        setCount(res.count ?? (res.memories || []).length);
      } catch {
        if (!alive) return;
        setError(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [selectedTenant, reloadKey]);

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

  // Per-constellation star counts for the legend.
  const legendCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    stars.forEach(s => { counts[s.constellation] = (counts[s.constellation] || 0) + 1; });
    return counts;
  }, [stars]);

  return (
    <div className="relative w-full h-[calc(100vh-4rem)] bg-bg overflow-hidden">
      {/* Deep-space backdrop behind the canvas */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_65%_55%_at_50%_38%,rgba(23,49,94,0.35),transparent_72%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_40%_32%_at_62%_30%,rgba(92,61,168,0.16),transparent_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_36%_28%_at_36%_52%,rgba(20,90,110,0.14),transparent_70%)]" />
      </div>
      {loading ? (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-5 animate-fadeInUp">
            {/* Orbital loader — two motes circling the sigil */}
            <div className="relative grid h-24 w-24 place-items-center">
              <div className="absolute inset-0 rounded-full border border-accent/15" />
              <div className="absolute inset-3 rounded-full border border-violet/15" />
              <Logo size={40} showText={false} />
              <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 animate-orbit rounded-full bg-accent shadow-[0_0_10px_2px_rgba(25,195,230,0.7)]" />
              <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 animate-orbit rounded-full bg-violet shadow-[0_0_8px_2px_rgba(167,139,250,0.7)]"
                style={{ animationDuration: '3.4s', animationDirection: 'reverse' }} />
            </div>
            <div className="font-display text-sm tracking-wide text-muted">Mapping the galaxy…</div>
          </div>
        </div>
      ) : error ? (
        <div className="absolute inset-0 grid place-items-center px-4">
          <EmptyState
            icon="cloud_off"
            title="Couldn't load the galaxy"
            hint="Something went wrong reaching the server."
            action={<Button icon="refresh" onClick={() => setReloadKey(k => k + 1)}>Retry</Button>}
          />
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
            selectedId={selected?.id ?? null}
            onMemoryClick={setSelected}
            onHover={handleHover}
          />

          {/* Cinematic vignette above the canvas, below the UI */}
          <div className="pointer-events-none absolute inset-0 z-[5] bg-[radial-gradient(ellipse_at_center,transparent_52%,rgba(2,4,9,0.6)_100%)]" />

          {/* Top-left title overlay */}
          <div className="pointer-events-none absolute left-5 top-5 z-10 max-w-xs animate-fadeInUp">
            <h1 className="animate-textShimmer bg-gradient-to-r from-ink via-accent to-violet bg-clip-text bg-[length:200%_auto] font-display text-3xl font-bold tracking-tight text-transparent drop-shadow-[0_2px_16px_rgba(0,0,0,0.7)]">
              Memory Galaxy
            </h1>
            <p className="mt-1.5 text-sm text-muted">
              Each star is a memory. Brighter = higher confidence.
            </p>
            <div className="mt-2.5 flex items-center gap-2 font-mono text-xs text-muted/80">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
              </span>
              {count} memories · {constellations.length} constellations
            </div>
          </div>

          {/* Top-right filter chips */}
          <div className="absolute right-4 top-5 z-10 flex flex-wrap justify-end gap-2 max-w-[60%]">
            <AmbientToggle playing={playing} onToggle={toggleAmbient} />
            {FILTERS.map((f, i) => {
              const active = filter === f;
              const c = f === 'all' ? '#19C3E6' : dotColour(f);
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-all active:scale-95 animate-fadeInUp
                    ${active ? 'glass-raised text-ink' : 'glass border-white/10 text-muted hover:border-white/25 hover:text-ink'}`}
                  style={{
                    animationDelay: `${i * 45}ms`,
                    ...(active ? { borderColor: `${c}66`, boxShadow: `0 0 18px -2px ${c}55, inset 0 0 12px -6px ${c}44` } : {}),
                  }}
                >
                  <span
                    className="h-2 w-2 rounded-full transition-shadow"
                    style={{ background: c, boxShadow: active ? `0 0 8px ${c}` : undefined }}
                  />
                  {cap(f)}
                </button>
              );
            })}
          </div>

          {/* Legend (bottom-left) — rows double as filters */}
          <div className="absolute bottom-5 left-5 z-10 hidden sm:block animate-fadeInUp">
            <div className="glass rounded-2xl px-2 py-2.5 backdrop-blur-xl">
              <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
                Constellations
              </div>
              <div className="flex flex-col gap-0.5">
                {legend.map(k => {
                  const active = filter === k;
                  const c = dotColour(k);
                  return (
                    <button key={k} onClick={() => setFilter(active ? 'all' : k)}
                      className={`flex items-center gap-2 rounded-lg px-2 py-1 text-left text-xs transition-all
                        ${active ? 'bg-white/8 text-ink' : 'text-muted hover:bg-white/5 hover:text-ink'}`}>
                      <span className="h-2 w-2 rounded-full transition-shadow"
                        style={{ background: c, boxShadow: active ? `0 0 8px ${c}` : `0 0 4px ${c}66` }} />
                      <span className="flex-1">{cap(k)}</span>
                      <span className="pl-3 font-mono text-[10px] text-muted/60">{legendCounts[k] || 0}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Bottom-right hint */}
          <div className="pointer-events-none absolute bottom-5 right-5 z-10 hidden md:flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-muted/50 animate-fadeInUp">
            <span className="flex items-center gap-1.5"><Icon name="drag_pan" size={13} /> drag to orbit</span>
            <span className="flex items-center gap-1.5"><Icon name="mouse" size={13} /> scroll to zoom</span>
          </div>

          {/* Hover tooltip */}
          {hover && (
            <div
              className="pointer-events-none fixed z-30 max-w-[250px] glass-raised rounded-xl px-3 py-2 text-xs text-ink animate-[fadeInUp_0.15s_ease-out]"
              style={{
                left: hover.x + 14, top: hover.y + 14,
                borderColor: `${dotColour(hover.m.constellation)}44`,
                boxShadow: `0 12px 40px -8px rgba(0,0,0,0.8), 0 0 24px -6px ${dotColour(hover.m.constellation)}33`,
              }}
            >
              <div className="mb-0.5 flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: dotColour(hover.m.constellation), boxShadow: `0 0 6px ${dotColour(hover.m.constellation)}` }}
                />
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                  {cap(hover.m.constellation)}
                </span>
                <span className="ml-auto font-mono text-[10px] text-muted/60">
                  {Math.round(hover.m.confidence * 100)}%
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
              <div className="absolute bottom-0 left-0 right-0 z-20 px-3 pb-3 animate-springUp"
                onClick={e => e.stopPropagation()}>
                <div className="relative mx-auto max-w-4xl">
                  {/* constellation-coloured glow bleeding out from behind the panel */}
                  <div className="pointer-events-none absolute -inset-4 -z-10 rounded-[2rem] blur-2xl"
                    style={{ background: `radial-gradient(ellipse at 50% 100%, ${dotColour(selected.constellation)}2e, transparent 70%)` }} />
                  <div className="glass-raised relative overflow-hidden rounded-2xl p-5 shadow-2xl"
                    style={{ borderColor: `${dotColour(selected.constellation)}33` }}>
                    {/* hairline in the constellation colour along the top edge */}
                    <div className="pointer-events-none absolute inset-x-10 top-0 h-px"
                      style={{ background: `linear-gradient(90deg, transparent, ${dotColour(selected.constellation)}, transparent)` }} />
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
                          <div key={selected.id} className="h-full origin-left animate-growBar rounded-full"
                            style={{ width: `${Math.round(selected.confidence * 100)}%`,
                              background: `linear-gradient(90deg, ${dotColour(selected.constellation)}, #19C3E6)`,
                              boxShadow: `0 0 12px ${dotColour(selected.constellation)}66` }} />
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
                              className="group flex items-center gap-2 rounded-lg border border-white/8 bg-white/4 px-2.5 py-1.5 text-left text-xs text-muted transition-all hover:translate-x-0.5 hover:border-accent/40 hover:bg-white/8 hover:text-ink">
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full transition-shadow group-hover:shadow-[0_0_6px_currentColor]"
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
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
