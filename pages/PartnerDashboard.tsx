// Partner portal dashboard — jobs, work requests and payment status for a
// single partner company. Standalone shell (no AGENT OS sidebar): partners
// only ever see their own estate.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Card, EmptyState, Icon, Input, Select, SkeletonList, Textarea, useToast,
} from '../components/ui';
import {
  partnerApi, clearPartnerToken, gbp, prettyDate, titleCase,
  type Partner, type PartnerJob, type PartnerJobs, type PartnerPayments,
  type PartnerProperty, type WorkRequest, type SignoffJob, type SignoffStatus,
  type OptimizedRoute, type RouteStop, type Crew, type Referrals,
} from '../lib/partnerApi';

type Tab = 'jobs' | 'route' | 'signoffs' | 'requests' | 'payments';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'jobs', label: 'Jobs', icon: 'event_available' },
  { id: 'route', label: 'Route', icon: 'route' },
  { id: 'signoffs', label: 'Sign-offs', icon: 'draw' },
  { id: 'requests', label: 'Work requests', icon: 'add_task' },
  { id: 'payments', label: 'Payments', icon: 'receipt_long' },
];

const REQUEST_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'violet'> = {
  pending: 'warn', accepted: 'info', scheduled: 'info',
  in_progress: 'violet', completed: 'ok', declined: 'danger',
};
const PRIORITY_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  low: 'neutral', normal: 'info', high: 'warn', urgent: 'danger',
};

// ── Kebab (⋯) menu ──────────────────────────────────────────────────────
// Click-to-open, closes on outside tap or Escape. Kept local to this file —
// it is the only surface that needs one, and the AGENT OS kit has no menu
// primitive. On phones the list is a bottom sheet (thumb-reachable, never
// clipped by the row it hangs off); from `sm` up it is a right-aligned
// dropdown. The trigger keeps a 44px touch target regardless of its visual
// size so it clears the Apple/Android minimum.
interface KebabItem {
  label: string;
  icon: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

function KebabMenu({ items, label = 'Job actions', title = 'Job actions' }:
  { items: KebabItem[]; label?: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // pointerdown covers mouse and touch in one listener.
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label}
        onClick={() => setOpen(o => !o)}
        className={`grid h-11 w-11 place-items-center rounded-lg border border-white/8 text-muted
          transition-colors hover:border-white/16 hover:bg-white/5 hover:text-ink
          sm:h-8 sm:w-8 ${open ? 'bg-white/5 text-ink' : ''}`}>
        <Icon name="more_vert" size={18} />
      </button>

      {open && (
        <>
          {/* Scrim — phones only; the dropdown needs no backdrop */}
          <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] sm:hidden"
            aria-hidden onClick={() => setOpen(false)} />
          <div role="menu"
            className="fixed inset-x-0 bottom-0 z-50 overflow-hidden rounded-t-2xl border-t border-white/10
              bg-surface/95 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]
              shadow-[0_-12px_40px_-8px_rgba(0,0,0,0.6)] backdrop-blur-xl
              animate-[fadeInUp_0.16s_ease-out_both]
              sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:mt-1 sm:w-44 sm:rounded-xl
              sm:border sm:pb-2 sm:shadow-[0_12px_40px_-8px_rgba(0,0,0,0.6)]">
            {/* Sheet header — phones only: grabber + title */}
            <div className="mb-1 sm:hidden">
              <span className="mx-auto mb-2 block h-1 w-9 rounded-full bg-white/15" />
              <span className="block truncate px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</span>
            </div>
            {items.map(item => (
              <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
                onClick={() => { setOpen(false); item.onClick(); }}
                className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-3 text-left text-sm
                  transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:gap-2.5 sm:py-2
                  ${item.danger ? 'text-rose hover:bg-rose/10' : 'text-ink hover:bg-white/6'}`}>
                <Icon name={item.icon} size={18} className={item.danger ? 'text-rose' : 'text-muted'} />
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Job row ─────────────────────────────────────────────────────────────
type JobPanel = 'none' | 'details' | 'reschedule' | 'assign' | 'cancel';

function JobRow({ job, tone, crews, onChanged }: {
  job: PartnerJob; tone: 'upcoming' | 'done' | 'overdue';
  crews?: Crew[]; onChanged?: () => void;
}) {
  const toast = useToast();
  const accent = tone === 'done' ? '#22C55E' : tone === 'overdue' ? '#F43F5E' : '#19C3E6';
  const [panel, setPanel] = useState<JobPanel>('none');
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState(job.scheduled_date);
  const [crewId, setCrewId] = useState<string>('');

  // A done or cancelled job is closed: the office can look but not move it.
  const locked = job.status === 'done' || job.status === 'cancelled';
  const canAct = !!onChanged && !locked;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'ok');
      setPanel('none');
      onChanged?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That didn’t work', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const items: KebabItem[] = [
    { label: 'View details', icon: 'info',
      onClick: () => setPanel(p => (p === 'details' ? 'none' : 'details')) },
  ];
  if (canAct) {
    items.push(
      { label: 'Reschedule', icon: 'event',
        onClick: () => { setDate(job.scheduled_date); setPanel('reschedule'); } },
      { label: 'Assign crew', icon: 'group',
        onClick: () => { setCrewId(''); setPanel('assign'); } },
      { label: 'Cancel job', icon: 'cancel', danger: true,
        onClick: () => setPanel('cancel') },
    );
  }

  return (
    <div className="group relative rounded-xl border border-white/6 bg-white/[0.02] transition-colors hover:border-white/12 hover:bg-white/[0.05]">
      <div className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4">
        <span className="absolute bottom-3 left-0 top-3 w-[3px] rounded-r-full"
          style={{ background: accent, boxShadow: `0 0 10px ${accent}88` }} />
        <div className="shrink-0 pl-2.5 sm:w-32">
          <div className="text-sm font-semibold text-ink">{prettyDate(job.scheduled_date)}</div>
          <div className="font-mono text-[11px] text-muted/70">{job.scheduled_date}</div>
        </div>
        <div className="min-w-0 flex-1 pl-2.5 sm:pl-0">
          <div className="truncate text-sm font-medium text-ink">{job.address}</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
            {job.postcode && <span className="font-mono">{job.postcode}</span>}
            {job.customer_name && <span className="truncate">· {job.customer_name}</span>}
            {job.crew_name && (
              <span className="flex items-center gap-1">
                <Icon name="person" size={12} />{job.crew_name}
              </span>
            )}
          </div>
          {job.access_notes && (
            <div className="mt-1 flex items-start gap-1 text-[11px] text-amber/80">
              <Icon name="key" size={12} className="mt-px shrink-0" />
              <span className="line-clamp-2">{job.access_notes}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-2.5 sm:pl-0">
          <span className="text-sm font-semibold tabular-nums text-ink">{gbp(job.price_pence)}</span>
          <Badge tone={job.status === 'cancelled' ? 'neutral'
            : tone === 'done' ? 'ok' : tone === 'overdue' ? 'danger' : 'info'}>
            {tone === 'overdue' && job.status !== 'cancelled' ? 'Overdue' : titleCase(job.status)}
          </Badge>
          <KebabMenu items={items} title={job.address || 'Job actions'} />
        </div>
      </div>

      {/* Inline action panels — one at a time, below the row */}
      {panel === 'details' && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/6 px-4 py-3 text-[12px] sm:grid-cols-3">
          <Detail label="Status" value={titleCase(job.status)} />
          <Detail label="Scheduled" value={prettyDate(job.scheduled_date)} />
          <Detail label="Price" value={gbp(job.price_pence)} />
          <Detail label="Crew" value={job.crew_name || 'Unassigned'} />
          <Detail label="Customer" value={job.customer_name || '—'} />
          <Detail label="Sign-off" value={job.signoff_status ? titleCase(job.signoff_status) : 'Not requested'} />
          {job.access_notes && <div className="col-span-2 sm:col-span-3"><Detail label="Access" value={job.access_notes} /></div>}
          {job.notes && <div className="col-span-2 sm:col-span-3"><Detail label="Notes" value={job.notes} /></div>}
        </div>
      )}

      {panel === 'reschedule' && (
        <div className="flex flex-col gap-3 border-t border-white/6 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="w-full sm:w-auto">
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">New date</label>
            <Input type="date" value={date} min={new Date().toISOString().slice(0, 10)}
              onChange={e => setDate(e.target.value)} className="w-full sm:!w-auto" />
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button variant="primary" icon="event_available" loading={busy}
              disabled={!date || date === job.scheduled_date}
              onClick={() => run(() => partnerApi.rescheduleJob(job.id, date),
                `Moved to ${prettyDate(date)}`)}
              className="flex-1 sm:flex-none">
              Save
            </Button>
            <Button variant="ghost" onClick={() => setPanel('none')} className="flex-1 sm:flex-none">Cancel</Button>
          </div>
        </div>
      )}

      {panel === 'assign' && (
        <div className="flex flex-col gap-3 border-t border-white/6 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="w-full sm:w-auto">
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">Crew</label>
            <Select value={crewId} onChange={e => setCrewId(e.target.value)} className="w-full sm:w-auto">
              <option value="">Unassign</option>
              {(crews || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button variant="primary" icon="group" loading={busy}
              onClick={() => run(
                () => partnerApi.assignJob(job.id, crewId ? Number(crewId) : null),
                crewId ? 'Crew assigned' : 'Crew removed')}
              className="flex-1 sm:flex-none">
              Save
            </Button>
            <Button variant="ghost" onClick={() => setPanel('none')} className="flex-1 sm:flex-none">Cancel</Button>
          </div>
        </div>
      )}

      {panel === 'cancel' && (
        <div className="flex flex-col gap-3 border-t border-rose/20 bg-rose/[0.04] px-4 py-3
          sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex items-start gap-2">
            <Icon name="warning" size={18} className="mt-px shrink-0 text-rose" />
            <span className="flex-1 text-[12px] text-muted sm:flex-none">
              Cancel this clean at {job.address}? The crew and customer keep their record; the job stops being scheduled.
            </span>
          </div>
          <div className="flex w-full gap-2 sm:ml-auto sm:w-auto">
            <Button variant="danger" icon="cancel" loading={busy}
              onClick={() => run(() => partnerApi.cancelJob(job.id), 'Job cancelled')}
              className="flex-1 sm:flex-none">
              Cancel job
            </Button>
            <Button variant="ghost" onClick={() => setPanel('none')} className="flex-1 sm:flex-none">Keep it</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted/70">{label}</div>
      <div className="truncate text-[12px] text-ink" title={value}>{value}</div>
    </div>
  );
}

function StatTile({ label, value, sub, icon, accent, delay = 0 }:
  { label: string; value: string; sub?: string; icon: string; accent: string; delay?: number }) {
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

function SectionTitle({ children, count, accent = '#19C3E6' }:
  { children: React.ReactNode; count?: number; accent?: string }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wider text-muted">
      <span className="h-3.5 w-[3px] rounded-full" style={{ background: accent, boxShadow: `0 0 8px ${accent}88` }} />
      {children}
      {count !== undefined && (
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] tabular-nums text-muted">{count}</span>
      )}
    </h2>
  );
}

// ── Work request form ───────────────────────────────────────────────────
function WorkRequestForm({ properties, serviceTypes, priorities, onSubmitted }: {
  properties: PartnerProperty[];
  serviceTypes: string[];
  priorities: string[];
  onSubmitted: () => void;
}) {
  const toast = useToast();
  const [propertyId, setPropertyId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [serviceType, setServiceType] = useState('window_cleaning');
  const [priority, setPriority] = useState('normal');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  const shortlist = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? properties.filter(p =>
          p.address.toLowerCase().includes(q) ||
          (p.postcode || '').toLowerCase().includes(q) ||
          (p.customer_name || '').toLowerCase().includes(q))
      : properties;
    return list.slice(0, 200);
  }, [properties, filter]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { toast('Give the request a short title', 'danger'); return; }
    setBusy(true);
    try {
      await partnerApi.submitWorkRequest({
        title: title.trim(),
        description: description.trim(),
        property_id: propertyId ? Number(propertyId) : null,
        service_type: serviceType,
        priority,
      });
      toast('Work request submitted', 'ok');
      setTitle(''); setDescription(''); setPropertyId(''); setPriority('normal');
      onSubmitted();
    } catch (err: any) {
      toast(err?.message || 'Could not submit request', 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4 sm:p-5">
      <SectionTitle accent="#22C55E">Submit a work request</SectionTitle>
      <form onSubmit={submit} className="space-y-3.5">
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-muted">Property</label>
          {properties.length > 8 && (
            <Input value={filter} onChange={e => setFilter(e.target.value)}
              placeholder="Filter by address, postcode or customer" className="mb-2" />
          )}
          <Select value={propertyId} onChange={e => setPropertyId(e.target.value)} className="w-full py-2">
            <option value="">No specific property (general request)</option>
            {shortlist.map(p => (
              <option key={p.id} value={p.id}>
                {p.address}{p.postcode ? ` — ${p.postcode}` : ''}
              </option>
            ))}
          </Select>
          {filter && (
            <div className="mt-1 text-[11px] text-muted/70">
              {shortlist.length} of {properties.length} properties match
            </div>
          )}
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-semibold text-muted">Title</label>
          <Input value={title} onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Full exterior clean before reopening" maxLength={120} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-muted">Service</label>
            <Select value={serviceType} onChange={e => setServiceType(e.target.value)} className="w-full py-2">
              {serviceTypes.map(s => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-muted">Priority</label>
            <Select value={priority} onChange={e => setPriority(e.target.value)} className="w-full py-2">
              {priorities.map(p => <option key={p} value={p}>{titleCase(p)}</option>)}
            </Select>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs font-semibold text-muted">Describe the work</label>
          <Textarea rows={4} value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Access arrangements, scope, deadlines, anything the crew should know." />
        </div>

        <Button type="submit" variant="primary" icon="send" loading={busy} className="w-full sm:w-auto">
          Submit request
        </Button>
      </form>
    </Card>
  );
}

// ── Sign-off row ────────────────────────────────────────────────────────
function SignoffRow({ job, onSend, tone }:
  { job: SignoffJob; onSend?: (j: SignoffJob) => Promise<void>; tone: 'pending' | 'overdue' | 'done' }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const accent = tone === 'overdue' ? '#F43F5E' : tone === 'done' ? '#22C55E' : '#F59E0B';
  return (
    <div className="relative flex flex-col gap-2 rounded-xl border border-white/6 bg-white/[0.02] p-3 transition-colors duration-200 hover:border-white/12 hover:bg-white/[0.05] sm:flex-row sm:items-center sm:gap-4">
      <span className="absolute bottom-3 left-0 top-3 w-[3px] rounded-r-full"
        style={{ background: accent, boxShadow: `0 0 10px ${accent}88` }} />
      <div className="shrink-0 pl-2.5 sm:w-28">
        <div className="text-sm font-semibold text-ink">{prettyDate(job.scheduled_date)}</div>
        <div className="font-mono text-[11px] text-muted/70">{job.ref}</div>
      </div>
      <div className="min-w-0 flex-1 pl-2.5 sm:pl-0">
        <div className="truncate text-sm font-medium text-ink">{job.address}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          {job.customer_name && <span className="truncate">{job.customer_name}</span>}
          {job.crew_name && <span>· {job.crew_name}</span>}
          {job.rating ? <span className="text-amber">{'★'.repeat(job.rating)}</span> : null}
        </div>
        {job.signoff_note && (
          <div className="mt-1 line-clamp-2 text-[11px] italic text-muted/80">"{job.signoff_note}"</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-2.5 sm:pl-0">
        <Badge tone={tone === 'overdue' ? 'danger' : tone === 'done' ? 'ok' : 'warn'}>
          {job.signoff_status === 'signed' ? 'Signed'
            : job.signoff_status === 'auto-approved' ? 'Auto-approved'
            : job.signoff_status === 'sent' ? 'Link sent' : 'Not sent'}
        </Badge>
        {onSend && (
          <Button variant="secondary" icon="sms" loading={busy}
            onClick={async () => {
              setBusy(true);
              try { await onSend(job); } catch (e: any) { toast(e?.message || 'Could not send', 'danger'); }
              setBusy(false);
            }}>
            {job.signoff_status === 'sent' ? 'Resend' : 'Send link'}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Route planner ───────────────────────────────────────────────────────
// The day's jobs ordered by nearest-neighbour, with drive time between stops.
// Every figure is an estimate (see `assumptions` on the response) and the UI
// says so — these are not routed distances from a mapping provider.
const hhmm = (mins: number) => {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

function RouteStopRow({ stop, last }: { stop: RouteStop; last: boolean }) {
  const accent = stop.routable ? '#19C3E6' : '#F59E0B';
  return (
    <div className="relative flex gap-3 pl-1">
      {/* Timeline spine */}
      <div className="flex shrink-0 flex-col items-center">
        <span className="grid h-7 w-7 place-items-center rounded-full border text-[11px] font-bold tabular-nums"
          style={{ background: `${accent}1a`, borderColor: `${accent}59`, color: accent }}>
          {stop.position}
        </span>
        {!last && <span className="w-px flex-1 bg-gradient-to-b from-white/15 to-white/5" />}
      </div>

      <div className="min-w-0 flex-1 pb-3">
        <div className="rounded-xl border border-white/6 bg-white/[0.02] p-3 transition-colors hover:border-white/12 hover:bg-white/[0.05]">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-ink">{stop.address}</div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                {stop.postcode && <span className="font-mono">{stop.postcode}</span>}
                {stop.customer_name && <span className="truncate">· {stop.customer_name}</span>}
              </div>
            </div>
            <div className="shrink-0 text-right">
              {stop.routable ? (
                <>
                  <div className="font-mono text-sm font-semibold tabular-nums text-accent">
                    {stop.estimated_time}
                  </div>
                  <div className="text-[10px] text-muted/60">
                    leaves {stop.estimated_depart}
                  </div>
                </>
              ) : (
                <Badge tone="warn">No coordinates</Badge>
              )}
            </div>
          </div>

          {stop.access_notes && (
            <div className="mt-1.5 flex items-start gap-1 text-[11px] text-amber/80">
              <Icon name="key" size={12} className="mt-px shrink-0" />
              <span className="line-clamp-2">{stop.access_notes}</span>
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">{gbp(stop.price_pence)}</Badge>
            <Badge tone={stop.status === 'done' ? 'ok' : 'info'}>{titleCase(stop.status)}</Badge>
            {stop.lat != null && stop.lng != null && (
              <a href={`https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lng}`}
                target="_blank" rel="noreferrer"
                className="ml-auto flex items-center gap-1 text-[11px] text-accent hover:underline">
                <Icon name="map" size={13} />Open in Maps
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RouteTab({ colour }: { colour: string }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [crewId, setCrewId] = useState('');
  const [crews, setCrews] = useState<Crew[]>([]);
  const [route, setRoute] = useState<OptimizedRoute | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    partnerApi.crews().then(r => setCrews(r.crews || [])).catch(() => { /* picker stays empty */ });
  }, []);

  const loadRoute = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setRoute(await partnerApi.route(date, crewId ? Number(crewId) : null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the route');
      setRoute(null);
    }
    setBusy(false);
  }, [date, crewId]);

  useEffect(() => { loadRoute(); }, [loadRoute]);

  const shiftDay = (days: number) => {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + days);
    setDate(d.toISOString().slice(0, 10));
  };

  return (
    <div className="space-y-5">
      {/* Controls */}
      <Card className="p-3.5">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex items-end gap-1">
            <Button variant="ghost" icon="chevron_left" onClick={() => shiftDay(-1)} />
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">
                Date
              </label>
              <Input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="[color-scheme:dark]" />
            </div>
            <Button variant="ghost" icon="chevron_right" onClick={() => shiftDay(1)} />
          </div>
          <div className="min-w-[10rem] flex-1">
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted">
              Crew
            </label>
            <Select value={crewId} onChange={e => setCrewId(e.target.value)}>
              <option value="">All crews</option>
              {crews.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <Button variant="secondary" icon="refresh" onClick={loadRoute} loading={busy}>
            Optimise
          </Button>
        </div>
      </Card>

      {error && (
        <Card className="border-rose/30 p-3 text-sm text-rose">{error}</Card>
      )}

      {busy && !route ? <SkeletonList count={4} /> : !route || route.stop_count === 0 ? (
        <EmptyState icon="route" title="No jobs on this date"
          hint="Pick another date, or clear the crew filter to see the whole day." />
      ) : (
        <>
          {/* Day summary */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Stops" icon="pin_drop" accent="#19C3E6"
              value={String(route.stop_count)}
              sub={route.unroutable_count
                ? `${route.unroutable_count} without coordinates`
                : `${gbp(route.value_pence)} of work`} />
            <StatTile label="Driving" icon="directions_car" accent="#A78BFA" delay={60}
              value={`${route.total_distance_km} km`}
              sub={`${hhmm(route.total_drive_time_min)} on the road`} />
            <StatTile label="On site" icon="cleaning_services" accent="#22C55E" delay={120}
              value={hhmm(route.total_service_time_min)}
              sub={`${route.assumptions.service_minutes} min per clean`} />
            <StatTile label="Day ends" icon="schedule" accent="#F59E0B" delay={180}
              value={route.finish_estimate || '—'}
              sub={`from a ${route.day_start} start`} />
          </div>

          <section>
            <SectionTitle count={route.stop_count} accent={colour}>
              {route.crew_name ? `${route.crew_name} — ` : ''}{prettyDate(route.date)}
            </SectionTitle>

            <div className="rounded-2xl border border-white/6 bg-white/[0.02] p-3">
              {route.stops.map((s, i) => (
                <div key={s.job_id} className="animate-fadeInUp"
                  style={{ animationDelay: `${Math.min(i * 60, 480)}ms` }}>
                  <RouteStopRow stop={s} last={i === route.stops.length - 1} />
                  {/* Leg to the following stop, drawn between the two rows */}
                  {i < route.stops.length - 1 && route.stops[i + 1].routable
                    && route.stops[i + 1].drive_minutes_from_previous != null && (
                    <div className="mb-1 ml-[38px] flex items-center gap-1.5 text-[11px] text-muted/70">
                      <Icon name="south" size={12} />
                      <span className="tabular-nums">
                        {route.stops[i + 1].drive_km_from_previous} km ·{' '}
                        {route.stops[i + 1].drive_minutes_from_previous} min drive
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {route.unroutable_count > 0 && (
            <Card className="flex items-start gap-2 p-3 text-[11px] leading-relaxed text-muted">
              <Icon name="warning" size={14} className="mt-px shrink-0 text-amber" />
              <span>
                {route.unroutable_count} propert{route.unroutable_count === 1 ? 'y has' : 'ies have'}
                {' '}no latitude/longitude on file, so {route.unroutable_count === 1 ? 'it' : 'they'} could not
                be placed in the route and {route.unroutable_count === 1 ? 'is' : 'are'} listed at the end.
                Adding coordinates will fold {route.unroutable_count === 1 ? 'it' : 'them'} into the order.
              </span>
            </Card>
          )}

          <div className="text-[11px] leading-relaxed text-muted/50">
            Estimates only · {route.assumptions.algorithm} · {route.assumptions.distance} ·
            speeds {route.assumptions.speed.toLowerCase()} · starting from {route.assumptions.start}.
          </div>
        </>
      )}
    </div>
  );
}

// ── Refer a friend ──────────────────────────────────────────────────────
const REFERRAL_TONE: Record<string, 'warn' | 'info' | 'ok'> = {
  pending: 'warn', signed_up: 'info', rewarded: 'ok',
};
const REFERRAL_HINT: Record<string, string> = {
  pending: 'Waiting for them to book',
  signed_up: 'Booked — credit due on your next invoice',
  rewarded: 'Credit applied',
};

function ReferralCard() {
  const toast = useToast();
  const [data, setData] = useState<Referrals | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await partnerApi.referrals();
      setData(r);
      setCustomerId(c => c || (r.referrers[0] ? String(r.referrers[0].id) : ''));
    } catch { /* card renders empty; the portal keeps working */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerId) { toast('Choose which customer is referring', 'danger'); return; }
    if (!email.trim()) { toast("Enter your friend's email", 'danger'); return; }
    setBusy(true);
    try {
      await partnerApi.createReferral({
        customer_id: Number(customerId),
        referred_email: email.trim(),
        referred_name: name.trim() || undefined,
      });
      toast('Referral recorded — credit lands once they book', 'ok');
      setName(''); setEmail('');
      load();
    } catch (err: any) {
      toast(err?.message || 'Could not save that referral', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const reward = gbp(data?.discount_pence ?? 2000);

  return (
    <Card className="p-4 sm:p-5">
      <SectionTitle accent="#19C3E6">Refer a friend</SectionTitle>
      <p className="-mt-1 mb-3 text-xs leading-relaxed text-muted">
        Introduce someone who books a clean and <span className="font-semibold text-accent">{reward}</span>{' '}
        comes off the referrer's next invoice, automatically.
      </p>

      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="mb-1.5 block text-xs font-semibold text-muted">Referred by</label>
          <Select value={customerId} onChange={e => setCustomerId(e.target.value)}>
            {(data?.referrers || []).map(r => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-muted">Friend's name</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Optional" />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-muted">Friend's email</label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="friend@example.com" />
          </div>
        </div>
        <Button type="submit" variant="primary" icon="card_giftcard" loading={busy}
          className="w-full sm:w-auto">
          Send referral
        </Button>
      </form>

      {data && data.summary.total > 0 && (
        <>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-white/[0.03] py-2">
              <div className="text-lg font-bold tabular-nums text-ink">{data.summary.pending}</div>
              <div className="text-[10px] text-muted">Pending</div>
            </div>
            <div className="rounded-xl bg-white/[0.03] py-2">
              <div className="text-lg font-bold tabular-nums text-accent">{data.summary.signed_up}</div>
              <div className="text-[10px] text-muted">Signed up</div>
            </div>
            <div className="rounded-xl bg-white/[0.03] py-2">
              <div className="text-lg font-bold tabular-nums text-emerald">
                {gbp(data.summary.earned_pence)}
              </div>
              <div className="text-[10px] text-muted">Earned</div>
            </div>
          </div>

          <div className="mt-3 space-y-1.5">
            {data.referrals.slice(0, 8).map(r => (
              <div key={r.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-ink">
                    {r.referred_name || r.referred_email}
                  </div>
                  <div className="truncate text-[10px] text-muted">
                    by {r.referrer_name || '—'} · {REFERRAL_HINT[r.status] || r.status}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs font-semibold tabular-nums text-muted">
                    {gbp(r.discount_pence)}
                  </span>
                  <Badge tone={REFERRAL_TONE[r.status] || 'neutral'}>{titleCase(r.status)}</Badge>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ── Portal ──────────────────────────────────────────────────────────────
export default function PartnerDashboard({ partner, onSignOut }:
  { partner: Partner; onSignOut: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('jobs');
  const [jobs, setJobs] = useState<PartnerJobs | null>(null);
  const [payments, setPayments] = useState<PartnerPayments | null>(null);
  const [properties, setProperties] = useState<PartnerProperty[]>([]);
  const [serviceTypes, setServiceTypes] = useState<string[]>([]);
  const [priorities, setPriorities] = useState<string[]>([]);
  const [requests, setRequests] = useState<WorkRequest[]>([]);
  const [signoffs, setSignoffs] = useState<SignoffStatus | null>(null);
  const [crews, setCrews] = useState<Crew[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [j, p, pr, wr, so, cr] = await Promise.allSettled([
      partnerApi.jobs(), partnerApi.payments(),
      partnerApi.properties(), partnerApi.workRequests(),
      partnerApi.signoffStatus(), partnerApi.crews(),
    ]);
    if (j.status === 'fulfilled') setJobs(j.value);
    if (p.status === 'fulfilled') setPayments(p.value);
    if (pr.status === 'fulfilled') {
      setProperties(pr.value.properties || []);
      setServiceTypes(pr.value.service_types || []);
      setPriorities(pr.value.priorities || []);
    }
    if (wr.status === 'fulfilled') setRequests(wr.value.work_requests || []);
    if (so.status === 'fulfilled') setSignoffs(so.value);
    if (cr.status === 'fulfilled') setCrews(cr.value.crews || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const refreshRequests = useCallback(() => {
    partnerApi.workRequests()
      .then(r => setRequests(r.work_requests || []))
      .catch(() => { /* the toast on submit already reported success */ });
  }, []);

  const signOut = async () => {
    try { await partnerApi.logout(); } catch { /* token may already be dead */ }
    clearPartnerToken();
    onSignOut();
  };

  const pendingRequests = requests.filter(r => r.status === 'pending').length;
  const awaitingSignoff = (signoffs?.summary.pending ?? 0) + (signoffs?.summary.overdue ?? 0);
  const company = partner.company;

  const sendSignoffLink = async (job: SignoffJob) => {
    const res = await partnerApi.sendSignoffLink(job.job_id);
    toast(res.status === 'dry_run'
      ? `Dry run — no text sent (would go to ${res.to})`
      : `Sign-off link texted to ${res.to}`, 'ok');
    const fresh = await partnerApi.signoffStatus();
    setSignoffs(fresh);
  };

  return (
    <div className="min-h-screen bg-bg text-ink">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-white/6 bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border"
            style={{ background: `${company.colour}1a`, borderColor: `${company.colour}40`, color: company.colour }}>
            <Icon name="cleaning_services" size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-ink">{company.name}</div>
            <div className="truncate text-[11px] text-muted">
              Max Gleam Partner Portal · {partner.name}
            </div>
          </div>
          <Button variant="ghost" icon="refresh" onClick={load} loading={loading}
            aria-label="Refresh" className="shrink-0">
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <Button variant="ghost" icon="logout" onClick={signOut} className="shrink-0">
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>

        {/* Tabs */}
        <div className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-3 sm:px-5">
          {TABS.map(t => {
            const active = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-sm transition-colors
                  ${active ? 'text-accent' : 'text-muted hover:text-ink'}`}>
                <Icon name={t.icon} size={17} />
                {t.label}
                {t.id === 'requests' && pendingRequests > 0 && (
                  <span className="rounded-full bg-amber/15 px-1.5 text-[10px] font-bold text-amber">
                    {pendingRequests}
                  </span>
                )}
                {t.id === 'signoffs' && awaitingSignoff > 0 && (
                  <span className="rounded-full bg-amber/15 px-1.5 text-[10px] font-bold text-amber">
                    {awaitingSignoff}
                  </span>
                )}
                {active && (
                  <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent shadow-[0_0_8px_rgba(25,195,230,0.8)]" />
                )}
              </button>
            );
          })}
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6">
        {/* ── Stat tiles ───────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Next 7 days" icon="event_upcoming" accent="#19C3E6" delay={0}
            value={String(jobs?.upcoming.length ?? 0)}
            sub={jobs?.overdue.length ? `${jobs.overdue.length} overdue` : 'jobs scheduled'} />
          <StatTile label="Completed 30d" icon="task_alt" accent="#22C55E" delay={80}
            value={String(jobs?.completed.length ?? 0)}
            sub={payments ? gbp(payments.summary.completed_value_30d_pence) : undefined} />
          <StatTile label="Outstanding" icon="account_balance_wallet" accent="#F59E0B" delay={160}
            value={payments ? gbp(payments.summary.unpaid_pence) : '—'}
            sub="unpaid invoices" />
          <StatTile label="Awaiting sign-off" icon="draw" accent="#A78BFA" delay={240}
            value={String(awaitingSignoff)}
            sub={signoffs?.summary.overdue ? `${signoffs.summary.overdue} overdue` : 'all up to date'} />
        </div>

        {loading && !jobs ? <SkeletonList count={4} /> : (
          /* keyed on the active tab so switching re-runs the entrance animation */
          <div key={tab} className="animate-[fadeInUp_0.3s_ease-out_both]">
            {/* ── Jobs ──────────────────────────────────────────────── */}
            {tab === 'jobs' && (
              <div className="space-y-6">
                {jobs && jobs.overdue.length > 0 && (
                  <section>
                    <SectionTitle count={jobs.overdue.length} accent="#F43F5E">Overdue</SectionTitle>
                    <div className="space-y-2">
                      {jobs.overdue.map(j => <JobRow key={j.id} job={j} tone="overdue" crews={crews} onChanged={load} />)}
                    </div>
                  </section>
                )}

                <section>
                  <SectionTitle count={jobs?.upcoming.length}>
                    Upcoming — next {jobs?.window.upcoming_days ?? 7} days
                  </SectionTitle>
                  {!jobs?.upcoming.length ? (
                    <EmptyState icon="event_available" title="Nothing scheduled"
                      hint="Jobs booked for your properties in the next 7 days appear here." />
                  ) : (
                    <div className="space-y-2">
                      {jobs.upcoming.map(j => <JobRow key={j.id} job={j} tone="upcoming" crews={crews} onChanged={load} />)}
                    </div>
                  )}
                </section>

                <section>
                  <SectionTitle count={jobs?.completed.length} accent="#22C55E">
                    Completed — last {jobs?.window.completed_days ?? 30} days
                  </SectionTitle>
                  {!jobs?.completed.length ? (
                    <EmptyState icon="task_alt" accent="#22C55E" title="No completed jobs yet"
                      hint="Cleans signed off in the last 30 days are listed here." />
                  ) : (
                    <div className="space-y-2">
                      {jobs.completed.map(j => <JobRow key={j.id} job={j} tone="done" crews={crews} onChanged={load} />)}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* ── Route ─────────────────────────────────────────────── */}
            {tab === 'route' && <RouteTab colour={company.colour} />}

            {/* ── Sign-offs ─────────────────────────────────────────── */}
            {tab === 'signoffs' && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatTile label="Awaiting" icon="hourglass_top" accent="#F59E0B"
                    value={String(signoffs?.summary.pending ?? 0)} sub="link sent or pending" />
                  <StatTile label="Overdue" icon="warning" accent="#F43F5E" delay={60}
                    value={String(signoffs?.summary.overdue ?? 0)}
                    sub={`past ${signoffs?.summary.auto_approve_hours ?? 24}h`} />
                  <StatTile label="Signed" icon="draw" accent="#22C55E" delay={120}
                    value={String(signoffs?.summary.signed ?? 0)} sub="by the customer" />
                  <StatTile label="Avg rating" icon="star" accent="#A78BFA" delay={180}
                    value={signoffs?.summary.average_rating ? `${signoffs.summary.average_rating}/5` : '—'}
                    sub={`${signoffs?.summary.rated ?? 0} rated`} />
                </div>

                {!!signoffs?.overdue.length && (
                  <section>
                    <SectionTitle count={signoffs.overdue.length} accent="#F43F5E">
                      Overdue — past the {signoffs.summary.auto_approve_hours}h window
                    </SectionTitle>
                    <div className="space-y-2">
                      {signoffs.overdue.map(j => (
                        <SignoffRow key={j.job_id} job={j} tone="overdue" onSend={sendSignoffLink} />
                      ))}
                    </div>
                  </section>
                )}

                <section>
                  <SectionTitle count={signoffs?.pending.length} accent="#F59E0B">
                    Awaiting customer sign-off
                  </SectionTitle>
                  {!signoffs?.pending.length ? (
                    <EmptyState icon="task_alt" accent="#22C55E" title="Nothing waiting"
                      hint="Completed cleans appear here until the customer confirms they're happy." />
                  ) : (
                    <div className="space-y-2">
                      {signoffs.pending.map(j => (
                        <SignoffRow key={j.job_id} job={j} tone="pending" onSend={sendSignoffLink} />
                      ))}
                    </div>
                  )}
                </section>

                <section>
                  <SectionTitle count={signoffs?.signed.length} accent="#22C55E">Signed off</SectionTitle>
                  {!signoffs?.signed.length ? (
                    <EmptyState icon="draw" title="No sign-offs yet"
                      hint="Customer confirmations, ratings and comments land here." />
                  ) : (
                    <div className="space-y-2">
                      {signoffs.signed.map(j => <SignoffRow key={j.job_id} job={j} tone="done" />)}
                    </div>
                  )}
                </section>

                {!!signoffs?.auto_approved.length && (
                  <section>
                    <SectionTitle count={signoffs.auto_approved.length} accent="#19C3E6">
                      Auto-approved
                    </SectionTitle>
                    <div className="space-y-2">
                      {signoffs.auto_approved.map(j => <SignoffRow key={j.job_id} job={j} tone="done" />)}
                    </div>
                  </section>
                )}
              </div>
            )}

            {/* ── Work requests ─────────────────────────────────────── */}
            {tab === 'requests' && (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="space-y-6">
                  <WorkRequestForm properties={properties} serviceTypes={serviceTypes}
                    priorities={priorities} onSubmitted={refreshRequests} />
                  <ReferralCard />
                </div>

                <section>
                  <SectionTitle count={requests.length} accent="#A78BFA">Your requests</SectionTitle>
                  {requests.length === 0 ? (
                    <EmptyState icon="add_task" accent="#A78BFA" title="No requests yet"
                      hint="Submit a request and the Max Gleam office will schedule it." />
                  ) : (
                    <div className="space-y-2">
                      {requests.map(r => (
                        <Card key={r.id} className="p-3.5 transition-colors duration-200 hover:border-white/12 hover:bg-white/[0.03]">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-ink">{r.title}</div>
                              <div className="mt-0.5 truncate text-[11px] text-muted">
                                {r.address || 'General request'}
                                {r.postcode ? ` · ${r.postcode}` : ''}
                              </div>
                            </div>
                            <Badge tone={REQUEST_TONE[r.status] || 'neutral'}>{titleCase(r.status)}</Badge>
                          </div>
                          {r.description && (
                            <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted">{r.description}</p>
                          )}
                          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                            <Badge tone="neutral">{titleCase(r.service_type)}</Badge>
                            <Badge tone={PRIORITY_TONE[r.priority] || 'neutral'}>{titleCase(r.priority)}</Badge>
                            {r.scheduled_date && (
                              <Badge tone="info">Booked {prettyDate(r.scheduled_date)}</Badge>
                            )}
                            <span className="ml-auto text-[11px] tabular-nums text-muted/60">
                              {new Date(r.created_at * 1000).toLocaleDateString()}
                            </span>
                          </div>
                        </Card>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {/* ── Payments ──────────────────────────────────────────── */}
            {tab === 'payments' && (
              <div className="space-y-5">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <StatTile label="Paid" icon="check_circle" accent="#22C55E"
                    value={payments ? gbp(payments.summary.paid_pence) : '—'} sub="settled to date" />
                  <StatTile label="Outstanding" icon="schedule" accent="#F59E0B"
                    value={payments ? gbp(payments.summary.unpaid_pence) : '—'} sub="awaiting payment" />
                  <StatTile label="Work completed 30d" icon="cleaning_services" accent="#19C3E6"
                    value={payments ? gbp(payments.summary.completed_value_30d_pence) : '—'}
                    sub={`${payments?.summary.completed_jobs_30d ?? 0} jobs`} />
                </div>

                <section>
                  <SectionTitle count={payments?.invoices.length} accent="#F59E0B">Invoices</SectionTitle>
                  {!payments?.invoices.length ? (
                    <EmptyState icon="receipt_long" accent="#F59E0B" title="No invoices yet"
                      hint="Invoices raised against your properties show here with their payment status." />
                  ) : (
                    <div className="space-y-2">
                      {payments.invoices.map(inv => (
                        <div key={inv.id}
                          className="flex flex-col gap-2 rounded-xl border border-white/6 bg-white/[0.02] p-3 transition-colors duration-200 hover:border-white/12 hover:bg-white/[0.05] sm:flex-row sm:items-center sm:gap-4">
                          <div className="shrink-0 sm:w-40">
                            <div className="font-mono text-sm font-semibold text-ink">{inv.number}</div>
                            <div className="text-[11px] text-muted/70">
                              {new Date(inv.issued_at * 1000).toLocaleDateString()}
                            </div>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-ink">{inv.address}</div>
                            <div className="text-[11px] text-muted">
                              {inv.postcode}
                              {inv.scheduled_date ? ` · clean ${prettyDate(inv.scheduled_date)}` : ''}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2.5">
                            <span className="text-sm font-semibold tabular-nums text-ink">
                              {gbp(inv.amount_pence)}
                            </span>
                            <Badge tone={inv.status === 'paid' ? 'ok' : 'warn'}>
                              {titleCase(inv.status)}
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        )}

        <div className="pt-2 text-center text-[11px] text-muted/40">
          Questions about a job or invoice? Contact the Max Gleam office.
        </div>
      </main>
    </div>
  );
}
