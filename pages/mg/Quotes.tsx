// Max Gleam — Quotes. The front of the sales funnel: price up a prospect,
// send the quote, and convert an accepted one into a live customer + property
// (and an optional first job) in a click. Backed by lib/quotesApi.ts.
import { useEffect, useMemo, useState } from 'react';
import {
  Icon, Button, Card, Badge, Input, Select, Textarea, Modal,
  EmptyState, SkeletonList, useToast, Stat,
} from '../../components/ui';
import { quotesApi } from '../../lib/quotesApi';
import type { Quote, QuoteStatus, QuoteSummary, NewQuote } from '../../lib/quotesApi';

const gbp = (p: number) => `£${((p || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const gbp2 = (p: number) => `£${((p || 0) / 100).toFixed(2)}`;

const STATUS: Record<QuoteStatus, { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'violet'; icon: string }> = {
  draft:     { label: 'Draft',     tone: 'neutral', icon: 'edit_note' },
  sent:      { label: 'Sent',      tone: 'info',    icon: 'send' },
  accepted:  { label: 'Accepted',  tone: 'violet',  icon: 'thumb_up' },
  declined:  { label: 'Declined',  tone: 'danger',  icon: 'thumb_down' },
  converted: { label: 'Won',       tone: 'ok',      icon: 'verified' },
};

const FILTERS: { key: QuoteStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'sent', label: 'Sent' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'converted', label: 'Won' },
  { key: 'declined', label: 'Declined' },
];

const FREQ_OPTS = [
  { v: 4, l: 'Every 4 weeks' }, { v: 6, l: 'Every 6 weeks' },
  { v: 8, l: 'Every 8 weeks' }, { v: 12, l: 'Every 12 weeks' },
  { v: 0, l: 'One-off / ad-hoc' },
];

const perYear = (q: Quote) => (q.frequency_weeks ? Math.floor(52 / q.frequency_weeks) : 0);

// Small labelled-field wrapper — the ui Input/Select/Textarea are raw controls.
function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

export default function Quotes() {
  const toast = useToast();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [summary, setSummary] = useState<QuoteSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<QuoteStatus | 'all'>('all');
  const [editing, setEditing] = useState<Quote | 'new' | null>(null);
  const [converting, setConverting] = useState<Quote | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    setError('');
    quotesApi.list()
      .then(r => { setQuotes(r.quotes); setSummary(r.summary); })
      .catch(() => { setError('Could not reach the server.'); toast('Could not load quotes', 'danger'); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const shown = useMemo(
    () => filter === 'all' ? quotes : quotes.filter(q => q.status === filter),
    [quotes, filter]);

  const patch = (updated: Quote) =>
    setQuotes(qs => qs.map(q => q.id === updated.id ? updated : q));

  const setStatus = async (q: Quote, status: Exclude<QuoteStatus, 'converted'>) => {
    setBusyId(q.id);
    try {
      const r = await quotesApi.update(q.id, { status });
      patch(r.quote);
      toast(`Quote marked ${STATUS[status].label.toLowerCase()}`, 'ok');
      load();
    } catch { toast('Update failed', 'danger'); }
    finally { setBusyId(null); }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Quotes</h1>
          <p className="text-sm text-muted">Price up a prospect, then convert the wins into customers.</p>
        </div>
        <Button variant="primary" icon="add" onClick={() => setEditing('new')}>New quote</Button>
      </div>

      {/* Summary tiles */}
      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Open pipeline / yr" value={gbp(summary.open_annual_pence)} icon="trending_up" accent="#19C3E6" delay={0} />
          <Stat label="First-clean cash" value={gbp(summary.open_first_clean_pence)} icon="cleaning_services" accent="#38BDF8" delay={60} />
          <Stat label="Won / yr" value={gbp(summary.won_annual_pence)} icon="verified" accent="#22C55E" delay={120} />
          <Stat label="Awaiting reply" value={summary.sent} icon="mark_email_unread" accent="#F59E0B" delay={180} />
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map(f => {
          const n = f.key === 'all' ? quotes.length : quotes.filter(q => q.status === f.key).length;
          const active = filter === f.key;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={active}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-all
                ${active ? 'bg-accent text-[#04222b]' : 'glass text-muted hover:text-ink'}`}>
              {f.label} <span className="tabular-nums opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {/* List */}
      {loading ? <SkeletonList count={4} />
        : error && quotes.length === 0 ? (
          <EmptyState icon="error" accent="#F43F5E" title="Couldn't load quotes" hint={error}
            action={<Button icon="refresh" onClick={load}>Try again</Button>} />
        ) : shown.length === 0 ? (
          <EmptyState icon="request_quote" title="No quotes here"
            hint={filter === 'all' ? 'Create your first quote to start the funnel.' : 'Nothing in this stage yet.'} />
        ) : (
          <div className="space-y-2.5">
            {shown.map((q, i) => (
              <QuoteRow key={q.id} q={q} busy={busyId === q.id} delay={i * 40}
                onEdit={() => setEditing(q)}
                onSend={() => setStatus(q, 'sent')}
                onAccept={() => setStatus(q, 'accepted')}
                onDecline={() => setStatus(q, 'declined')}
                onReopen={() => setStatus(q, 'sent')}
                onConvert={() => setConverting(q)} />
            ))}
          </div>
        )}

      {editing && (
        <QuoteModal quote={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
      {converting && (
        <ConvertModal quote={converting}
          onClose={() => setConverting(null)}
          onDone={() => { setConverting(null); load(); }} />
      )}
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────
function QuoteRow({ q, busy, delay, onEdit, onSend, onAccept, onDecline, onReopen, onConvert }: {
  q: Quote; busy: boolean; delay: number;
  onEdit: () => void; onSend: () => void; onAccept: () => void;
  onDecline: () => void; onReopen: () => void; onConvert: () => void;
}) {
  const s = STATUS[q.status];
  const py = perYear(q);
  return (
    <Card className="animate-fadeInUp p-3.5" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-ink">{q.prospect_name}</span>
            <Badge tone={s.tone} dot>{s.label}</Badge>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <Icon name="location_on" size={14} />
            <span className="truncate">{q.address}{q.postcode ? `, ${q.postcode}` : ''}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
            {q.recurring_pence > 0 && (
              <span className="text-ink">
                <span className="font-semibold">{gbp2(q.recurring_pence)}</span>
                <span className="text-muted"> / {q.frequency_weeks ? `${q.frequency_weeks}w` : 'ad-hoc'}</span>
                {py > 0 && <span className="text-muted"> · {gbp(q.recurring_pence * py)}/yr</span>}
              </span>
            )}
            {q.first_clean_pence > 0 && (
              <span className="text-muted">First clean <span className="text-ink">{gbp2(q.first_clean_pence)}</span></span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {q.status === 'draft' && (
            <Button variant="primary" icon="send" loading={busy} onClick={onSend}>Send</Button>
          )}
          {q.status === 'sent' && (<>
            <Button variant="secondary" icon="thumb_up" loading={busy} onClick={onAccept}>Accept</Button>
            <Button variant="ghost" icon="thumb_down" loading={busy} onClick={onDecline}>Decline</Button>
          </>)}
          {q.status === 'accepted' && (
            <Button variant="primary" icon="person_add" loading={busy} onClick={onConvert}>Convert</Button>
          )}
          {q.status === 'declined' && (
            <Button variant="ghost" icon="undo" loading={busy} onClick={onReopen}>Re-open</Button>
          )}
          {q.status === 'converted'
            ? <span className="flex items-center gap-1 text-xs text-emerald"><Icon name="check_circle" size={16} />Customer</span>
            : <button onClick={onEdit} title="Edit" aria-label="Edit quote"
                className="grid h-9 w-9 place-items-center rounded-xl text-muted transition-colors hover:bg-white/6 hover:text-ink">
                <Icon name="edit" size={17} />
              </button>}
        </div>
      </div>
    </Card>
  );
}

// ── Create / edit modal ──────────────────────────────────────────────────────
function QuoteModal({ quote, onClose, onSaved }: {
  quote: Quote | null; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState<NewQuote>({
    prospect_name: quote?.prospect_name || '',
    prospect_email: quote?.prospect_email || '',
    prospect_phone: quote?.prospect_phone || '',
    address: quote?.address || '',
    postcode: quote?.postcode || '',
    first_clean_pence: quote?.first_clean_pence ?? 0,
    recurring_pence: quote?.recurring_pence ?? 0,
    frequency_weeks: quote?.frequency_weeks ?? 6,
    notes: quote?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof NewQuote>(k: K, v: NewQuote[K]) => setF(p => ({ ...p, [k]: v }));
  const pounds = (pence?: number) => pence ? String(pence / 100) : '';
  const toPence = (v: string) => Math.round((parseFloat(v) || 0) * 100);

  const save = async (send: boolean) => {
    if (!f.prospect_name.trim()) return toast('A prospect name is required', 'warn');
    if (!f.address.trim()) return toast('A property address is required', 'warn');
    if (!f.first_clean_pence && !f.recurring_pence) return toast('Enter a first-clean or regular price', 'warn');
    setSaving(true);
    try {
      if (quote) await quotesApi.update(quote.id, { ...f, ...(send ? { status: 'sent' } : {}) });
      else await quotesApi.create({ ...f, send });
      toast(quote ? 'Quote updated' : send ? 'Quote created & sent' : 'Draft saved', 'ok');
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save quote', 'danger'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={quote ? 'Edit quote' : 'New quote'} width="max-w-lg">
      <div className="space-y-3">
        <Field label="Prospect name">
          <Input value={f.prospect_name}
            onChange={e => set('prospect_name', e.target.value)} placeholder="e.g. Jane Doe" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email">
            <Input type="email" value={f.prospect_email || ''}
              onChange={e => set('prospect_email', e.target.value)} placeholder="jane@example.com" />
          </Field>
          <Field label="Phone">
            <Input value={f.prospect_phone || ''}
              onChange={e => set('prospect_phone', e.target.value)} placeholder="07…" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Property address" className="sm:col-span-2">
            <Input value={f.address}
              onChange={e => set('address', e.target.value)} placeholder="14 Birch Grove" />
          </Field>
          <Field label="Postcode">
            <Input value={f.postcode || ''}
              onChange={e => set('postcode', e.target.value)} placeholder="CH1 2HT" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Regular price (£)">
            <Input type="number" min={0} step="0.01" value={pounds(f.recurring_pence)}
              onChange={e => set('recurring_pence', toPence(e.target.value))} placeholder="20" />
          </Field>
          <Field label="Frequency">
            <Select className="w-full" value={String(f.frequency_weeks)}
              onChange={e => set('frequency_weeks', Number(e.target.value))}>
              {FREQ_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
            </Select>
          </Field>
          <Field label="First clean (£)">
            <Input type="number" min={0} step="0.01" value={pounds(f.first_clean_pence)}
              onChange={e => set('first_clean_pence', toPence(e.target.value))} placeholder="35" />
          </Field>
        </div>
        <Field label="Notes (access, scope, gate codes…)">
          <Textarea rows={2} value={f.notes || ''}
            onChange={e => set('notes', e.target.value)} placeholder="Rear gate code 1984, dog in garden" />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" loading={saving} onClick={() => save(false)}>
          {quote ? 'Save' : 'Save draft'}
        </Button>
        {(!quote || quote.status === 'draft') && (
          <Button variant="primary" icon="send" loading={saving} onClick={() => save(true)}>
            {quote ? 'Save & send' : 'Create & send'}
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ── Convert modal ────────────────────────────────────────────────────────────
function ConvertModal({ quote, onClose, onDone }: {
  quote: Quote; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const py = perYear(quote);

  const convert = async () => {
    setBusy(true);
    try {
      const r = await quotesApi.convert(quote.id, date || undefined);
      toast(r.first_job_id ? 'Converted — customer, property & first clean booked'
        : 'Converted to a customer & property', 'ok');
      onDone();
    } catch (e: any) { toast(e?.message || 'Conversion failed', 'danger'); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title="Convert to customer" width="max-w-md">
      <p className="text-sm text-muted">
        This creates a customer and a property for <span className="text-ink">{quote.prospect_name}</span> at{' '}
        <span className="text-ink">{quote.address}</span>, on the agreed{' '}
        <span className="text-ink">{gbp2(quote.recurring_pence)}</span>
        {quote.frequency_weeks ? ` every ${quote.frequency_weeks} weeks` : ' ad-hoc'}
        {py > 0 && <> (<span className="text-emerald">{gbp(quote.recurring_pence * py)}/yr</span>)</>}.
      </p>
      {quote.first_clean_pence > 0 && (
        <div className="mt-4">
          <Field label={`Book the first clean (${gbp2(quote.first_clean_pence)}) for — optional`}>
            <Input type="date" min={new Date().toISOString().slice(0, 10)}
              value={date} onChange={e => setDate(e.target.value)} />
          </Field>
          <p className="mt-1 text-xs text-muted">Leave blank to convert without scheduling a first job.</p>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="person_add" loading={busy} onClick={convert}>Convert</Button>
      </div>
    </Modal>
  );
}
