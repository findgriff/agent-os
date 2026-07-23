// Max Gleam communications log (/comms).
//
// Every text, email, invoice and sign-off the business has sent a customer,
// newest first, on one spine. Filters narrow the same list rather than
// switching views, so the operator never loses their place.
import { useCallback, useEffect, useState } from 'react';
import {
  Icon, Button, Card, Badge, Input, Select, Modal, EmptyState, SkeletonList,
  useToast,
} from '../components/ui';
import { api, timeAgo } from '../lib/api';
import type { CommsEntry, CommsResponse } from '../lib/types';

// Badge's tone union is private to components/ui; mirror the values used here.
type Tone = 'ok' | 'info' | 'violet' | 'neutral';

// The channel a kind belongs to is decided server-side; this is only how it
// looks once it gets here.
const CHANNEL: Record<string, { icon: string; tone: Tone; label: string }> = {
  sms: { icon: 'sms', tone: 'ok', label: 'SMS' },
  email: { icon: 'mail', tone: 'info', label: 'Email' },
  call: { icon: 'call', tone: 'violet', label: 'Call' },
  note: { icon: 'sticky_note_2', tone: 'neutral', label: 'Note' },
};

const look = (channel: string) => CHANNEL[channel] || CHANNEL.note;

interface Filters {
  customer_id?: number; kind?: string; channel?: string;
  start?: string; end?: string; q?: string;
}

export default function Comms() {
  const [data, setData] = useState<CommsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<CommsEntry | null>(null);
  const toast = useToast();

  const load = useCallback(async (f: Filters) => {
    setLoading(true);
    try {
      setData(await api.comms(f));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load the log', 'danger');
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(filters); }, [load, filters]);

  // Typing shouldn't hit the server on every keystroke.
  useEffect(() => {
    const t = setTimeout(
      () => setFilters(f => ({ ...f, q: search || undefined })), 350);
    return () => clearTimeout(t);
  }, [search]);

  const set = (patch: Filters) => setFilters(f => ({ ...f, ...patch }));
  const active = Object.entries(filters).filter(([, v]) => v).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Comms log</h1>
          <p className="mt-1 text-sm text-muted">
            Everything Max Gleam has sent a customer, newest first.
          </p>
        </div>
        {active > 0 && (
          <Button variant="ghost" icon="filter_alt_off"
            onClick={() => { setSearch(''); setFilters({}); }}>
            Clear filters
          </Button>
        )}
      </header>

      <Card className="p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Select value={filters.customer_id ?? ''}
            onChange={e => set({ customer_id: Number(e.target.value) || undefined })}>
            <option value="">All customers</option>
            {(data?.customers || []).map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
          <Select value={filters.channel ?? ''}
            onChange={e => set({ channel: e.target.value || undefined })}>
            <option value="">All channels</option>
            {(data?.channels || []).map(c => (
              <option key={c} value={c}>{look(c).label}</option>
            ))}
          </Select>
          <Select value={filters.kind ?? ''}
            onChange={e => set({ kind: e.target.value || undefined })}>
            <option value="">All types</option>
            {(data?.kinds || []).map(k => (
              <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>
            ))}
          </Select>
          <div className="flex items-center gap-1.5">
            <Input type="date" aria-label="From" value={filters.start ?? ''}
              onChange={e => set({ start: e.target.value || undefined })} />
            <span className="shrink-0 text-xs text-muted">to</span>
            <Input type="date" aria-label="To" value={filters.end ?? ''}
              onChange={e => set({ end: e.target.value || undefined })} />
          </div>
          <Input placeholder="Search content…" value={search}
            onChange={e => setSearch(e.target.value)} />
        </div>
      </Card>

      {loading && !data ? <SkeletonList count={6} />
        : !data?.entries.length ? (
          <EmptyState icon="forum" title="Nothing logged"
            hint={active
              ? 'No messages match those filters.'
              : 'Texts, invoices and sign-offs will appear here as they go out.'} />
        ) : (
          <>
            <p className="text-xs text-muted">
              {data.summary.count} entr{data.summary.count === 1 ? 'y' : 'ies'}
              {data.summary.count >= data.summary.limit && ' (most recent)'}
            </p>
            <div className="relative space-y-2 pl-6">
              {/* the spine */}
              <div className="absolute bottom-2 left-[11px] top-2 w-px bg-white/8" />
              {data.entries.map((e, i) => (
                <TimelineRow key={e.id} entry={e} delay={Math.min(i, 12) * 40}
                  onOpen={() => setOpen(e)} />
              ))}
            </div>
          </>
        )}

      <DetailModal entry={open} onClose={() => setOpen(null)} />
    </div>
  );
}

// ── One entry ───────────────────────────────────────────────────────────

function TimelineRow({ entry, delay, onOpen }:
  { entry: CommsEntry; delay: number; onOpen: () => void }) {
  const style = look(entry.channel);
  return (
    <button onClick={onOpen}
      className="group relative block w-full animate-fadeInUp text-left"
      style={{ animationDelay: `${delay}ms` }}>
      {/* node on the spine */}
      <span className="absolute -left-6 top-4 grid h-[22px] w-[22px] place-items-center
        rounded-full border border-white/10 bg-raised text-muted
        transition-colors group-hover:border-accent/40 group-hover:text-accent">
        <Icon name={style.icon} size={13} />
      </span>
      <Card hover className="p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={style.tone}>{style.label}</Badge>
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            {entry.kind.replace(/_/g, ' ')}
          </span>
          <span className="ml-auto text-xs text-muted">{timeAgo(entry.created_at)}</span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-sm text-ink">{entry.content}</p>
        <p className="mt-1 text-xs text-muted">
          {entry.customer_name || 'No customer linked'}
          <span className="mx-1.5">·</span>
          {stamp(entry.created_at)}
        </p>
      </Card>
    </button>
  );
}

// ── Full message ────────────────────────────────────────────────────────

function DetailModal({ entry, onClose }:
  { entry: CommsEntry | null; onClose: () => void }) {
  const style = entry ? look(entry.channel) : null;
  return (
    <Modal open={!!entry} onClose={onClose}
      title={entry ? `${look(entry.channel).label} · ${entry.kind.replace(/_/g, ' ')}` : ''}>
      {entry && style && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={style.tone}>{style.label}</Badge>
            <span className="text-sm text-muted">{stamp(entry.created_at)}</span>
          </div>

          <div className="rounded-xl border border-white/8 bg-black/25 p-4">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {entry.content}
            </p>
          </div>

          <dl className="space-y-1.5 text-sm">
            <Row label="Customer" value={entry.customer_name || '—'} />
            <Row label="Email" value={entry.customer_email || '—'} />
            <Row label="Phone" value={entry.customer_phone || '—'} />
            <Row label="Entry" value={`#${entry.id}`} />
          </dl>

          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}

function stamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
