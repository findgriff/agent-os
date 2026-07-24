// Dashboard — cross-project overview / HQ landing page.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Button, Badge, Stat, EmptyState, SkeletonList, useToast, useCountUp,
} from '../components/ui';
import { Avatar } from '../components/Avatar';
import { Galaxy } from '../components/Galaxy';
import { Logo } from '../components/Logo';
import { useApp } from '../lib/store';
import { api, timeAgo } from '../lib/api';
import type { Overview, GalaxyStar } from '../lib/types';

// Primary destinations, one card each on the dashboard deck.
// Apollo carries the KITT red accent; everything else is on-brand teal.
const QUICK_ACTIONS = [
  { to: '/agents', icon: 'smart_toy', label: 'Agents', desc: 'Deploy & manage the fleet', accent: '#19C3E6' },
  { to: '/mission-control', icon: 'radar', label: 'Mission Control', desc: 'Live fleet telemetry', accent: '#19C3E6' },
  { to: '/galaxy', icon: 'auto_awesome', label: 'Galaxy', desc: 'Explore agent memories', accent: '#19C3E6' },
  { to: '/apollo', icon: 'mic', label: 'Apollo', desc: 'Voice command console', accent: '#EF4444' },
  { to: '/pipelines', icon: 'account_tree', label: 'Pipelines', desc: 'Automated content flows', accent: '#19C3E6' },
  { to: '/kanban', icon: 'view_kanban', label: 'Kanban', desc: 'Tasks across the board', accent: '#19C3E6' },
];

// Small wrapper so each stat tile gets its own eased count-up.
function CountStat({ label, value, icon, accent, delay }:
  { label: string; value: number; icon: string; accent: string; delay: number }) {
  const n = useCountUp(value);
  return <Stat label={label} value={n.toLocaleString()} icon={icon} accent={accent} delay={delay} />;
}

export default function Dashboard() {
  const { user, setSelectedTenant } = useApp();
  const navigate = useNavigate();
  const toast = useToast();

  const [overview, setOverview] = useState<Overview | null>(null);
  const [stars, setStars] = useState<GalaxyStar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(false);
    try {
      const ov = await api.overview();
      setOverview(ov);
    } catch {
      setOverview(null);
      setError(true);
    }
    try {
      const g = await api.galaxy();
      setStars(g.memories || []);
    } catch {
      setStars([]);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const openProject = (id: number) => {
    setSelectedTenant(id);
    navigate('/mission-control');
  };

  const syncVault = async () => {
    setSyncing(true);
    try {
      const res = await api.vaultSync();
      toast(`Synced ${res.synced} memories`, 'ok');
      load();
    } catch {
      toast('Vault sync failed', 'danger');
    } finally {
      setSyncing(false);
    }
  };

  // Greeting follows the local clock — command centres never say just "hello".
  const hour = new Date().getHours();
  const daypart = hour < 5 ? 'evening' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

  const stats = overview?.stats;
  const projects = overview?.projects || [];
  const activity = overview?.recent_activity || [];
  const isEmpty = !loading && projects.length === 0 && activity.length === 0 && stars.length === 0
    && !(stats && (stats.total_agents || stats.total_memories));

  const QUICK_START = [
    { icon: 'hub', accent: '#22C55E', title: 'Connect a platform', desc: 'Bring an external tool into AGENT OS as a live integration.', to: '/integrations' },
    { icon: 'smart_toy', accent: '#38BDF8', title: 'Deploy an agent', desc: 'Provision an agent to work inside a connected project.', to: '/agents' },
    { icon: 'radar', accent: '#F59E0B', title: 'Watch Mission Control', desc: 'Track live fleet telemetry as agents start running.', to: '/mission-control' },
  ];

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* 1 ── Welcome banner ─────────────────────────────────────────── */}
      <Card className="relative overflow-hidden glass-raised p-6 animate-[fadeInUp_0.5s_ease-out_both,breathe_4s_ease-in-out_0.6s_infinite]">
        <div className="aurora-bg animate-aurora pointer-events-none absolute inset-0 opacity-40" />
        <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="animate-float"><Logo size={44} showText={false} /></div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-accent">
                  ◈ CMDR {(user?.name || 'GRIFF').split(' ')[0].toUpperCase()}
                </span>
                <Badge tone="ok" dot>Online</Badge>
              </div>
              <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
                Good {daypart}, Commander
              </h1>
              <p className="mt-0.5 text-sm text-muted">
                Your fleet at a glance — every project, agent and memory in one view.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="glass" icon="sync" onClick={syncVault} loading={syncing}>Sync vault</Button>
            <Button variant="secondary" icon="refresh" onClick={load} loading={loading}>Refresh</Button>
          </div>
        </div>
      </Card>

      {loading ? (
        <SkeletonList count={4} />
      ) : error ? (
        <EmptyState icon="cloud_off" title="Couldn't load your fleet"
          hint="Something went wrong reaching the server."
          action={<Button icon="refresh" onClick={load}>Retry</Button>} />
      ) : isEmpty ? (
        /* ── First-run welcome: no projects, agents, memories or activity yet ── */
        <Card glass className="relative overflow-hidden p-8 text-center animate-fadeInUp sm:p-12">
          <div className="aurora-bg pointer-events-none absolute inset-0 opacity-30" />
          <div className="relative flex flex-col items-center">
            <div className="animate-pulseGlow rounded-3xl">
              <Logo size={56} showText={false} />
            </div>
            <h2 className="mt-6 font-display text-2xl font-bold text-ink sm:text-3xl">Welcome to AGENT OS</h2>
            <p className="mt-2 max-w-md text-sm text-muted">
              Your command centre is provisioned but empty. Connect a platform and deploy your first
              agent to bring it to life.
            </p>

            <div className="mt-8 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
              {QUICK_START.map((s, i) => (
                <button key={s.to} onClick={() => navigate(s.to)}
                  className="group flex flex-col items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] p-5 text-center transition-all hover:-translate-y-0.5 hover:border-white/15 hover:bg-white/[0.06] animate-fadeInUp"
                  style={{ animationDelay: `${i * 80}ms` }}>
                  <span className="grid h-11 w-11 place-items-center rounded-xl font-mono text-xs font-bold"
                    style={{ background: `${s.accent}1a`, color: s.accent }}>
                    {i + 1}
                  </span>
                  <span className="flex items-center gap-1.5 font-display text-sm font-semibold text-ink">
                    <span className="material-symbols-rounded" style={{ fontSize: 16, color: s.accent }}>{s.icon}</span>
                    {s.title}
                  </span>
                  <span className="text-xs text-muted">{s.desc}</span>
                  <span className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-muted opacity-0 transition-opacity group-hover:opacity-100"
                    style={{ color: s.accent }}>
                    Go <span className="material-symbols-rounded" style={{ fontSize: 13 }}>arrow_forward</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap justify-center gap-2">
              <Button variant="primary" icon="hub" onClick={() => navigate('/integrations')}>Connect a platform</Button>
              <Button variant="glass" icon="sync" onClick={syncVault} loading={syncing}>Sync vault</Button>
            </div>
          </div>
        </Card>
      ) : (
        <>
          {/* 2 ── Quick-action deck ───────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {QUICK_ACTIONS.map((q, i) => (
              <button key={q.to} onClick={() => navigate(q.to)}
                className="lift-glow group flex items-center gap-3.5 rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-left backdrop-blur-xl animate-fadeInUp hover:bg-white/[0.05]"
                style={{ '--glow': `${q.accent}55`, animationDelay: `${i * 50}ms` } as React.CSSProperties}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = `${q.accent}40`; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = ''; }}>
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl transition-transform duration-200 group-hover:scale-110"
                  style={{ background: `${q.accent}1a`, color: q.accent, boxShadow: `0 0 20px -6px ${q.accent}66` }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 22 }}>{q.icon}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-sm font-semibold text-ink">{q.label}</span>
                  <span className="block truncate text-[11px] leading-snug text-muted">{q.desc}</span>
                </span>
                <span className="material-symbols-rounded shrink-0 -translate-x-1 text-muted opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
                  style={{ fontSize: 18, color: q.accent }}>arrow_forward</span>
              </button>
            ))}
          </div>

          {/* 3 ── Stats row ───────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <CountStat label="Total agents"   value={stats?.total_agents   ?? 0} icon="smart_toy"     accent="#19C3E6" delay={0} />
            <CountStat label="Active now"      value={stats?.active_now     ?? 0} icon="bolt"          accent="#22C55E" delay={60} />
            <CountStat label="Total memories"  value={stats?.total_memories ?? 0} icon="auto_awesome"  accent="#A78BFA" delay={120} />
            <CountStat label="Runs today"      value={stats?.runs_today     ?? 0} icon="play_circle"   accent="#F59E0B" delay={180} />
          </div>

          {/* 3 ── Project cards ───────────────────────────────────────── */}
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wider text-muted">
              <span className="h-3.5 w-[3px] rounded-full bg-accent/70 shadow-[0_0_8px_rgba(25,195,230,0.5)]" />
              Projects
            </h2>
            {projects.length === 0 ? (
              <EmptyState icon="workspaces" title="No projects yet" hint="Projects appear here once agents are provisioned." />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((p, i) => (
                  <Card key={p.id} hover role="button" tabIndex={0}
                    onClick={() => openProject(p.id)}
                    onKeyDown={e => { if (e.key === 'Enter') openProject(p.id); }}
                    className="group relative cursor-pointer overflow-hidden p-4 animate-fadeInUp"
                    style={{ animationDelay: `${i * 60}ms` }}>
                    <span className="absolute bottom-3 left-0 top-3 w-1 rounded-r-full transition-all duration-300 group-hover:bottom-2 group-hover:top-2"
                      style={{ background: p.brand_colour, boxShadow: `0 0 12px ${p.brand_colour}88` }} />
                    <div className="flex items-center gap-2 pl-2">
                      <div className="truncate font-display font-semibold text-ink">{p.name}</div>
                      {p.error_count > 0 && <Badge tone="danger" dot>{p.error_count}</Badge>}
                      <span className="material-symbols-rounded ml-auto shrink-0 -translate-x-1 text-muted opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100"
                        style={{ fontSize: 16 }}>arrow_forward</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5 pl-2">
                      <Badge tone="info">{p.agent_count} agents</Badge>
                      <Badge tone="ok" dot>{p.active_count} active</Badge>
                      <Badge tone="neutral">{p.runs_today} runs today</Badge>
                    </div>
                    <div className="mt-3 flex items-center gap-1 pl-2 text-xs text-muted">
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>schedule</span>
                      {timeAgo(p.latest?.created_at)}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </section>

          {/* Two-column: Galaxy preview + activity feed ────────────────── */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* 4 ── Memory Galaxy mini preview ─────────────────────────── */}
            <Card hover className="group cursor-pointer overflow-hidden p-4 lg:col-span-2 animate-fadeInUp"
              onClick={() => navigate('/galaxy')}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wider text-muted">
                  <span className="h-3.5 w-[3px] rounded-full bg-violet/70 shadow-[0_0_8px_rgba(167,139,250,0.5)]" />
                  Memory Galaxy
                </h2>
                <span className="flex items-center gap-1 text-xs text-accent">
                  Explore
                  <span className="material-symbols-rounded transition-transform duration-200 group-hover:translate-x-0.5"
                    style={{ fontSize: 14 }}>arrow_forward</span>
                </span>
              </div>
              {stars.length === 0 ? (
                <EmptyState icon="auto_awesome" accent="#A78BFA" title="No memories yet"
                  hint="As agents learn, their memories light up here as stars." />
              ) : (
                <div className="relative h-[300px] w-full overflow-hidden rounded-xl">
                  {/* slow zoom on hover — leaning closer to the viewport glass */}
                  <div className="h-full w-full transition-transform duration-[1800ms] ease-out group-hover:scale-[1.06]">
                    <Galaxy memories={stars} mini interactive={false} />
                  </div>
                  <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_58%,rgba(5,8,12,0.65)_100%)]" />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-bg/70 to-transparent" />
                  <div className="pointer-events-none absolute bottom-2.5 right-3 font-mono text-[10px] uppercase tracking-widest text-muted/60">
                    {stars.length} stars
                  </div>
                </div>
              )}
            </Card>

            {/* 5 ── Recent activity feed ───────────────────────────────── */}
            <Card className="p-4 animate-fadeInUp">
              <h2 className="mb-3 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wider text-muted">
                <span className="h-3.5 w-[3px] rounded-full bg-emerald/70 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                Recent activity
              </h2>
              {activity.length === 0 ? (
                <EmptyState icon="history" title="Quiet right now" hint="Agent activity across projects shows here." />
              ) : (
                <div className="relative">
                  {/* timeline spine connecting the avatars */}
                  <div className="pointer-events-none absolute bottom-4 left-[23px] top-4 w-px bg-gradient-to-b from-accent/30 via-white/10 to-transparent" />
                  <div className="space-y-1">
                    {activity.slice(0, 8).map((a: any, i: number) => (
                      <div key={a.id ?? i} className="relative flex items-start gap-3 rounded-xl p-1.5 transition-colors hover:bg-white/4 animate-fadeInUp"
                        style={{ animationDelay: `${i * 40}ms` }}>
                        <Avatar colour={a.avatar_colour} initials={a.avatar_initials} size={34} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-ink">
                              {a.real_name || a.name || 'Agent'}
                            </span>
                            {a.tenant_name && <Badge tone="neutral">{a.tenant_name}</Badge>}
                          </div>
                          {a.summary && <div className="truncate text-xs text-muted">{a.summary}</div>}
                          <div className="text-[11px] tabular-nums text-muted/70">{timeAgo(a.created_at)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>

          {/* 6 ── Live activity ticker ─────────────────────────────────── */}
          {activity.length > 0 && (
            <Card glass className="overflow-hidden px-0 py-2.5 animate-fadeInUp">
              <div className="flex items-center">
                <div className="z-10 flex shrink-0 items-center gap-1.5 border-r border-white/8 bg-surface/80 px-4">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald" />
                  </span>
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-emerald">Live</span>
                </div>
                <div className="ticker-mask min-w-0 flex-1 overflow-hidden">
                  <div className="ticker-track">
                    {[0, 1].map(copy => (
                      <div key={copy} className="flex shrink-0 items-center" aria-hidden={copy === 1}>
                        {activity.slice(0, 12).map((a: any, i: number) => (
                          <span key={`${copy}-${a.id ?? i}`} className="flex items-center gap-2 whitespace-nowrap px-5 text-xs text-muted">
                            <span className="h-1.5 w-1.5 rounded-full"
                              style={{ background: a.avatar_colour || '#19C3E6', boxShadow: `0 0 6px ${a.avatar_colour || '#19C3E6'}` }} />
                            <span className="font-semibold text-ink">{a.real_name || a.name || 'Agent'}</span>
                            {a.summary && <span className="max-w-[280px] truncate">{a.summary}</span>}
                            <span className="text-muted/60">{timeAgo(a.created_at)}</span>
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
