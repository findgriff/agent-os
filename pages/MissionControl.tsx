// MissionControl — the live command centre for a single project (or the whole
// fleet when no project is selected). Auto-polls every 10s and keeps the last
// good data on screen while refreshing, so it never flashes on a poll tick.
//
// Panels, top to bottom: telemetry strip (aerospace readouts), stat strip,
// time-series charts (inline SVG), alert panel, fleet health matrix
// (sortable heatmap), agent honeycomb, activity feed (with a mini memory
// galaxy) + agent comms, quick actions. ⌘K opens the command palette.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Button, Badge, Icon, Drawer, Modal, Input, EmptyState, SkeletonList,
  useToast, useCountUp, STATUS_TONE, TEAM_COLOUR,
} from '../components/ui';
import { Avatar } from '../components/Avatar';
import { Galaxy } from '../components/Galaxy';
import { useApp } from '../lib/store';
import { api, timeAgo } from '../lib/api';
import type {
  Agent, GalaxyStar, LogEntry, MCAlert, MCMatrixRow, MissionControl as MC, Team,
} from '../lib/types';

// ── Background keyframes (transform/opacity only, GPU-friendly) ──────────
const BG_KEYFRAMES = `
@keyframes mcOrbit    { from { transform: rotate(0deg); }   to { transform: rotate(360deg); } }
@keyframes mcOrbitRev { from { transform: rotate(360deg); } to { transform: rotate(0deg); } }
@keyframes mcGridPulse { 0%,100% { opacity: 0.30; } 50% { opacity: 0.10; } }
@keyframes mcAuroraDrift {
  0%,100% { transform: translate3d(-3%, -2%, 0) scale(1); }
  50%     { transform: translate3d(3%, 2%, 0) scale(1.04); }
}`;

// ── Small helpers ─────────────────────────────────────────────────────────
const SEVERITY_COLOUR: Record<MCAlert['severity'], string> = {
  critical: '#F43F5E', warn: '#F59E0B', info: '#38BDF8',
};
const STATUS_RANK: Record<string, number> = { error: 0, flagged: 1, running: 2, idle: 3 };

// Heatmap tones for matrix cells (green / amber / red).
const rateColour = (v: number | null) =>
  v == null ? null : v >= 95 ? '#22C55E' : v >= 80 ? '#F59E0B' : '#F43F5E';
const latencyColour = (v: number | null) =>
  v == null ? null : v <= 3000 ? '#22C55E' : v <= 8000 ? '#F59E0B' : '#F43F5E';

function downloadFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// Heat cell — value pill tinted by the tone colour.
function HeatCell({ text, colour }: { text: string; colour: string | null }) {
  return (
    <span className="inline-block rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums"
      style={colour ? { color: colour, background: `${colour}17` } : { color: '#7B8DA8', opacity: 0.6 }}>
      {text}
    </span>
  );
}

// ── Telemetry readout tile (aerospace style: mono, corner ticks) ─────────
function TelemetryTile({ label, value, unit, dot, sub, delay }: {
  label: string; value: string; unit?: string; dot: string; sub?: string; delay: number;
}) {
  return (
    <div className="glass relative rounded-xl px-3 py-2.5 animate-fadeInUp"
      style={{ animationDelay: `${delay}ms` }}>
      <span className="pointer-events-none absolute left-0 top-0 h-2 w-2 rounded-tl-xl border-l border-t border-accent/40" />
      <span className="pointer-events-none absolute right-0 top-0 h-2 w-2 rounded-tr-xl border-r border-t border-accent/40" />
      <span className="pointer-events-none absolute bottom-0 left-0 h-2 w-2 rounded-bl-xl border-b border-l border-accent/40" />
      <span className="pointer-events-none absolute bottom-0 right-0 h-2 w-2 rounded-br-xl border-b border-r border-accent/40" />
      <div className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-widest text-muted">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot, boxShadow: `0 0 6px ${dot}` }} />
        {label}
      </div>
      <div className="mt-1 font-mono text-lg font-bold tabular-nums leading-tight text-ink">
        {value}{unit && <span className="ml-1 text-xs font-medium text-muted">{unit}</span>}
      </div>
      {sub && <div className="font-mono text-[10px] text-muted/70">{sub}</div>}
    </div>
  );
}

// ── Inline SVG chart (line / area / bar) — no libraries ──────────────────
// Fixed viewBox stretched to the container; strokes stay crisp via
// vector-effect: non-scaling-stroke.
const VW = 240, VH = 72;
function SeriesChart({ data, colour, kind, id, unit = '' }: {
  data: number[]; colour: string; kind: 'line' | 'area' | 'bar'; id: string; unit?: string;
}) {
  if (!data.length) return <div className="h-[72px]" />;
  const max = Math.max(...data, 1);
  const gid = `mcg-${id}`;
  const grid = [1 / 3, 2 / 3].map(f => (
    <line key={f} x1="0" x2={VW} y1={VH - 4 - f * (VH - 8)} y2={VH - 4 - f * (VH - 8)}
      stroke="rgba(255,255,255,0.06)" vectorEffect="non-scaling-stroke" />
  ));
  let marks;
  if (kind === 'bar') {
    const bw = VW / data.length;
    marks = data.map((v, i) => {
      const h = v > 0 ? Math.max((v / max) * (VH - 8), 2) : 1;
      return (
        <rect key={i} x={i * bw + bw * 0.19} y={VH - 4 - h} width={bw * 0.62} height={h}
          rx="1" fill={colour} opacity={v > 0 ? 0.85 : 0.18}>
          <title>{`${v.toLocaleString()}${unit}`}</title>
        </rect>
      );
    });
  } else {
    const step = VW / Math.max(1, data.length - 1);
    const pts = data.map((v, i) => [i * step, VH - 4 - (v / max) * (VH - 8)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    marks = (
      <>
        <path d={`${line} L${VW},${VH} L0,${VH} Z`} fill={`url(#${gid})`}
          opacity={kind === 'area' ? 1 : 0.55} />
        <path d={line} fill="none" stroke={colour} strokeWidth="1.6"
          strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </>
    );
  }
  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none" className="h-[72px] w-full">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity="0.3" />
          <stop offset="100%" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid}
      {marks}
    </svg>
  );
}

function ChartCard({ title, value, colour, from, to, delay, children }: {
  title: string; value: string; colour: string; from: string; to: string;
  delay: number; children: React.ReactNode;
}) {
  return (
    <Card className="p-4 animate-fadeInUp" style={{ animationDelay: `${delay}ms` }}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="font-display text-[11px] font-semibold uppercase tracking-wider text-muted">
          {title}
        </span>
        <span className="font-mono text-sm font-bold tabular-nums" style={{ color: colour }}>
          {value}
        </span>
      </div>
      {children}
      <div className="mt-1 flex justify-between font-mono text-[9px] text-muted/60">
        <span>{from}</span><span>{to}</span>
      </div>
    </Card>
  );
}

// Small wrapper so every stat tile animates its own eased count-up.
function CountStat({ label, value, icon, accent, prefix = '', delay }:
  { label: string; value: number; icon: string; accent: string; prefix?: string; delay: number }) {
  const n = useCountUp(value);
  return (
    <Card glass className="p-4 animate-fadeInUp" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
          style={{ background: `${accent}1a`, color: accent }}>
          <Icon name={icon} size={20} />
        </div>
        <div className="min-w-0">
          <div className="font-display text-2xl font-bold leading-tight text-ink">
            {prefix}{n.toLocaleString()}
          </div>
          <div className="truncate text-xs text-muted">{label}</div>
        </div>
      </div>
    </Card>
  );
}

// Format the cost tile — cents-of-a-dollar precision.
function CostStat({ value, delay }: { value: number; delay: number }) {
  const cents = useCountUp(Math.round((value || 0) * 100));
  return (
    <Card glass className="p-4 animate-fadeInUp" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
          style={{ background: '#F59E0B1a', color: '#F59E0B' }}>
          <Icon name="payments" size={20} />
        </div>
        <div className="min-w-0">
          <div className="font-display text-2xl font-bold leading-tight text-ink">
            ${(cents / 100).toFixed(2)}
          </div>
          <div className="truncate text-xs text-muted">Cost today</div>
        </div>
      </div>
    </Card>
  );
}

// A single hexagon health tile in the honeycomb grid.
const HEX = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';
function HexTile({ h, onClick, delay }:
  { h: MC['health'][number]; onClick: () => void; delay: number }) {
  const glow =
    h.status === 'running' ? `0 0 14px ${h.colour}, 0 0 4px ${h.colour}` :
    h.status === 'error' ? '0 0 14px #F43F5E' :
    h.status === 'flagged' ? '0 0 12px #F59E0B' : 'none';
  const ring =
    h.status === 'error' ? '#F43F5E' :
    h.status === 'flagged' ? '#F59E0B' :
    h.status === 'running' ? h.colour : 'rgba(255,255,255,0.14)';
  return (
    <button
      type="button"
      title={`${h.name} · ${h.team} · ${h.status}`}
      onClick={onClick}
      style={{ animationDelay: `${delay}ms` }}
      className={`group relative h-14 w-[52px] shrink-0 animate-fadeInUp transition-transform
        hover:z-10 hover:scale-110 focus:outline-none ${h.enabled ? '' : 'opacity-35 saturate-50'}`}
    >
      <span
        className={`absolute inset-0 grid place-items-center text-[11px] font-bold text-white
          ${h.status === 'running' ? 'animate-pulseGlow' : ''}`}
        style={{
          clipPath: HEX,
          background: `linear-gradient(150deg, ${h.colour}, ${h.colour}aa)`,
          boxShadow: glow,
          border: `1px solid ${ring}`,
        }}
      >
        {h.initials || '··'}
      </span>
      {h.active && (
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald shadow-[0_0_8px_#22C55E]" />
      )}
    </button>
  );
}

type SortKey = 'name' | 'status' | 'last_run_at' | 'success_rate'
  | 'avg_latency_ms' | 'tasks_today' | 'memory_count';

export default function MissionControl() {
  const { selectedTenant, tenants } = useApp();
  const toast = useToast();
  const navigate = useNavigate();

  const [data, setData] = useState<MC | null>(null);
  const [loading, setLoading] = useState(true);   // only true on the very first load
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Drawer state for an inspected agent.
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [drawerAgent, setDrawerAgent] = useState<Agent | null>(null);
  const [drawerLogs, setDrawerLogs] = useState<LogEntry[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // Health matrix sort, alert panel, command palette, mini galaxy.
  const [sortKey, setSortKey] = useState<SortKey>('status');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [alertsOpen, setAlertsOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 768);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [runningAll, setRunningAll] = useState(false);
  const [clearingFlags, setClearingFlags] = useState(false);
  const [stars, setStars] = useState<GalaxyStar[]>([]);

  const firstLoad = useRef(true);
  const activeTenant = useRef(selectedTenant);   // guards against stale cross-project responses

  const load = async (silent = false) => {
    const reqTenant = selectedTenant;
    if (!silent && firstLoad.current) setLoading(true);
    else setRefreshing(true);
    try {
      const mc = await api.missionControl(selectedTenant ?? undefined);
      if (activeTenant.current !== reqTenant) return;   // project switched mid-flight — drop stale data
      setData(mc);
    } catch {
      if (activeTenant.current === reqTenant && firstLoad.current) setData(null);
      // On a poll failure keep the previous data on screen.
    } finally {
      firstLoad.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  };

  // (Re)load + (re)arm the 10s poll whenever the selected project changes.
  useEffect(() => {
    activeTenant.current = selectedTenant;
    firstLoad.current = true;
    setLoading(true);
    load();
    const t = setInterval(() => load(true), 10000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTenant]);

  // Mini galaxy — the 10 most recent memories. Fetched once per project,
  // not on every poll (three.js scene rebuilds are not free).
  useEffect(() => {
    let alive = true;
    api.galaxy(selectedTenant ?? undefined)
      .then(g => {
        if (!alive) return;
        const recent = [...(g.memories || [])]
          .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
          .slice(0, 10)
          .map(m => ({ ...m, connected_to: [] }));  // no dangling constellation lines
        setStars(recent);
      })
      .catch(() => { if (alive) setStars([]); });
    return () => { alive = false; };
  }, [selectedTenant]);

  // ⌘K / Ctrl+K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
        setPaletteQuery('');
        setPaletteIdx(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openAgent = async (id: number) => {
    setDrawerId(id);
    setDrawerAgent(null);
    setDrawerLogs([]);
    setDrawerLoading(true);
    try {
      const [a, l] = await Promise.all([api.agent(id), api.agentLog(id)]);
      setDrawerAgent(a.agent);
      setDrawerLogs(l.logs || []);
    } catch {
      toast('Could not load agent', 'danger');
    } finally {
      setDrawerLoading(false);
    }
  };

  const syncVault = async () => {
    setSyncing(true);
    try {
      const res = await api.vaultSync();
      toast(`Synced ${res.synced} memories`, 'ok');
    } catch {
      toast('Vault sync failed', 'danger');
    } finally {
      setSyncing(false);
    }
  };

  // ── Command palette actions ─────────────────────────────────────────────
  const runAllAgents = async () => {
    const targets = (data?.health ?? []).filter(h => h.enabled);
    if (!targets.length) { toast('No enabled agents to run', 'danger'); return; }
    setRunningAll(true);
    toast(`Running ${targets.length} agents…`, 'ok');
    let ok = 0, failed = 0;
    for (const t of targets) {
      try { await api.runAgent(t.id); ok++; } catch { failed++; }
    }
    setRunningAll(false);
    toast(failed ? `Ran ${ok} agents · ${failed} failed` : `Ran ${ok} agents`, failed ? 'danger' : 'ok');
    load(true);
  };

  const clearFlags = async () => {
    const flagged = (data?.matrix ?? []).filter(r => r.status === 'flagged');
    if (!flagged.length) { toast('No flagged agents', 'ok'); return; }
    setClearingFlags(true);
    try {
      await Promise.all(flagged.map(f => api.updateAgent(f.id, { last_status: 'idle' })));
      toast(`Cleared ${flagged.length} flags`, 'ok');
      load(true);
    } catch {
      toast('Could not clear all flags', 'danger');
    } finally {
      setClearingFlags(false);
    }
  };

  const generateBriefing = () => {
    if (!data) return;
    const tel = data.telemetry;
    const lines = [
      `# Mission briefing — ${projectName}`,
      `Generated ${new Date(data.generated_at * 1000).toISOString()}`,
      '',
      '## Fleet',
      `- Agents: ${data.total} (${data.active_now} active in the last hour)`,
      `- Drafts today: ${data.drafts_today} · Messages today: ${data.messages_today}`,
      `- Tokens today: ${data.tokens_today.toLocaleString()} · Cost today: $${data.cost_today.toFixed(2)}`,
      ...(tel ? [
        '',
        '## Telemetry',
        `- Fleet uptime: ${tel.uptime_pct}%`,
        `- Task success rate (7d): ${tel.success_rate ?? '—'}%`,
        `- Avg response latency: ${tel.avg_latency_ms != null ? `${tel.avg_latency_ms.toLocaleString()} ms` : '—'}`,
        `- API calls today: ${tel.api_calls_today}`,
        `- Error rate (last hour): ${tel.error_rate_hour}%`,
      ] : []),
      '',
      '## Alerts',
      ...(visibleAlerts.length
        ? visibleAlerts.map(a => `- [${a.severity.toUpperCase()}] ${a.message} (${timeAgo(a.at ?? undefined)})`)
        : ['- All systems nominal']),
      '',
      '## Recent activity',
      ...data.recent_activity.slice(0, 10).map((a: any) =>
        `- ${a.agent_real || a.agent_name || 'Agent'}: ${a.summary || a.action} (${timeAgo(a.created_at)})`),
    ];
    downloadFile(`briefing-${new Date().toISOString().slice(0, 10)}.md`,
      lines.join('\n'), 'text/markdown');
    toast('Briefing downloaded', 'ok');
  };

  const exportReport = () => {
    if (!data) return;
    downloadFile(`mission-report-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(data, null, 2), 'application/json');
    toast('Report exported', 'ok');
  };

  const COMMANDS = [
    { id: 'run-all', label: 'Run all agents', icon: 'rocket_launch', hint: 'triggers every enabled agent', run: runAllAgents, busy: runningAll },
    { id: 'briefing', label: 'Generate briefing', icon: 'summarize', hint: 'download a markdown status brief', run: generateBriefing, busy: false },
    { id: 'sync-vault', label: 'Sync vault', icon: 'cloud_sync', hint: 'mirror memories to Obsidian', run: syncVault, busy: syncing },
    { id: 'clear-flags', label: 'Clear flags', icon: 'flag_check', hint: 'mark flagged agents as idle', run: clearFlags, busy: clearingFlags },
    { id: 'export', label: 'Export report', icon: 'download', hint: 'full telemetry as JSON', run: exportReport, busy: false },
  ];
  const paletteMatches = COMMANDS.filter(c =>
    c.label.toLowerCase().includes(paletteQuery.toLowerCase()) ||
    c.hint.toLowerCase().includes(paletteQuery.toLowerCase()));

  const runCommand = (cmd: typeof COMMANDS[number]) => {
    setPaletteOpen(false);
    cmd.run();
  };

  const projectName = selectedTenant
    ? tenants.find(t => t.id === selectedTenant)?.name ?? 'Project'
    : 'All projects';

  const health = data?.health ?? [];
  const activity = data?.recent_activity ?? [];
  const messages = data?.recent_messages ?? [];
  const telemetry = data?.telemetry;
  const series = data?.series;
  const alerts = data?.alerts ?? [];
  const visibleAlerts = alerts.filter(a => !dismissed.has(a.id));
  const criticalCount = visibleAlerts.filter(a => a.severity === 'critical').length;

  // ── Sortable health matrix rows ─────────────────────────────────────────
  const matrixRows = useMemo(() => {
    const rows = [...(data?.matrix ?? [])];
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      if (sortKey === 'name') return dir * a.name.localeCompare(b.name);
      if (sortKey === 'status') {
        return dir * (STATUS_RANK[a.status] - STATUS_RANK[b.status])
          || a.name.localeCompare(b.name);
      }
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;         // nulls always sink to the bottom
      if (bv == null) return -1;
      return dir * (av - bv);
    });
    return rows;
  }, [data?.matrix, sortKey, sortDir]);

  const setSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      // Numeric columns read best big-first; text/status read best a-first.
      setSortDir(key === 'name' || key === 'status' ? 'asc' : 'desc');
    }
  };

  const MATRIX_COLS: Array<{ key: SortKey; label: string; align?: string }> = [
    { key: 'name', label: 'Agent' },
    { key: 'status', label: 'Status' },
    { key: 'last_run_at', label: 'Last run' },
    { key: 'success_rate', label: 'Success', align: 'text-right' },
    { key: 'avg_latency_ms', label: 'Latency', align: 'text-right' },
    { key: 'tasks_today', label: 'Tasks', align: 'text-right' },
    { key: 'memory_count', label: 'Memories', align: 'text-right' },
  ];

  const tokens24h = series?.tokens_24h ?? [];
  const tasks24h = series?.tasks_24h ?? [];
  const errors24h = series?.errors_24h ?? [];
  const cost7d = series?.cost_7d ?? [];

  return (
    <div className="relative min-h-full overflow-hidden p-4 md:p-6">
      <style>{BG_KEYFRAMES}</style>

      {/* ── Cinematic background: aurora + drift, pulse grid, orbital rings,
             floating particles. Transform/opacity only. ─────────────────── */}
      <div className="aurora-bg animate-aurora pointer-events-none absolute inset-0 -z-10 opacity-60" />
      <div className="aurora-bg pointer-events-none absolute -inset-[8%] -z-10 opacity-25"
        style={{ animation: 'mcAuroraDrift 26s ease-in-out infinite', willChange: 'transform' }} />
      <div className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            'linear-gradient(rgba(25,195,230,0.05) 1px, transparent 1px), ' +
            'linear-gradient(90deg, rgba(25,195,230,0.05) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse at 50% 0%, black 25%, transparent 78%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 50% 0%, black 25%, transparent 78%)',
          animation: 'mcGridPulse 7s ease-in-out infinite',
          willChange: 'opacity',
        }} />
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        {/* Orbital rings, top-right — each carries a satellite dot. */}
        <div className="absolute -right-48 -top-48 h-[520px] w-[520px] rounded-full border border-accent/10"
          style={{ animation: 'mcOrbit 70s linear infinite', willChange: 'transform' }}>
          <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/80 shadow-[0_0_10px_#19C3E6]" />
        </div>
        <div className="absolute -right-28 -top-28 h-[320px] w-[320px] rounded-full border border-dashed border-violet/15"
          style={{ animation: 'mcOrbitRev 45s linear infinite', willChange: 'transform' }}>
          <span className="absolute left-1/2 top-0 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet/80 shadow-[0_0_8px_#A78BFA]" />
        </div>
        <div className="absolute -bottom-56 -left-56 h-[480px] w-[480px] rounded-full border border-sky/10"
          style={{ animation: 'mcOrbit 90s linear infinite', willChange: 'transform' }}>
          <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky/70 shadow-[0_0_10px_#38BDF8]" />
        </div>
        {/* Floating particles. */}
        <div className="animate-float absolute left-[8%] top-[12%] h-2 w-2 rounded-full bg-accent/60 blur-[1px]" />
        <div className="animate-twinkle absolute left-[24%] top-[38%] h-1.5 w-1.5 rounded-full bg-violet/70" style={{ animationDelay: '600ms' }} />
        <div className="animate-float absolute right-[16%] top-[20%] h-2.5 w-2.5 rounded-full bg-sky/50 blur-[1px]" style={{ animationDelay: '1200ms' }} />
        <div className="animate-twinkle absolute right-[30%] bottom-[24%] h-1.5 w-1.5 rounded-full bg-emerald/70" style={{ animationDelay: '300ms' }} />
        <div className="animate-float absolute left-[46%] bottom-[10%] h-2 w-2 rounded-full bg-amber/50 blur-[1px]" style={{ animationDelay: '900ms' }} />
        <div className="animate-twinkle absolute left-[70%] top-[8%] h-1 w-1 rounded-full bg-accent/80" style={{ animationDelay: '1500ms' }} />
      </div>

      <div className="relative space-y-6">
        {/* ── Header + LIVE badge + command chips ─────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 animate-fadeInUp">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl glass text-accent">
              <Icon name="radar" size={24} />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold text-ink">Mission Control</h1>
              <p className="text-sm text-muted">{projectName} · live fleet telemetry</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { setPaletteOpen(true); setPaletteQuery(''); setPaletteIdx(0); }}
              className="glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:text-ink"
            >
              <Icon name="keyboard_command_key" size={14} />
              Commands
              <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
            </button>
            <span className="glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold text-emerald">
              <span className="animate-pulseGlow h-2 w-2 rounded-full bg-emerald shadow-[0_0_10px_#22C55E]" />
              LIVE
              {refreshing && <Icon name="progress_activity" size={13} className="animate-spin text-muted" />}
            </span>
          </div>
        </div>

        {/* Command chips — one-tap fleet operations. */}
        <div className="-mt-2 flex flex-wrap items-center gap-2 animate-fadeInUp" style={{ animationDelay: '40ms' }}>
          {COMMANDS.map(c => (
            <button key={c.id} type="button" onClick={() => c.run()} disabled={c.busy}
              className="glass inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-muted transition-all hover:scale-[1.03] hover:text-ink disabled:opacity-50">
              <Icon name={c.busy ? 'progress_activity' : c.icon} size={14}
                className={c.busy ? 'animate-spin' : 'text-accent'} />
              {c.label}
            </button>
          ))}
        </div>

        {loading ? (
          <SkeletonList count={5} />
        ) : !data ? (
          <EmptyState icon="satellite_alt" accent="#F59E0B" large title="Start your first mission"
            hint="No telemetry yet — deploy an agent and give it work. Live fleet data streams here the moment a mission begins.">
            <div className="mt-2 w-full max-w-sm space-y-1.5 text-left">
              {[
                { icon: 'smart_toy', cmd: 'Deploy an agent', sub: 'Provision a crew member from the Agents page' },
                { icon: 'play_circle', cmd: 'Run a pipeline', sub: 'Kick off an automated workflow' },
                { icon: 'mic', cmd: '“Apollo, run a status check”', sub: 'Issue a voice command from the console' },
              ].map(c => (
                <div key={c.cmd}
                  className="flex items-center gap-3 rounded-xl border border-white/6 bg-white/[0.03] px-3.5 py-2.5">
                  <Icon name={c.icon} size={18} style={{ color: '#F59E0B' } as any} />
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs font-semibold text-ink">{c.cmd}</span>
                    <span className="block truncate text-[11px] text-muted">{c.sub}</span>
                  </span>
                </div>
              ))}
            </div>
          </EmptyState>
        ) : (
          <>
            {/* ── 1. Real-time telemetry strip ───────────────────────── */}
            {telemetry && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                <TelemetryTile label="Fleet uptime" delay={0}
                  value={telemetry.uptime_pct.toFixed(1)} unit="%"
                  dot={telemetry.uptime_pct >= 90 ? '#22C55E' : telemetry.uptime_pct >= 70 ? '#F59E0B' : '#F43F5E'}
                  sub="enabled agents healthy" />
                <TelemetryTile label="Success rate" delay={40}
                  value={telemetry.success_rate != null ? telemetry.success_rate.toFixed(1) : '——'}
                  unit={telemetry.success_rate != null ? '%' : undefined}
                  dot={telemetry.success_rate == null ? '#7B8DA8'
                    : telemetry.success_rate >= 95 ? '#22C55E'
                    : telemetry.success_rate >= 80 ? '#F59E0B' : '#F43F5E'}
                  sub="tasks · last 7 days" />
                <TelemetryTile label="Avg latency" delay={80}
                  value={telemetry.avg_latency_ms != null ? telemetry.avg_latency_ms.toLocaleString() : '——'}
                  unit={telemetry.avg_latency_ms != null ? 'ms' : undefined}
                  dot={telemetry.avg_latency_ms == null ? '#7B8DA8'
                    : telemetry.avg_latency_ms <= 3000 ? '#22C55E'
                    : telemetry.avg_latency_ms <= 8000 ? '#F59E0B' : '#F43F5E'}
                  sub="model response · 7d" />
                <TelemetryTile label="API calls" delay={120}
                  value={telemetry.api_calls_today.toLocaleString()}
                  dot="#38BDF8" sub="today" />
                <TelemetryTile label="Error rate" delay={160}
                  value={telemetry.error_rate_hour.toFixed(1)} unit="%"
                  dot={telemetry.error_rate_hour === 0 ? '#22C55E'
                    : telemetry.error_rate_hour <= 10 ? '#F59E0B' : '#F43F5E'}
                  sub={`${telemetry.errors_hour}/${telemetry.calls_hour} calls · last hour`} />
              </div>
            )}

            {/* ── 2. Stat strip ──────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <CountStat label="Total agents"   value={data.total}          icon="smart_toy"      accent="#19C3E6" delay={0} />
              <CountStat label="Active now"      value={data.active_now}     icon="bolt"           accent="#22C55E" delay={60} />
              <CountStat label="Drafts today"    value={data.drafts_today}   icon="edit_note"      accent="#A78BFA" delay={120} />
              <CountStat label="Messages today"  value={data.messages_today} icon="forum"          accent="#38BDF8" delay={180} />
              <CountStat label="Tokens today"    value={data.tokens_today}   icon="toll"           accent="#F43F5E" delay={240} />
              <CostStat  value={data.cost_today} delay={300} />
            </div>

            {/* ── 3. Time-series charts (inline SVG) ─────────────────── */}
            {series && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <ChartCard title="Token usage · 24h" colour="#19C3E6" delay={80}
                  value={tokens24h.reduce((s, v) => s + v, 0).toLocaleString()}
                  from="-24h" to="now">
                  <SeriesChart id="tok" data={tokens24h} colour="#19C3E6" kind="line" unit=" tokens" />
                </ChartCard>
                <ChartCard title="Cost trend · 7d" colour="#A78BFA" delay={140}
                  value={`$${cost7d.reduce((s, v) => s + v, 0).toFixed(2)}`}
                  from="-7d" to="today">
                  <SeriesChart id="cost" data={cost7d} colour="#A78BFA" kind="area" />
                </ChartCard>
                <ChartCard title="Tasks per hour" colour="#38BDF8" delay={200}
                  value={tasks24h.reduce((s, v) => s + v, 0).toLocaleString()}
                  from="-24h" to="now">
                  <SeriesChart id="tasks" data={tasks24h} colour="#38BDF8" kind="bar" unit=" tasks" />
                </ChartCard>
                <ChartCard title="Errors · 24h" colour="#F43F5E" delay={260}
                  value={errors24h.reduce((s, v) => s + v, 0).toLocaleString()}
                  from="-24h" to="now">
                  <SeriesChart id="err" data={errors24h} colour="#F43F5E" kind="area" />
                </ChartCard>
              </div>
            )}

            {/* ── 4. Alert panel (collapsible) ───────────────────────── */}
            <Card className="animate-fadeInUp" style={{ animationDelay: '120ms' }}>
              <button
                type="button"
                onClick={() => setAlertsOpen(o => !o)}
                className="flex w-full items-center gap-2 p-5 text-left"
              >
                <Icon name="notifications_active" size={18}
                  className={criticalCount ? 'text-rose' : 'text-muted'} />
                <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
                  Alerts
                </h2>
                {visibleAlerts.length > 0 ? (
                  <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-bold
                    ${criticalCount ? 'bg-rose/15 text-rose' : 'bg-amber/15 text-amber'}`}>
                    {visibleAlerts.length}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 font-mono text-[11px] text-emerald">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald shadow-[0_0_6px_#22C55E]" />
                    ALL SYSTEMS NOMINAL
                  </span>
                )}
                <Icon name={alertsOpen ? 'expand_less' : 'expand_more'} size={18}
                  className="ml-auto text-muted" />
              </button>
              {alertsOpen && visibleAlerts.length > 0 && (
                <div className="max-h-72 space-y-2 overflow-y-auto px-5 pb-5">
                  {visibleAlerts.map((a, i) => (
                    <div key={a.id}
                      className="flex items-center gap-3 rounded-xl border border-white/5 bg-black/20 px-3 py-2.5 animate-fadeInUp"
                      style={{ animationDelay: `${i * 40}ms` }}>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${a.severity === 'critical' ? 'animate-pulseGlow' : ''}`}
                        style={{ background: SEVERITY_COLOUR[a.severity], boxShadow: `0 0 8px ${SEVERITY_COLOUR[a.severity]}` }} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-ink">{a.message}</div>
                        <div className="font-mono text-[10px] uppercase tracking-wider text-muted/70">
                          {a.severity} · {timeAgo(a.at ?? undefined)}
                        </div>
                      </div>
                      {a.agent_id != null && (
                        <Button variant="ghost" className="shrink-0 !px-2 !py-1 text-xs"
                          onClick={() => openAgent(a.agent_id!)}>
                          Inspect
                        </Button>
                      )}
                      <button type="button" title="Dismiss"
                        onClick={() => setDismissed(prev => new Set(prev).add(a.id))}
                        className="shrink-0 text-muted/60 transition-colors hover:text-ink">
                        <Icon name="close" size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* ── 5. Fleet health matrix (sortable heatmap) ──────────── */}
            <Card className="p-5 animate-fadeInUp" style={{ animationDelay: '160ms' }}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
                  Fleet health matrix
                </h2>
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted/60">
                  7-day window
                </span>
              </div>
              {matrixRows.length === 0 ? (
                <EmptyState icon="grid_view" accent="#F59E0B" title="No agents" hint="Provisioned agents will appear here." />
              ) : (
                <div className="-mx-5 overflow-x-auto px-5">
                  <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr>
                        {MATRIX_COLS.map(col => (
                          <th key={col.key}
                            className={`cursor-pointer select-none border-b border-white/10 pb-2 pr-3 font-display text-[11px] font-semibold uppercase tracking-wider text-muted transition-colors hover:text-ink ${col.align ?? 'text-left'}`}
                            onClick={() => setSort(col.key)}>
                            <span className="inline-flex items-center gap-0.5">
                              {col.label}
                              {sortKey === col.key && (
                                <Icon name={sortDir === 'asc' ? 'arrow_drop_up' : 'arrow_drop_down'} size={16} />
                              )}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {matrixRows.map((r, i) => (
                        <tr key={r.id}
                          onClick={() => openAgent(r.id)}
                          className={`cursor-pointer transition-colors hover:bg-white/5 ${r.enabled ? '' : 'opacity-45'}`}>
                          <td className="border-b border-white/5 py-2 pr-3">
                            <span className="flex items-center gap-2">
                              <Avatar colour={r.colour} initials={r.initials} size={26} />
                              <span className="min-w-0">
                                <span className="block truncate font-semibold text-ink">{r.name}</span>
                                {r.team && (
                                  <span className="block truncate text-[10px] capitalize"
                                    style={{ color: TEAM_COLOUR[r.team as Team] ?? '#7B8DA8' }}>
                                    {r.team}
                                  </span>
                                )}
                              </span>
                            </span>
                          </td>
                          <td className="border-b border-white/5 py-2 pr-3">
                            <Badge tone={STATUS_TONE[r.status] ?? 'neutral'} dot>{r.status}</Badge>
                          </td>
                          <td className="whitespace-nowrap border-b border-white/5 py-2 pr-3 font-mono text-xs text-muted">
                            {timeAgo(r.last_run_at ?? undefined)}
                          </td>
                          <td className="border-b border-white/5 py-2 pr-3 text-right">
                            <HeatCell colour={rateColour(r.success_rate)}
                              text={r.success_rate != null ? `${r.success_rate.toFixed(0)}%` : '—'} />
                          </td>
                          <td className="border-b border-white/5 py-2 pr-3 text-right">
                            <HeatCell colour={latencyColour(r.avg_latency_ms)}
                              text={r.avg_latency_ms != null ? `${r.avg_latency_ms.toLocaleString()}ms` : '—'} />
                          </td>
                          <td className="border-b border-white/5 py-2 pr-3 text-right font-mono text-xs tabular-nums text-ink">
                            {r.tasks_today}
                          </td>
                          <td className="border-b border-white/5 py-2 text-right font-mono text-xs tabular-nums text-ink">
                            {r.memory_count}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* ── 6. Live agent health honeycomb ─────────────────────── */}
            <Card className="p-5 animate-fadeInUp" style={{ animationDelay: '180ms' }}>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
                  Agent health
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                  <Badge tone="info" dot>running</Badge>
                  <Badge tone="warn" dot>flagged</Badge>
                  <Badge tone="danger" dot>error</Badge>
                </div>
              </div>
              {health.length === 0 ? (
                <EmptyState icon="grid_view" accent="#F59E0B" title="No agents" hint="Provisioned agents will appear here." />
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {health.map((h, i) => (
                    <HexTile key={h.id} h={h} delay={i * 25} onClick={() => openAgent(h.id)} />
                  ))}
                </div>
              )}
            </Card>

            {/* ── 7. Activity feed (+ mini galaxy) + comms ───────────── */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* Activity feed with a timeline spine */}
              <Card className="p-5 animate-fadeInUp" style={{ animationDelay: '220ms' }}>
                <h2 className="mb-4 font-display text-sm font-semibold uppercase tracking-wider text-muted">
                  Activity feed
                </h2>

                {/* Mini memory galaxy — 10 most recent memories; click through
                    to the full Memory Galaxy page. */}
                {stars.length > 0 && (
                  <button
                    type="button"
                    onClick={() => navigate('/galaxy')}
                    title="Open Memory Galaxy"
                    className="group relative mb-4 block h-[150px] w-full overflow-hidden rounded-xl border border-white/5 bg-black/30 text-left"
                  >
                    <div className="pointer-events-none h-full w-full">
                      <Galaxy memories={stars} mini interactive={false} className="h-full w-full" />
                    </div>
                    <span className="absolute left-3 top-2.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-muted">
                      <Icon name="auto_awesome" size={12} className="text-violet" />
                      Memory galaxy · {stars.length} recent
                    </span>
                    <span className="absolute bottom-2.5 right-3 flex items-center gap-1 text-[11px] font-semibold text-muted opacity-0 transition-opacity group-hover:opacity-100">
                      Open <Icon name="arrow_forward" size={13} />
                    </span>
                  </button>
                )}

                {activity.length === 0 ? (
                  <EmptyState icon="history" accent="#F59E0B" title="Quiet right now" hint="Live agent activity streams here." />
                ) : (
                  <div className="relative space-y-4 pl-2">
                    <div className="absolute bottom-2 left-[19px] top-2 w-px bg-white/10" />
                    {activity.slice(0, 10).map((a: any, i: number) => (
                      <div key={a.id ?? i} className="relative flex items-start gap-3 animate-fadeInUp"
                        style={{ animationDelay: `${i * 40}ms` }}>
                        <div className="relative z-10">
                          <Avatar colour={a.avatar_colour} initials={a.avatar_initials} size={34} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-ink">
                              {a.agent_real || a.agent_name || 'Agent'}
                            </span>
                            {a.team && (
                              <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold capitalize"
                                style={{ background: `${TEAM_COLOUR[a.team] ?? '#7B8DA8'}1f`, color: TEAM_COLOUR[a.team] ?? '#7B8DA8' }}>
                                {a.team}
                              </span>
                            )}
                          </div>
                          {a.summary && <div className="truncate text-xs text-muted">{a.summary}</div>}
                          <div className="text-[11px] text-muted/70">{timeAgo(a.created_at)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {/* Agent comms — chat bubbles */}
              <Card className="p-5 animate-fadeInUp" style={{ animationDelay: '260ms' }}>
                <h2 className="mb-4 font-display text-sm font-semibold uppercase tracking-wider text-muted">
                  Agent comms
                </h2>
                {messages.length === 0 ? (
                  <EmptyState icon="forum" accent="#F59E0B" title="No messages" hint="Inter-agent messages appear here." />
                ) : (
                  <div className="space-y-3">
                    {messages.slice(0, 8).map((m, i) => {
                      const to = (m as any).to_real || m.to_name || 'someone';
                      return (
                        <div key={m.id ?? i} className="animate-fadeInUp" style={{ animationDelay: `${i * 40}ms` }}>
                          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
                            <span className="font-semibold text-ink">{m.from_real || m.from_name || 'System'}</span>
                            <Icon name="arrow_right_alt" size={14} />
                            <span className="font-semibold text-ink">{to}</span>
                            <span className="ml-auto text-muted/70">{timeAgo(m.created_at)}</span>
                          </div>
                          <div className="glass rounded-xl rounded-tl-sm px-3 py-2">
                            {m.subject && <div className="text-sm font-semibold text-ink">{m.subject}</div>}
                            {m.body && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{m.body}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            </div>

            {/* ── 8. Quick actions ───────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-2 animate-fadeInUp" style={{ animationDelay: '300ms' }}>
              <Button variant="glass" icon="cloud_sync" onClick={syncVault} loading={syncing}>Sync vault</Button>
              <Button variant="secondary" icon="refresh" onClick={() => load(true)} loading={refreshing}>Refresh now</Button>
              <span className="ml-auto text-xs text-muted">
                Updated {timeAgo(data.generated_at)} · auto-refreshing every 10s
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Command palette (⌘K) ─────────────────────────────────────── */}
      <Modal open={paletteOpen} onClose={() => setPaletteOpen(false)} width="max-w-md">
        <div className="p-4"
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); setPaletteOpen(false); }
            if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteIdx(i => Math.min(i + 1, paletteMatches.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteIdx(i => Math.max(i - 1, 0)); }
            if (e.key === 'Enter' && paletteMatches[paletteIdx]) runCommand(paletteMatches[paletteIdx]);
          }}>
          <div className="mb-3 flex items-center gap-2">
            <Icon name="terminal" size={18} className="text-accent" />
            <Input autoFocus placeholder="Type a command…" value={paletteQuery}
              onChange={e => { setPaletteQuery(e.target.value); setPaletteIdx(0); }} />
          </div>
          {paletteMatches.length === 0 ? (
            <div className="px-2 py-4 text-center text-sm text-muted">No matching commands</div>
          ) : (
            <div className="space-y-1">
              {paletteMatches.map((c, i) => (
                <button key={c.id} type="button" onClick={() => runCommand(c)}
                  onMouseEnter={() => setPaletteIdx(i)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors
                    ${i === paletteIdx ? 'bg-white/10 text-ink' : 'text-muted hover:bg-white/5'}`}>
                  <Icon name={c.icon} size={18} className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{c.label}</span>
                    <span className="block truncate text-[11px] text-muted">{c.hint}</span>
                  </span>
                  {i === paletteIdx && (
                    <kbd className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-muted">↵</kbd>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex items-center gap-3 border-t border-white/5 px-1 pt-2 font-mono text-[10px] text-muted/60">
            <span>↑↓ navigate</span><span>↵ run</span><span>esc close</span>
          </div>
        </div>
      </Modal>

      {/* ── Agent detail drawer ───────────────────────────────────────── */}
      <Drawer open={drawerId !== null} onClose={() => setDrawerId(null)} width="max-w-lg">
        <div className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-display text-lg font-semibold text-ink">Agent detail</h3>
            <button onClick={() => setDrawerId(null)} className="text-muted hover:text-ink"><Icon name="close" /></button>
          </div>

          {drawerLoading ? (
            <SkeletonList count={4} />
          ) : !drawerAgent ? (
            <EmptyState icon="smart_toy" accent="#F59E0B" title="Unavailable" hint="Could not load this agent." />
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Avatar colour={drawerAgent.avatar_colour} initials={drawerAgent.avatar_initials}
                  size={52} glow status={drawerAgent.last_status} />
                <div className="min-w-0">
                  <div className="truncate font-display text-lg font-bold text-ink">
                    {drawerAgent.real_name || drawerAgent.name}
                  </div>
                  <div className="truncate text-sm text-muted">{drawerAgent.role || drawerAgent.name}</div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-1.5">
                <Badge tone={STATUS_TONE[drawerAgent.last_status] ?? 'neutral'} dot>{drawerAgent.last_status}</Badge>
                {drawerAgent.team && (
                  <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize"
                    style={{
                      background: `${TEAM_COLOUR[drawerAgent.team] ?? '#7B8DA8'}1f`,
                      color: TEAM_COLOUR[drawerAgent.team] ?? '#7B8DA8',
                      borderColor: `${TEAM_COLOUR[drawerAgent.team] ?? '#7B8DA8'}40`,
                    }}>
                    {drawerAgent.team}
                  </span>
                )}
                <Badge tone={drawerAgent.enabled ? 'ok' : 'neutral'}>
                  {drawerAgent.enabled ? 'enabled' : 'disabled'}
                </Badge>
                {drawerAgent.tenant_name && <Badge tone="neutral">{drawerAgent.tenant_name}</Badge>}
              </div>

              {drawerAgent.last_summary && (
                <div className="mt-4 rounded-xl glass p-3 text-sm text-muted">{drawerAgent.last_summary}</div>
              )}
              <div className="mt-2 text-xs text-muted/70">Last run {timeAgo(drawerAgent.last_run_at)}</div>

              <h4 className="mb-2 mt-5 font-display text-xs font-semibold uppercase tracking-wider text-muted">
                Activity log
              </h4>
              {drawerLogs.length === 0 ? (
                <EmptyState icon="history" accent="#F59E0B" title="No log entries" />
              ) : (
                <div className="space-y-2">
                  {drawerLogs.slice(0, 30).map(l => (
                    <div key={l.id} className="rounded-xl border border-white/5 bg-black/20 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-ink">{l.action}</span>
                        <span className="shrink-0 text-[11px] text-muted/70">{timeAgo(l.created_at)}</span>
                      </div>
                      {l.summary && <div className="mt-0.5 text-xs text-muted">{l.summary}</div>}
                      {(l.token_count > 0 || l.cost_usd > 0) && (
                        <div className="mt-1 flex gap-3 text-[10px] text-muted/70">
                          <span>{l.token_count.toLocaleString()} tokens</span>
                          <span>${l.cost_usd.toFixed(4)}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </Drawer>
    </div>
  );
}
