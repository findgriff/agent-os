// Max Gleam invoices — every invoice, filterable, with one-tap auto-generation
// for completed cleans that slipped through unbilled.
//
// An HQ surface, so it wears the AGENT OS dark theme (unlike the customer
// pages under pages/mg/, which are deliberately light).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, Icon, Input, Modal, Select, SkeletonList, StatTile, useToast } from '../../components/ui';
import {
  invoicesApi, downloadInvoicePdf, gbp, PAYMENT_METHOD_LABELS,
  type InvoiceList, type MgInvoiceRow, type PaymentMethod,
} from '../../lib/reportsApi';

const ACCENT = '#19C3E6';

type Filter = 'all' | 'unpaid' | 'overdue' | 'paid';

const FILTERS: { id: Filter; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: 'receipt_long' },
  { id: 'unpaid', label: 'Unpaid', icon: 'schedule' },
  { id: 'overdue', label: 'Overdue', icon: 'warning' },
  { id: 'paid', label: 'Paid', icon: 'check_circle' },
];

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  paid: 'ok', unpaid: 'warn', partial: 'warn', overdue: 'danger', void: 'neutral',
};

function InvoiceRow({ inv, onSend, onPdf, onRecordPaid, onRevert }: {
  inv: MgInvoiceRow;
  onSend: (i: MgInvoiceRow) => Promise<void>;
  onPdf: (i: MgInvoiceRow) => Promise<void>;
  onRecordPaid: (i: MgInvoiceRow, method: PaymentMethod, amountPence?: number) => Promise<boolean>;
  onRevert: (i: MgInvoiceRow) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  // Amount field, in pounds. Defaults to the full balance when the modal opens.
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState(false);
  // A manually-keyed payment (full or partial) can be undone; a SumUp one can't.
  const canRevert = (inv.status === 'paid' || inv.status === 'partial')
    && !!inv.method && inv.method !== 'sumup_online';
  const outstanding = inv.outstanding_pence;
  const openPay = () => { setAmount((outstanding / 100).toFixed(2)); setMethod('cash'); setPayOpen(true); };
  // Parse the pounds input to whole pence; NaN/≤0/over-balance are caught here
  // so Confirm can disable rather than round-trip a guaranteed 400.
  const amountPence = Math.round(parseFloat(amount) * 100);
  const amountValid = Number.isFinite(amountPence) && amountPence > 0 && amountPence <= outstanding;
  const isPart = amountValid && amountPence < outstanding;
  const tone = STATUS_TONE[inv.display_status] || 'neutral';
  const accent = inv.display_status === 'paid' ? '#22C55E'
    : inv.display_status === 'overdue' ? '#F43F5E'
    : inv.display_status === 'void' ? '#64748B' : '#F59E0B';
  return (
    <div className="relative flex flex-col gap-2 rounded-xl border border-white/6 bg-white/[0.02] p-3 transition-colors hover:border-white/12 sm:flex-row sm:items-center sm:gap-4">
      <span className="absolute bottom-3 left-0 top-3 w-[3px] rounded-r-full"
        style={{ background: accent, boxShadow: `0 0 10px ${accent}88` }} />
      <div className="shrink-0 pl-2.5 sm:w-36">
        <div className="font-mono text-sm font-semibold text-ink">{inv.number}</div>
        <div className="text-[11px] text-muted">
          {inv.issued_at ? new Date(inv.issued_at * 1000).toLocaleDateString('en-GB') : '—'}
        </div>
      </div>

      <div className="min-w-0 flex-1 pl-2.5 sm:pl-0">
        <div className="truncate text-sm font-medium text-ink">{inv.customer_name || 'Unknown customer'}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
          {inv.address && <span className="truncate">{inv.address}</span>}
          {inv.days_outstanding !== null && inv.display_status !== 'paid' && (
            <span className={inv.is_overdue ? 'text-rose' : ''}>
              {inv.address ? '· ' : ''}{inv.days_outstanding}d outstanding
            </span>
          )}
          {!inv.customer_email && (
            <span className="text-amber/80">
              {(inv.address || (inv.days_outstanding !== null && inv.display_status !== 'paid')) ? '· ' : ''}no email on file
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-2.5 sm:pl-0">
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums text-ink">{gbp(inv.amount_pence)}</div>
          {inv.display_status === 'partial' || (inv.paid_pence > 0 && inv.outstanding_pence > 0) ? (
            <div className="text-[11px] tabular-nums text-amber/90">
              {gbp(inv.paid_pence)} paid · {gbp(inv.outstanding_pence)} due
            </div>
          ) : inv.vat_pence > 0 && (
            <div className="text-[11px] tabular-nums text-muted">inc. {gbp(inv.vat_pence)} VAT</div>
          )}
        </div>
        <Badge tone={tone}>
          {inv.display_status[0].toUpperCase() + inv.display_status.slice(1)}
        </Badge>
        {inv.sumup_checkout_url && inv.outstanding_pence > 0 && (
          <Button variant="ghost" icon="link" className="!h-11 !w-11 !px-0"
            title="Open the SumUp pay-link" aria-label="Open the SumUp pay-link"
            onClick={() => window.open(inv.sumup_checkout_url!, '_blank', 'noopener,noreferrer')} />
        )}
        {inv.outstanding_pence > 0 && inv.status !== 'void' && (
          <Button variant="secondary" icon="payments" className="!px-2.5 min-h-[44px]"
            title="Record a cash, transfer or card-reader payment"
            onClick={openPay}>
            {inv.paid_pence > 0 ? 'Add payment' : 'Mark paid'}
          </Button>
        )}
        {canRevert && (
          <Button variant="ghost" icon="undo" loading={reverting} title="Revert this payment"
            aria-label="Revert this payment" className="!h-11 !w-11 !px-0"
            onClick={async () => { setReverting(true); await onRevert(inv); setReverting(false); }} />
        )}
        <Button variant="ghost" icon="download" loading={pdfBusy} title="Download PDF"
          aria-label="Download PDF" className="!h-11 !w-11 !px-0"
          onClick={async () => { setPdfBusy(true); await onPdf(inv); setPdfBusy(false); }} />
        <Button variant="secondary" icon="mail" loading={busy} className="min-h-[44px]"
          disabled={!inv.customer_email}
          title={inv.customer_email ? `Email ${inv.customer_email}` : 'No email address on file'}
          onClick={async () => { setBusy(true); await onSend(inv); setBusy(false); }}>
          Send
        </Button>
      </div>

      <Modal open={payOpen} onClose={() => setPayOpen(false)}
        title={`Record payment — ${inv.number}`} width="max-w-sm">
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl border border-white/6 bg-white/[0.02] px-3 py-2.5">
            <span className="text-sm text-muted">{inv.paid_pence > 0 ? 'Balance outstanding' : 'Invoice total'}</span>
            <span className="text-base font-semibold tabular-nums text-ink">{gbp(outstanding)}</span>
          </div>
          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium text-muted">Amount received (£)</span>
            <Input type="number" inputMode="decimal" step="0.01" min="0"
              max={(outstanding / 100).toFixed(2)} value={amount}
              onChange={e => setAmount(e.target.value)}
              className={amount && !amountValid ? '!border-rose/50' : ''} />
            <span className="block text-[11px] text-muted/80">
              {isPart
                ? `Part payment — ${gbp(outstanding - amountPence)} will remain outstanding.`
                : 'Leave as the full balance, or enter less to record a part payment.'}
            </span>
          </label>
          <label className="block space-y-1.5">
            <span className="text-[12px] font-medium text-muted">How was it paid?</span>
            <Select value={method} onChange={e => setMethod(e.target.value as PaymentMethod)}
              className="w-full">
              {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map(m => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
              ))}
            </Select>
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setPayOpen(false)}>Cancel</Button>
            <Button variant="primary" icon="check" loading={saving} disabled={!amountValid}
              onClick={async () => {
                setSaving(true);
                // Send the amount only when it's a part payment; a full balance
                // omits it so the server settles whatever is outstanding. Keep the
                // modal open (and the entered amount intact) if the save failed.
                try {
                  const ok = await onRecordPaid(inv, method, isPart ? amountPence : undefined);
                  if (ok) setPayOpen(false);
                } finally {
                  setSaving(false);
                }
              }}>
              {isPart ? `Record ${gbp(amountPence)}` : 'Confirm payment'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default function Invoices() {
  const toast = useToast();
  const [params] = useSearchParams();
  const [data, setData] = useState<InvoiceList | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  // Seed the search from ?q= so a "view invoice" link from a converted quote
  // lands straight on that invoice number.
  const [search, setSearch] = useState(() => params.get('q') || '');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await invoicesApi.list());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load invoices');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Filtering is client-side: the list is already loaded in full, and the
  // server's own filter would cost a round-trip per tab click.
  const shown = useMemo(() => {
    const rows = (data?.invoices || []).filter(i => {
      if (filter === 'all') return true;
      // 'Unpaid' is the umbrella for "still owes money" — part-paid and overdue
      // invoices belong here too (matching the Unpaid badge/stat-tile, which
      // count every invoice with a balance). Without this, a part-paid invoice
      // — display_status 'partial' — is surfaced by no filter tab at all.
      if (filter === 'unpaid') return i.outstanding_pence > 0;
      return i.display_status === filter;
    });
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(i =>
      i.number.toLowerCase().includes(q)
      || (i.customer_name || '').toLowerCase().includes(q)
      || (i.address || '').toLowerCase().includes(q));
  }, [data, filter, search]);

  const generate = async () => {
    setGenerating(true);
    try {
      const res = await invoicesApi.autoGenerate();
      if (res.created_count === 0 && res.skipped_count === 0) {
        toast('Nothing to invoice — every completed clean is billed', 'info');
      } else {
        toast(
          `${res.created_count} invoice${res.created_count === 1 ? '' : 's'} raised`
          + (res.skipped_count ? `, ${res.skipped_count} skipped` : '')
          + (res.dry_run ? ' (dry run — no email sent)' : ''),
          res.created_count ? 'ok' : 'warn');
      }
      if (res.skipped.length) {
        // Skips are usually a missing price — worth naming, not burying.
        toast(`Skipped: ${res.skipped.slice(0, 2).map(s => `${s.address} (${s.reason})`).join('; ')}`, 'warn');
      }
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not generate invoices', 'danger');
    } finally {
      setGenerating(false);
    }
  };

  const send = async (inv: MgInvoiceRow) => {
    try {
      const res = await invoicesApi.send(inv.id);
      toast(res.status === 'dry_run'
        ? `Dry run — ${inv.number} not actually emailed to ${res.to}`
        : `${inv.number} emailed to ${res.to}`, 'ok');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send that invoice', 'danger');
    }
  };

  const pdf = async (inv: MgInvoiceRow) => {
    try {
      await downloadInvoicePdf(inv.id, inv.number);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not download that invoice', 'danger');
    }
  };

  const recordPaid = async (inv: MgInvoiceRow, method: PaymentMethod, amountPence?: number) => {
    try {
      const { invoice } = await invoicesApi.recordPayment(inv.id, method, amountPence);
      const how = PAYMENT_METHOD_LABELS[method].toLowerCase();
      toast(invoice.display_status === 'partial'
        ? `${inv.number} part-paid by ${how} — ${gbp(invoice.outstanding_pence)} still due`
        : `${inv.number} marked paid — ${how}`, 'ok');
      await load();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not record that payment', 'danger');
      return false;
    }
  };

  const revert = async (inv: MgInvoiceRow) => {
    try {
      const { invoice } = await invoicesApi.unmarkPayment(inv.id);
      toast(invoice.display_status === 'partial'
        ? `${inv.number} — last payment reversed, ${gbp(invoice.outstanding_pence)} due`
        : `${inv.number} reverted to unpaid`, 'ok');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not revert that payment', 'danger');
    }
  };

  const s = data?.summary;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent/10 text-accent"
          style={{ boxShadow: `0 0 28px -8px ${ACCENT}88` }}>
          <Icon name="receipt_long" size={24} />
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold text-ink sm:text-2xl">Invoices</h1>
          <p className="text-[12px] text-muted">
            {data ? `${s?.total} invoice${s?.total === 1 ? '' : 's'} · overdue after ${s?.overdue_days} days`
                  : 'Loading…'}
            {data && !data.vat_registered && ' · not VAT registered'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="primary" icon="auto_awesome" loading={generating} onClick={generate}>
            Auto-generate
          </Button>
          <Button variant="secondary" icon="refresh" loading={refreshing}
            onClick={async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }}>
            Refresh
          </Button>
        </div>
      </header>

      {error && data && (
        <Card className="border-rose/25 bg-rose/5 p-3 text-sm text-rose">{error}</Card>
      )}

      {!!data?.uninvoiced_jobs && (
        <Card className="flex flex-wrap items-center gap-3 border-amber/25 bg-amber/5 p-3.5">
          <Icon name="info" size={20} className="text-amber" />
          <span className="min-w-0 flex-1 text-sm text-ink">
            {data.uninvoiced_jobs} completed clean{data.uninvoiced_jobs === 1 ? '' : 's'} with no invoice.
          </span>
          <Button variant="secondary" icon="auto_awesome" loading={generating} onClick={generate}>
            Raise {data.uninvoiced_jobs === 1 ? 'it' : 'them'}
          </Button>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total billed" icon="receipt_long"
          value={gbp((s?.paid_pence || 0) + (s?.unpaid_pence || 0))}
          sub={`${s?.total ?? 0} invoices`} />
        <StatTile label="Paid" icon="check_circle" accent="#22C55E" delay={60}
          value={gbp(s?.paid_pence || 0)} sub={`${s?.paid ?? 0} settled`} />
        <StatTile label="Unpaid" icon="schedule" accent="#F59E0B" delay={120}
          value={gbp(s?.unpaid_pence || 0)} sub={`${s?.unpaid ?? 0} outstanding`} />
        <StatTile label="Overdue" icon="warning" accent="#F43F5E" delay={180}
          value={gbp(s?.overdue_pence || 0)} sub={`${s?.overdue ?? 0} past ${s?.overdue_days ?? 30}d`} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 overflow-x-auto rounded-2xl border border-white/6 bg-white/[0.02] p-1">
          {FILTERS.map(f => {
            const count = f.id === 'all' ? s?.total
              : f.id === 'paid' ? s?.paid
              : f.id === 'unpaid' ? s?.unpaid : s?.overdue;
            return (
              <button key={f.id} onClick={() => setFilter(f.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition-all
                  ${filter === f.id ? 'bg-accent/12 text-accent' : 'text-muted hover:bg-white/5 hover:text-ink'}`}>
                <Icon name={f.icon} size={17} />
                {f.label}
                {count !== undefined && (
                  <span className="rounded-full bg-white/8 px-1.5 text-[10px] tabular-nums">{count}</span>
                )}
              </button>
            );
          })}
        </div>
        <Input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search number, customer or address"
          className="min-w-[200px] flex-1 sm:max-w-xs" />
      </div>

      {loading ? <SkeletonList count={5} /> : error && !data ? (
        <EmptyState icon="error" accent="#F43F5E" title="Couldn't load invoices"
          hint={error} action={<Button icon="refresh" onClick={load}>Try again</Button>} />
      ) : shown.length === 0 ? (
        <EmptyState icon="receipt_long"
          title={search ? 'Nothing matches that search' : `No ${filter === 'all' ? '' : filter} invoices`}
          hint={filter === 'all'
            ? 'Invoices appear here as cleans are completed.'
            : 'Try a different filter.'} />
      ) : (
        <div className="space-y-2">
          {shown.map(inv => (
            <InvoiceRow key={inv.id} inv={inv} onSend={send} onPdf={pdf}
              onRecordPaid={recordPaid} onRevert={revert} />
          ))}
        </div>
      )}
    </div>
  );
}
