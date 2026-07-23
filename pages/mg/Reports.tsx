// Max Gleam reporting dashboard — revenue, throughput, retention, crew
// performance and time tracking, all from GET /api/maxgleam/reports.
//
// The revenue chart is CSS bars, not a chart library: this is one series of
// 30 buckets, and a charting dependency would cost more than it earns.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, EmptyState, Icon, Input, Select, SkeletonList, useToast,
} from '../../components/ui';
import {
  reportsApi, downloadCsv, downloadActivityCsv, gbp, gbpShort, hoursMins,
  clockTime, dayLabel, timeAgo,
  invoicesApi, downloadTaxCsv, type TaxReport,
  type ReportsData, type ReportKind, type TimeHistory,
  type ActivityFeed, type ActorType, type AlertPreview, type AlertLogRow,
} from '../../lib/reportsApi';

type Tab = 'overview' | 'crew' | 'time' | 'tax' | 'activity' | 'alerts';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'monitoring' },
  { id: 'crew', label: 'Crew', icon: 'groups' },
  { id: 'time', label: 'Time', icon: 'schedule' },
  { id: 'tax', label: 'Tax', icon: 'account_balance' },
  { id: 'activity', label: 'Activity', icon: 'history' },
  { id: 'alerts', label: 'Alerts', icon: 'notifications_active' },
];

// How each activity action reads in the feed: icon + accent.
const ACTION_STYLE: Record<string, { icon: string; colour: string; label: string }> = {
  clock_in: { icon: 'play_circle', colour: '#22C55E', label: 'Clocked in' },
  clock_out: { icon: 'stop_circle', colour: '#F59E0B', label: 'Clocked out' },
  job_completed: { icon: 'task_alt', colour: '#22C55E', label: 'Completed job' },
  job_signed_off: { icon: 'draw', colour: '#19C3E6', label: 'Signed off' },
  office_action: { icon: 'admin_panel_settings', colour: '#A78BFA', label: 'Office action' },
  customer_comms: { icon: 'forum', colour: '#38BDF8', label: 'Customer comms' },
  alert_sent: { icon: 'mark_email_read', colour: '#19C3E6', label: 'Alert sent' },
  alert_failed: { icon: 'error', colour: '#F43F5E', label: 'Alert failed' },
};
const actionStyle = (action: string) =>
  ACTION_STYLE[action] || { icon: 'bolt', colour: '#8B96A8', label: action.replace(/_/g, ' ') };

const ACTOR_TONE: Record<ActorType, 'ok' | 'info' | 'violet' | 'warn' | 'neutral'> = {
  crew: 'ok', user: 'violet', partner: 'info', customer: 'warn', system: 'neutral',
};

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

// ── Activity tab ────────────────────────────────────────────────────────

function ActivityTab() {
  const toast = useToast();
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [actorType, setActorType] = useState('');
  const [action, setAction] = useState('');
  const [day, setDay] = useState('');
  const [exporting, setExporting] = useState(false);

  const filters = useMemo(() => ({
    actor_type: actorType || undefined,
    action: action || undefined,
    day: day || undefined,
  }), [actorType, action, day]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFeed(await reportsApi.activity({ ...filters, limit: 300 }));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load activity', 'danger');
    } finally {
      setLoading(false);
    }
  }, [filters, toast]);

  useEffect(() => { load(); }, [load]);

  // The action list comes from the unfiltered feed, so filtering by one
  // action does not empty the dropdown that got you there.
  const [allActions, setAllActions] = useState<string[]>([]);
  useEffect(() => {
    if (feed && !actorType && !action && !day) setAllActions(feed.actions);
  }, [feed, actorType, action, day]);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Events shown" value={String(feed?.count ?? 0)}
          sub={day ? dayLabel(day) : 'most recent first'} icon="history" delay={0} />
        <StatTile label="People active" value={String(feed?.by_actor.length ?? 0)}
          sub="distinct actors" icon="groups" accent="#A78BFA" delay={60} />
        <StatTile label="Event types" value={String(feed?.by_action.length ?? 0)}
          sub={feed?.by_action[0]?.action.replace(/_/g, ' ') || '—'}
          icon="category" accent="#22C55E" delay={120} />
        <StatTile label="Last event"
          value={feed?.activity[0] ? timeAgo(feed.activity[0].created_at) : '—'}
          sub={feed?.activity[0]?.actor_name || ''} icon="bolt" accent="#F59E0B" delay={180} />
      </div>

      <Card className="flex flex-wrap items-end gap-3 p-3.5">
        <div className="min-w-[9rem] flex-1">
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">Who</label>
          <Select value={actorType} onChange={e => setActorType(e.target.value)}>
            <option value="">Everyone</option>
            <option value="crew">Crew</option>
            <option value="user">Office</option>
            <option value="partner">Partner</option>
            <option value="customer">Customer</option>
            <option value="system">System</option>
          </Select>
        </div>
        <div className="min-w-[9rem] flex-1">
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">What</label>
          <Select value={action} onChange={e => setAction(e.target.value)}>
            <option value="">All actions</option>
            {(allActions.length ? allActions : feed?.actions || []).map(a => (
              <option key={a} value={a}>{actionStyle(a).label}</option>
            ))}
          </Select>
        </div>
        <div className="min-w-[9rem] flex-1">
          <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">Day</label>
          <Input type="date" value={day} onChange={e => setDay(e.target.value)} />
        </div>
        <div className="flex gap-2">
          {(actorType || action || day) && (
            <Button variant="ghost" icon="filter_alt_off"
              onClick={() => { setActorType(''); setAction(''); setDay(''); }}>Clear</Button>
          )}
          <Button variant="secondary" icon="download" loading={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                await downloadActivityCsv(filters);
                toast('Activity exported', 'ok');
              } catch (e) {
                toast(e instanceof Error ? e.message : 'Export failed', 'danger');
              } finally { setExporting(false); }
            }}>CSV</Button>
        </div>
      </Card>

      {feed && feed.by_actor.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {feed.by_actor.slice(0, 6).map(a => (
            <Card key={`${a.actor_type}:${a.actor_id}`} className="flex items-center gap-3 p-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/5 text-muted">
                <Icon name={a.actor_type === 'crew' ? 'directions_car'
                  : a.actor_type === 'user' ? 'person'
                  : a.actor_type === 'customer' ? 'home' : 'settings'} size={19} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-ink">{a.name}</div>
                <div className="text-[11px] text-muted">{timeAgo(a.last_at)}</div>
              </div>
              <Badge tone={ACTOR_TONE[a.actor_type] || 'neutral'}>{a.events}</Badge>
            </Card>
          ))}
        </div>
      )}

      <div>
        <SectionTitle count={feed?.count} accent="#A78BFA">Timeline</SectionTitle>
        <Card className="p-2">
          {loading ? <SkeletonList count={5} className="p-1" />
            : !feed || feed.activity.length === 0 ? (
              <EmptyState icon="history" title="No activity"
                hint="Nothing matches these filters. Clock-ins, completed jobs, sign-offs and alerts all land here." />
            ) : (
              <div className="relative space-y-1 p-1">
                {/* spine — the timeline rail the dots hang off */}
                <span className="absolute bottom-3 left-[26px] top-3 w-px bg-white/8" />
                {feed.activity.map(ev => {
                  const st = actionStyle(ev.action);
                  return (
                    <div key={ev.id}
                      className="relative flex items-start gap-3 rounded-xl p-2.5 transition-colors hover:bg-white/[0.04]">
                      <span className="relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full"
                        style={{ background: `${st.colour}1a`, color: st.colour,
                                 boxShadow: `0 0 0 3px var(--tw-ring-offset-color, #0B1220)` }}>
                        <Icon name={st.icon} size={17} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-sm font-medium text-ink">{st.label}</span>
                          {ev.actor_name && (
                            <span className="text-[12px] text-muted">by {ev.actor_name}</span>
                          )}
                          <Badge tone={ACTOR_TONE[ev.actor_type] || 'neutral'}>{ev.actor_type}</Badge>
                        </div>
                        {ev.detail && (
                          <div className="mt-0.5 truncate text-[12px] text-muted/80">{ev.detail}</div>
                        )}
                        {typeof ev.meta.total_minutes === 'number' && (
                          <div className="mt-0.5 text-[11px] text-muted/70">
                            {hoursMins(ev.meta.total_minutes as number)} on site
                            {typeof ev.meta.variance_minutes === 'number' && (
                              <span className={(ev.meta.variance_minutes as number) > 0 ? ' text-amber' : ' text-emerald'}>
                                {' '}({(ev.meta.variance_minutes as number) > 0 ? '+' : ''}
                                {ev.meta.variance_minutes as number}m vs estimate)
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[11px] tabular-nums text-muted">{timeAgo(ev.created_at)}</div>
                        <div className="font-mono text-[10px] text-muted/50">{clockTime(ev.created_at)}</div>
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

// ── Alerts tab ──────────────────────────────────────────────────────────

const SEVERITY_TONE: Record<string, 'info' | 'warn' | 'danger'> = {
  info: 'info', warn: 'warn', error: 'danger',
};

function AlertsTab() {
  const toast = useToast();
  const [preview, setPreview] = useState<AlertPreview | null>(null);
  const [history, setHistory] = useState<AlertLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'dry' | 'live' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, h] = await Promise.all([reportsApi.alerts(), reportsApi.alertHistory(50)]);
      setPreview(p);
      setHistory(h.alerts);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load alerts', 'danger');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const run = async (live: boolean) => {
    setBusy(live ? 'live' : 'dry');
    try {
      const r = await reportsApi.runAlerts({ dry_run: !live });
      toast(live ? `${r.sent} alert${r.sent === 1 ? '' : 's'} emailed`
                 : `Dry run: ${r.sent} would send, ${r.skipped} skipped`,
            r.failed ? 'danger' : 'ok');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Alert run failed', 'danger');
    } finally {
      setBusy(null);
      setConfirmLive(false);
    }
  };

  const firing = preview?.alerts.filter(a => a.would_send).length ?? 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Firing now" value={String(firing)}
          sub={`${preview?.alerts.length ?? 0} rules matched`} icon="notifications_active"
          accent={firing ? '#F59E0B' : '#22C55E'} delay={0} />
        <StatTile label="Email" value={preview?.mail_configured ? 'Configured' : 'Not set up'}
          sub={preview?.mail_from || 'no Resend key found'} icon="mail"
          accent={preview?.mail_configured ? '#22C55E' : '#F43F5E'} delay={60} />
        <StatTile label="Sent (recent)"
          value={String(history.filter(h => !h.dry_run && h.status === 'sent').length)}
          sub={`${history.filter(h => h.dry_run).length} dry runs logged`}
          icon="outgoing_mail" accent={ACCENT} delay={120} />
        <StatTile label="Schedule" value="Mon–Fri 07:30"
          sub="maxgleam-alerts.timer" icon="alarm" accent="#A78BFA" delay={180} />
      </div>

      <Card className="flex flex-wrap items-center gap-3 p-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">Run the sweep now</div>
          <div className="text-[12px] text-muted">
            A dry run evaluates everything and logs it without sending. Sending live
            respects each alert&rsquo;s cooldown so nothing goes out twice.
          </div>
        </div>
        <Button variant="secondary" icon="science" loading={busy === 'dry'}
          onClick={() => run(false)}>Dry run</Button>
        {confirmLive ? (
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setConfirmLive(false)}>Cancel</Button>
            <Button variant="danger" icon="send" loading={busy === 'live'}
              onClick={() => run(true)}>
              Yes, email {firing || 'them'}
            </Button>
          </div>
        ) : (
          <Button variant="primary" icon="send" disabled={!preview?.mail_configured || !firing}
            onClick={() => setConfirmLive(true)}>Send live</Button>
        )}
      </Card>

      <div>
        <SectionTitle count={preview?.alerts.length} accent="#F59E0B">Firing now</SectionTitle>
        {loading ? <SkeletonList count={3} />
          : !preview || preview.alerts.length === 0 ? (
            <Card className="p-2">
              <EmptyState icon="verified" accent="#22C55E" title="Nothing to report"
                hint="No alert rule matches the estate right now." />
            </Card>
          ) : (
            <div className="space-y-2">
              {preview.alerts.map(a => (
                <Card key={a.kind} className="overflow-hidden p-0">
                  <button onClick={() => setOpen(open === a.kind ? null : a.kind)}
                    className="flex w-full items-center gap-3 p-3.5 text-left transition-colors hover:bg-white/[0.04]">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
                      style={{
                        background: a.severity === 'info' ? `${ACCENT}1a` : '#F59E0B1a',
                        color: a.severity === 'info' ? ACCENT : '#F59E0B',
                      }}>
                      <Icon name={a.severity === 'info' ? 'summarize' : 'warning'} size={19} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-ink">{a.subject}</div>
                      <div className="text-[11px] text-muted">
                        {a.kind.replace(/_/g, ' ')} · to {a.recipients.join(', ') || 'nobody'}
                        {a.last_sent_at && ` · last sent ${timeAgo(a.last_sent_at)}`}
                      </div>
                    </div>
                    <Badge tone={a.would_send ? SEVERITY_TONE[a.severity] || 'info' : 'neutral'}>
                      {a.would_send ? 'will send' : `cooldown ${a.cooldown_hours}h`}
                    </Badge>
                    <Icon name={open === a.kind ? 'expand_less' : 'expand_more'}
                      size={20} className="shrink-0 text-muted" />
                  </button>
                  {open === a.kind && (
                    <pre className="max-h-72 overflow-auto border-t border-white/6 bg-black/20 p-4
                        font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
{a.body}
                    </pre>
                  )}
                </Card>
              ))}
            </div>
          )}
      </div>

      <div>
        <SectionTitle count={history.length} accent="#A78BFA">Alert history</SectionTitle>
        <Card className="p-2">
          {history.length === 0 ? (
            <EmptyState icon="outgoing_mail" title="Nothing sent yet"
              hint="The sweep runs weekday mornings. Anything it emails is logged here." />
          ) : (
            <div className="max-h-96 space-y-2 overflow-y-auto p-1">
              {history.map(h => (
                <div key={h.id}
                  className="flex items-center gap-3 rounded-xl border border-white/6 bg-white/[0.02] p-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                    style={{
                      background: h.status === 'failed' ? '#F43F5E1a'
                        : h.dry_run ? 'rgba(255,255,255,0.05)' : '#22C55E1a',
                      color: h.status === 'failed' ? '#F43F5E' : h.dry_run ? '#8B96A8' : '#22C55E',
                    }}>
                    <Icon name={h.status === 'failed' ? 'error'
                      : h.dry_run ? 'science' : 'mark_email_read'} size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">{h.subject}</div>
                    <div className="truncate text-[11px] text-muted">
                      {h.recipients.join(', ') || 'no recipients'}
                      {h.error && <span className="text-rose"> · {h.error}</span>}
                    </div>
                  </div>
                  {h.dry_run && <Badge tone="neutral">dry run</Badge>}
                  <span className="shrink-0 text-[11px] tabular-nums text-muted">
                    {timeAgo(h.sent_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}


// ── Tax ─────────────────────────────────────────────────────────────────
/** Current month as YYYY-MM. */
const thisMonth = () => new Date().toISOString().slice(0, 7);

/** N months back from now as YYYY-MM. */
function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 7);
}

const RANGE_PRESETS: { label: string; from: () => string; to: () => string }[] = [
  { label: 'This month', from: thisMonth, to: thisMonth },
  { label: 'Last 3 months', from: () => monthsAgo(2), to: thisMonth },
  { label: 'Last 12 months', from: () => monthsAgo(11), to: thisMonth },
  { label: 'This year', from: () => `${new Date().getFullYear()}-01`, to: thisMonth },
];

function TaxTab() {
  const toast = useToast();
  const [from, setFrom] = useState(monthsAgo(2));
  const [to, setTo] = useState(thisMonth());
  const [data, setData] = useState<TaxReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true);
    try {
      setData(await invoicesApi.tax(f, t));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not load the tax report', 'danger');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(from, to); }, [load, from, to]);

  const download = async () => {
    setDownloading(true);
    try {
      await downloadTaxCsv(from, to);
      toast('Tax report downloaded', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Download failed', 'danger');
    } finally {
      setDownloading(false);
    }
  };

  const t = data?.totals;
  const peak = Math.max(1, ...(data?.by_month || []).map(m => m.gross_pence));

  return (
    <div className="space-y-5">
      {/* Range picker */}
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">From</label>
          <input type="month" value={from} max={to} onChange={e => setFrom(e.target.value)}
            className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink
              focus:border-accent/50 focus:outline-none" />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">To</label>
          <input type="month" value={to} min={from} onChange={e => setTo(e.target.value)}
            className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink
              focus:border-accent/50 focus:outline-none" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {RANGE_PRESETS.map(p => (
            <button key={p.label}
              onClick={() => { setFrom(p.from()); setTo(p.to()); }}
              className="rounded-lg border border-white/8 px-2.5 py-1.5 text-[12px] text-muted
                transition-colors hover:border-accent/30 hover:text-ink">
              {p.label}
            </button>
          ))}
        </div>
        <Button variant="primary" icon="download" loading={downloading} onClick={download}
          className="ml-auto">
          Download CSV
        </Button>
      </Card>

      {/* VAT status — the single most important caveat on this page */}
      {data && !data.vat_registered && (
        <Card className="flex flex-wrap items-start gap-3 border-amber/25 bg-amber/5 p-3.5">
          <Icon name="info" size={20} className="mt-0.5 shrink-0 text-amber" />
          <div className="min-w-0 flex-1 text-sm text-ink">
            <span className="font-semibold">Not VAT registered.</span>{' '}
            No VAT has been charged on any invoice, so VAT collected is £0. The
            &ldquo;if registered&rdquo; figure below is what 20% would come to on this
            revenue — it is a planning number, not a liability.
          </div>
        </Card>
      )}

      {loading && !data ? <SkeletonList count={3} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Revenue (gross)" icon="payments"
              value={gbp(t?.revenue_gross_pence || 0)}
              sub={`${t?.invoice_count ?? 0} invoices`} />
            <StatTile label={data?.vat_registered ? 'VAT charged' : 'VAT at 20% if registered'}
              icon="account_balance" accent="#A78BFA" delay={60}
              value={gbp(data?.vat_registered
                ? (t?.vat_pence || 0) : (t?.notional_vat_at_20_pence || 0))}
              sub={data?.vat_registered ? `at ${data.vat_rate}%` : 'not charged'} />
            <StatTile label="Paid" icon="check_circle" accent="#22C55E" delay={120}
              value={gbp(t?.paid_pence || 0)} sub="settled" />
            <StatTile label="Unpaid" icon="schedule" accent="#F59E0B" delay={180}
              value={gbp(t?.unpaid_pence || 0)} sub="outstanding" />
          </div>

          <Card className="p-4">
            <SectionTitle count={data?.by_month.length}>Month by month</SectionTitle>
            {!data?.by_month.length ? (
              <EmptyState icon="account_balance" title="No invoices in this range"
                hint="Pick a wider range, or raise invoices from the Invoices page." />
            ) : (
              <div className="space-y-2">
                {data.by_month.map(m => (
                  <div key={m.month} className="flex items-center gap-3">
                    <span className="w-16 shrink-0 font-mono text-[12px] text-muted">{m.month}</span>
                    <div className="h-7 min-w-0 flex-1 overflow-hidden rounded-lg bg-white/[0.03]">
                      <div className="h-full rounded-lg transition-all duration-500"
                        style={{ width: `${Math.max(3, (m.gross_pence / peak) * 100)}%`,
                          background: `linear-gradient(90deg, ${ACCENT}55, ${ACCENT})` }} />
                    </div>
                    <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums text-ink">
                      {gbp(m.gross_pence)}
                    </span>
                    <span className="hidden w-16 shrink-0 text-right text-[11px] tabular-nums text-muted sm:block">
                      {m.count} inv
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {!!data?.invoices.length && (
            <Card className="p-4">
              <SectionTitle count={data.invoices.length}>Invoices in range</SectionTitle>
              <div className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-muted">
                      <th className="px-1 pb-2 font-semibold">Number</th>
                      <th className="px-1 pb-2 font-semibold">Issued</th>
                      <th className="px-1 pb-2 font-semibold">Customer</th>
                      <th className="px-1 pb-2 text-right font-semibold">Net</th>
                      <th className="px-1 pb-2 text-right font-semibold">VAT</th>
                      <th className="px-1 pb-2 text-right font-semibold">Gross</th>
                      <th className="px-1 pb-2 text-right font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.invoices.map(i => (
                      <tr key={i.id} className="border-t border-white/5 transition-colors hover:bg-white/[0.03]">
                        <td className="px-1 py-2 font-mono text-[12px] text-ink">{i.number}</td>
                        <td className="px-1 py-2 text-[12px] text-muted">
                          {new Date(i.issued_at * 1000).toLocaleDateString('en-GB')}
                        </td>
                        <td className="max-w-[160px] truncate px-1 py-2 text-[12px] text-ink">
                          {i.customer_name || '—'}
                        </td>
                        <td className="px-1 py-2 text-right tabular-nums text-muted">{gbp(i.net_pence)}</td>
                        <td className="px-1 py-2 text-right tabular-nums text-muted">{gbp(i.vat_pence)}</td>
                        <td className="px-1 py-2 text-right font-semibold tabular-nums text-ink">
                          {gbp(i.amount_pence)}
                        </td>
                        <td className="px-1 py-2 text-right">
                          <Badge tone={i.display_status === 'paid' ? 'ok'
                            : i.display_status === 'overdue' ? 'danger' : 'warn'}>
                            {i.display_status}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
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

      {/* Tax fetches its own data, so it stays available even if the main
          reports payload fails to load. */}
      {tab === 'tax' ? <TaxTab />
        : loading ? <SkeletonList count={5} />
        : error ? (
          <EmptyState icon="error" accent="#F43F5E" title="Could not load reports" hint={error}
            action={<Button icon="refresh" onClick={() => load()}>Try again</Button>} />
        ) : data ? (
          tab === 'overview' ? <Overview data={data} />
            : tab === 'crew' ? <CrewTab data={data} />
            : tab === 'time' ? <TimeTab data={data} />
            : tab === 'activity' ? <ActivityTab />
            : <AlertsTab />
        ) : null}
    </div>
  );
}
