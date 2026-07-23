// Max Gleam reporting dashboard — revenue, throughput, retention, crew
// performance and time tracking, all from GET /api/maxgleam/reports.
//
// The revenue chart is CSS bars, not a chart library: this is one series of
// 30 buckets, and a charting dependency would cost more than it earns.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState, Icon, SkeletonList, useToast } from '../../components/ui';
import {
  reportsApi, downloadCsv, gbp, gbpShort, hoursMins, clockTime, dayLabel,
  type ReportsData, type ReportKind, type TimeHistory,
} from '../../lib/reportsApi';

type Tab = 'overview' | 'crew' | 'time';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'monitoring' },
  { id: 'crew', label: 'Crew', icon: 'groups' },
  { id: 'time', label: 'Time', icon: 'schedule' },
];

const ACCENT = '#19C3E6';

// ── Building blocks ─────────────────────────────────────────────────────

function StatTile({ label, value, sub, icon, accent = ACCENT, delay = 0 }: {
  label: string; value: string; sub?: string; icon: string; accent?: string; delay?: number;
}) {
  return (
    <Card className="group p-3.5 sm:p-4 animate-fadeInUp transition-all duration-200 ease-out
        hover:-translate-y-0.5 hover:border-white/12 hover:shadow-[0_10px_32px_-10px_rgba(25,195,230,0.25)]"
      style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
          <div className="mt-1 truncate text-xl font-bold tabular-nums text-ink sm:text-2xl">{value}</div>
          {sub && <div className="mt-0.5 truncate text-[11px] text-muted/70">{sub}</div>}
        </div>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-transform duration-200 group-hover:scale-110 group-hover:-rotate-6"
          style={{ background: `${accent}1a`, color: accent, boxShadow: `0 0 20px -10px ${accent}66` }}>
          <Icon name={icon} size={19} />
        </span>
      </div>
    </Card>
  );
}

function SectionTitle({ children, count, accent = ACCENT, action }: {
  children: React.ReactNode; count?: number; accent?: string; action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wider text-muted">
        <span className="h-3.5 w-[3px] rounded-full" style={{ background: accent, boxShadow: `0 0 8px ${accent}88` }} />
        {children}
        {count !== undefined && (
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] tabular-nums text-muted">{count}</span>
        )}
      </h2>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function ExportButton({ report, label = 'CSV' }: { report: ReportKind; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button variant="ghost" icon="download" loading={busy} className="!px-2.5 !py-1.5 !text-[12px]"
      onClick={async () => {
        setBusy(true);
        try {
          await downloadCsv(report);
          toast(`${report} report downloaded`, 'ok');
        } catch (e) {
          toast(e instanceof Error ? e.message : 'Export failed', 'danger');
        } finally {
          setBusy(false);
        }
      }}>
      {label}
    </Button>
  );
}

// ── Revenue chart ───────────────────────────────────────────────────────
// One bar per day, height scaled to the peak day. Days with no revenue keep a
// hairline stub so the axis reads as a continuous 30 days rather than gaps.
function RevenueChart({ data }: { data: ReportsData }) {
  const { series, peak_pence } = data.revenue;
  const [hover, setHover] = useState<number | null>(null);
  const active = hover === null ? null : series[hover];

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            Revenue · last {data.window_days} days
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-ink">
            {gbp(data.revenue.total_pence)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-muted">
            {active ? dayLabel(active.date) : 'Peak day'}
          </div>
          <div className="font-mono text-sm font-semibold text-accent tabular-nums">
            {active ? `${gbp(active.revenue_pence)} · ${active.jobs} job${active.jobs === 1 ? '' : 's'}`
                    : gbp(peak_pence)}
          </div>
        </div>
      </div>

      <div className="flex h-40 items-end gap-[3px]" onMouseLeave={() => setHover(null)}>
        {series.map((d, i) => {
          const pct = peak_pence > 0 ? (d.revenue_pence / peak_pence) * 100 : 0;
          const on = hover === i;
          return (
            <button key={d.date} type="button"
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)}
              aria-label={`${d.date}: ${gbp(d.revenue_pence)}, ${d.jobs} jobs`}
              className="group relative flex h-full flex-1 items-end rounded-t transition-colors">
              <span
                className="w-full rounded-t transition-all duration-200"
                style={{
                  // 2px keeps an empty day visible as an axis tick.
                  height: `${Math.max(pct, d.revenue_pence > 0 ? 4 : 1.5)}%`,
                  background: d.revenue_pence > 0
                    ? `linear-gradient(180deg, ${ACCENT} 0%, ${ACCENT}55 100%)`
                    : 'rgba(255,255,255,0.08)',
                  boxShadow: on && d.revenue_pence > 0 ? `0 0 14px ${ACCENT}aa` : 'none',
                  opacity: hover === null || on ? 1 : 0.45,
                }} />
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex justify-between font-mono text-[10px] text-muted/60">
        <span>{series.length ? dayLabel(series[0].date) : ''}</span>
        <span>{gbpShort(peak_pence)} peak</span>
        <span>{series.length ? dayLabel(series[series.length - 1].date) : ''}</span>
      </div>
    </Card>
  );
}

// ── Tabs ────────────────────────────────────────────────────────────────

function Overview({ data }: { data: ReportsData }) {
  const r = data.retention;
  const overdue = data.overdue_signoffs;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Completed this week" value={String(data.jobs.completed_week)}
          sub={`since ${dayLabel(data.jobs.week_start)}`} icon="task_alt" accent="#22C55E" delay={0} />
        <StatTile label="Completed this month" value={String(data.jobs.completed_month)}
          sub={gbp(data.revenue.month_pence)} icon="calendar_month" accent={ACCENT} delay={60} />
        <StatTile label="Average job value" value={gbp(data.jobs.avg_value_pence)}
          sub={`${data.jobs.completed_window} jobs in ${data.window_days}d`} icon="payments"
          accent="#A78BFA" delay={120} />
        <StatTile label="Overdue sign-offs" value={String(overdue.count)}
          sub={`past ${overdue.auto_approve_hours}h window`} icon="draw"
          accent={overdue.count ? '#F43F5E' : '#22C55E'} delay={180} />
      </div>

      <div>
        <SectionTitle action={<ExportButton report="revenue" label="Revenue CSV" />}>Revenue</SectionTitle>
        <RevenueChart data={data} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <SectionTitle accent="#22C55E" action={<ExportButton report="retention" />}>
            Customer retention
          </SectionTitle>
          <Card className="p-4 sm:p-5">
            <div className="flex items-end gap-4">
              <div>
                <div className="text-4xl font-bold tabular-nums text-ink">{r.rate_pct}%</div>
                <div className="mt-1 text-[11px] text-muted">
                  cleaned in the last {r.window_weeks} weeks
                </div>
              </div>
              <div className="ml-auto text-right text-[11px] text-muted">
                <div><span className="font-semibold text-emerald tabular-nums">{r.cleaned_recently}</span> recent</div>
                <div><span className="font-semibold text-rose tabular-nums">{r.lapsed}</span> lapsed</div>
                <div><span className="font-semibold text-ink tabular-nums">{r.active_properties}</span> active</div>
              </div>
            </div>
            <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-white/6">
              <div className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.min(100, r.rate_pct)}%`,
                  background: `linear-gradient(90deg, #22C55E, ${ACCENT})`,
                  boxShadow: '0 0 14px rgba(34,197,94,0.5)',
                }} />
            </div>
            <div className="mt-2 text-[11px] text-muted/70">
              Recurring properties only — ad-hoc addresses are not on a round.
            </div>
          </Card>
        </div>

        <div>
          <SectionTitle accent="#F43F5E" count={overdue.count}
            action={<ExportButton report="overdue" />}>Overdue sign-offs</SectionTitle>
          <Card className="p-2">
            {overdue.jobs.length === 0 ? (
              <EmptyState icon="verified" accent="#22C55E" title="Nothing overdue"
                hint={`Every completed job has been signed off or auto-approved within ${overdue.auto_approve_hours}h.`} />
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto p-1">
                {overdue.jobs.map(j => (
                  <div key={j.job_id}
                    className="flex items-center gap-3 rounded-xl border border-white/6 bg-white/[0.02] p-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-ink">{j.address}</div>
                      <div className="text-[11px] text-muted">
                        {dayLabel(j.scheduled_date)}{j.crew_name ? ` · ${j.crew_name}` : ''}
                      </div>
                    </div>
                    <span className="text-sm font-semibold tabular-nums text-ink">{gbp(j.price_pence)}</span>
                    <Badge tone="danger">{j.days_overdue}d</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function CrewTab({ data }: { data: ReportsData }) {
  const top = data.top_crew;
  const best = Math.max(1, ...data.crew.map(c => c.jobs_completed));
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Top crew" value={top ? top.name : '—'}
          sub={top ? `${top.jobs_completed} jobs · ${gbp(top.revenue_pence)}` : 'no completed jobs yet'}
          icon="workspace_premium" accent="#F59E0B" delay={0} />
        <StatTile label="Average rating"
          value={data.ratings.average !== null ? `${data.ratings.average} / 5` : '—'}
          sub={`${data.ratings.rated} rated sign-off${data.ratings.rated === 1 ? '' : 's'}`}
          icon="star" accent="#F59E0B" delay={60} />
        <StatTile label="Active crew" value={String(data.crew.length)}
          sub={`over the last ${data.window_days} days`} icon="groups" accent={ACCENT} delay={120} />
        <StatTile label="Avg time on site" value={hoursMins(data.time.avg_minutes)}
          sub={`vs ${data.time.estimated_minutes}m estimated`} icon="timer" accent="#A78BFA" delay={180} />
      </div>

      <div>
        <SectionTitle count={data.crew.length} action={<ExportButton report="crew" />}>
          Crew performance
        </SectionTitle>
        <Card className="p-2">
          {data.crew.length === 0 ? (
            <EmptyState icon="groups" title="No crew activity"
              hint={`No jobs have been completed by a named crew member in the last ${data.window_days} days.`} />
          ) : (
            <div className="space-y-2 p-1">
              {data.crew.map((c, i) => (
                <div key={c.crew_id}
                  className="flex flex-col gap-2 rounded-xl border border-white/6 bg-white/[0.02] p-3
                    transition-colors hover:border-white/12 hover:bg-white/[0.05] sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[13px] font-bold tabular-nums"
                      style={{
                        background: i === 0 ? '#F59E0B22' : 'rgba(255,255,255,0.05)',
                        color: i === 0 ? '#F59E0B' : '#8B96A8',
                      }}>{i + 1}</span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-ink">{c.name}</div>
                      <div className="text-[11px] text-muted">
                        {c.signed_off} signed off
                        {c.logged_jobs > 0 && ` · ${c.logged_jobs} timed`}
                        {c.avg_minutes !== null && ` · ${hoursMins(c.avg_minutes)} avg`}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 sm:w-64">
                    <div className="min-w-0 flex-1">
                      <div className="h-1.5 overflow-hidden rounded-full bg-white/6">
                        <div className="h-full rounded-full"
                          style={{
                            width: `${(c.jobs_completed / best) * 100}%`,
                            background: `linear-gradient(90deg, ${ACCENT}, #A78BFA)`,
                          }} />
                      </div>
                      <div className="mt-1 text-[11px] tabular-nums text-muted">
                        {c.jobs_completed} job{c.jobs_completed === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-semibold tabular-nums text-ink">{gbp(c.revenue_pence)}</div>
                      <div className="text-[11px] tabular-nums text-amber">
                        {c.avg_rating !== null ? `★ ${c.avg_rating}` : '★ —'}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function TimeTab({ data }: { data: ReportsData }) {
  const toast = useToast();
  const [history, setHistory] = useState<TimeHistory | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setHistory(await reportsApi.history());
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load time entries', 'danger');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // An open clock keeps ticking, so refresh while someone is still on site.
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!history?.open_count) return;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [history?.open_count, load]);

  const variance = useMemo(() => {
    if (!data.time.avg_minutes) return null;
    return Math.round(data.time.avg_minutes - data.time.estimated_minutes);
  }, [data.time]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Clocked today"
          value={history ? `${history.summary.total_hours}h` : '—'}
          sub={`${history?.summary.completed ?? 0} completed entr${history?.summary.completed === 1 ? 'y' : 'ies'}`}
          icon="schedule" accent={ACCENT} delay={0} />
        <StatTile label="On the clock now" value={String(history?.open_count ?? 0)}
          sub={history?.open_count ? 'crew currently on site' : 'nobody clocked in'}
          icon="play_circle" accent={history?.open_count ? '#22C55E' : '#8B96A8'} delay={60} />
        <StatTile label="Avg per job (30d)" value={hoursMins(data.time.avg_minutes)}
          sub={`${data.time.logged_jobs} timed job${data.time.logged_jobs === 1 ? '' : 's'}`}
          icon="timer" accent="#A78BFA" delay={120} />
        <StatTile label="vs estimate"
          value={variance === null ? '—' : `${variance > 0 ? '+' : ''}${variance}m`}
          sub={`estimate is ${data.time.estimated_minutes}m per clean`}
          icon="balance"
          accent={variance === null ? '#8B96A8' : variance > 0 ? '#F43F5E' : '#22C55E'} delay={180} />
      </div>

      {history && history.by_crew.length > 0 && (
        <div>
          <SectionTitle accent="#22C55E">Today by crew</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {history.by_crew.map(c => (
              <Card key={c.crew_id} className="flex items-center gap-3 p-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
                  <Icon name="person" size={19} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-ink">{c.name}</div>
                  <div className="text-[11px] text-muted">{c.jobs} job{c.jobs === 1 ? '' : 's'}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold tabular-nums text-ink">{hoursMins(c.minutes)}</div>
                  {c.open && <Badge tone="ok" dot>live</Badge>}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionTitle count={history?.logs.length} accent="#A78BFA"
          action={<ExportButton report="time" />}>
          Today&rsquo;s entries
        </SectionTitle>
        <Card className="p-2">
          {loading ? <SkeletonList count={3} className="p-1" />
            : !history || history.logs.length === 0 ? (
              <EmptyState icon="schedule" title="No time logged today"
                hint="Crew clock in and out from the time clock at /timeclock." />
            ) : (
              <div className="space-y-2 p-1">
                {history.logs.map(l => {
                  const over = l.total_minutes !== null && l.total_minutes > l.estimated_minutes;
                  return (
                    <div key={l.id}
                      className="flex flex-col gap-2 rounded-xl border border-white/6 bg-white/[0.02] p-3
                        sm:flex-row sm:items-center sm:gap-4">
                      <div className="shrink-0 sm:w-36">
                        <div className="font-mono text-sm text-ink">
                          {clockTime(l.clock_in)} → {l.open ? '···' : clockTime(l.clock_out)}
                        </div>
                        <div className="text-[11px] text-muted">{l.crew_name || 'Unassigned'}</div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-ink">
                          {l.address || 'General duties'}
                        </div>
                        {l.notes && <div className="truncate text-[11px] text-muted/70">{l.notes}</div>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-sm font-semibold tabular-nums text-ink">
                          {hoursMins(l.elapsed_minutes)}
                        </span>
                        {l.open ? <Badge tone="ok" dot>running</Badge>
                          : <Badge tone={over ? 'warn' : 'neutral'}>
                              {over ? `+${l.total_minutes! - l.estimated_minutes}m` : 'on time'}
                            </Badge>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </Card>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────

export default function Reports() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<ReportsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    try {
      setData(await reportsApi.reports());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load reports');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent/10 text-accent"
          style={{ boxShadow: `0 0 28px -8px ${ACCENT}88` }}>
          <Icon name="monitoring" size={24} />
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold text-ink sm:text-2xl">Max Gleam reports</h1>
          <p className="text-[12px] text-muted">
            {data ? `Last ${data.window_days} days · updated ${clockTime(data.generated_at)}` : 'Loading…'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" icon="schedule" onClick={() => { window.location.href = '/timeclock'; }}>
            Time clock
          </Button>
          <Button variant="secondary" icon="refresh" loading={refreshing}
            onClick={() => load(true)}>Refresh</Button>
        </div>
      </header>

      <div className="flex gap-1 overflow-x-auto rounded-2xl border border-white/6 bg-white/[0.02] p-1">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition-all
              ${tab === t.id ? 'bg-accent/15 text-accent shadow-[0_0_18px_-8px_rgba(25,195,230,0.9)]'
                             : 'text-muted hover:bg-white/5 hover:text-ink'}`}>
            <Icon name={t.icon} size={17} />{t.label}
          </button>
        ))}
        <div className="ml-auto hidden shrink-0 items-center pr-1 sm:flex">
          <ExportButton report="jobs" label="Jobs CSV" />
        </div>
      </div>

      {loading ? <SkeletonList count={5} />
        : error ? (
          <EmptyState icon="error" accent="#F43F5E" title="Could not load reports" hint={error}
            action={<Button icon="refresh" onClick={() => load()}>Try again</Button>} />
        ) : data ? (
          tab === 'overview' ? <Overview data={data} />
            : tab === 'crew' ? <CrewTab data={data} />
            : <TimeTab data={data} />
        ) : null}
    </div>
  );
}
