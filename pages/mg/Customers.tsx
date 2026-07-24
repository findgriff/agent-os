// Max Gleam — Customers (office CRM). A searchable customer book with a full
// per-customer record: properties, job history, invoices, notes, and the
// numbers that matter (lifetime value, balance owed, next clean). Backed by
// lib/customersApi.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Icon, Button, Card, Badge, Input, Textarea, Modal, Drawer,
  EmptyState, SkeletonList, useToast, Stat,
} from '../../components/ui';
import { customersApi } from '../../lib/customersApi';
import type {
  CustomerRow, CustomerSummary, CustomerDetail, CustomerPatch,
} from '../../lib/customersApi';

const gbp = (p: number) => `£${(p / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
const gbp2 = (p: number) => `£${(p / 100).toFixed(2)}`;
const fmtDate = (d?: string | null) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const fmtTs = (t?: number | null) =>
  t ? new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '';

const JOB_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  done: 'ok', scheduled: 'info', skipped: 'warn', missed: 'danger',
};
const INV_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  paid: 'ok', unpaid: 'warn', void: 'neutral',
};

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

export default function Customers() {
  const toast = useToast();
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  const load = (search = q) => {
    setLoading(true);
    customersApi.list(search)
      .then(r => { setRows(r.customers); setSummary(r.summary); })
      .catch(() => toast('Could not load customers', 'danger'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(''); }, []);

  const onSearch = (v: string) => {
    setQ(v);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(v), 300);
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Customers</h1>
          <p className="text-sm text-muted">Your customer book — history, properties and balances in one place.</p>
        </div>
        <div className="relative w-full sm:w-72">
          <Icon name="search" size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={e => onSearch(e.target.value)}
            placeholder="Search name, phone, address…" className="pl-9" />
        </div>
      </div>

      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Customers" value={summary.total} icon="groups" accent="#19C3E6" delay={0} />
          <Stat label="Owe you" value={summary.with_balance} icon="account_balance_wallet" accent="#F59E0B" delay={60} />
          <Stat label="Outstanding" value={gbp(summary.outstanding_pence)} icon="pending_actions" accent="#F43F5E" delay={120} />
          <Stat label="Lifetime value" value={gbp(summary.ltv_pence)} icon="paid" accent="#22C55E" delay={180} />
        </div>
      )}

      {loading ? <SkeletonList count={6} />
        : rows.length === 0 ? (
          <EmptyState icon="person_search" title="No customers found"
            hint={q ? 'Nothing matches that search.' : 'Convert a quote to add your first customer.'} />
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {rows.map((c, i) => (
              <button key={c.id} onClick={() => setOpenId(c.id)} className="text-left">
                <Card hover className="animate-fadeInUp p-3.5" style={{ animationDelay: `${i * 30}ms` }}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-ink">{c.name}</span>
                        {c.archived && <Badge tone="neutral">Archived</Badge>}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted">
                        {c.phone || c.email || 'No contact on file'}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                        <span className="flex items-center gap-1"><Icon name="home" size={13} />{c.active_properties}/{c.property_count}</span>
                        {c.next_job && <span className="flex items-center gap-1 text-sky"><Icon name="event" size={13} />{fmtDate(c.next_job)}</span>}
                        {c.ltv_pence > 0 && <span className="flex items-center gap-1 text-emerald"><Icon name="paid" size={13} />{gbp(c.ltv_pence)}</span>}
                      </div>
                    </div>
                    {c.outstanding_pence > 0
                      ? <Badge tone="danger" dot>{gbp2(c.outstanding_pence)}</Badge>
                      : <Icon name="chevron_right" size={20} className="shrink-0 text-muted/40" />}
                  </div>
                </Card>
              </button>
            ))}
          </div>
        )}

      {openId != null && (
        <CustomerDrawer id={openId} onClose={() => setOpenId(null)}
          onChanged={() => load()} />
      )}
    </div>
  );
}

// ── Detail drawer ─────────────────────────────────────────────────────────────
function CustomerDrawer({ id, onClose, onChanged }: {
  id: number; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const [d, setD] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const load = () => {
    setLoading(true);
    customersApi.get(id)
      .then(setD).catch(() => toast('Could not load customer', 'danger'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [id]);

  const addNote = async () => {
    const text = note.trim();
    if (!text) return;
    setSavingNote(true);
    try {
      await customersApi.addNote(id, text);
      setNote('');
      load();
      toast('Note added', 'ok');
    } catch { toast('Could not add note', 'danger'); }
    finally { setSavingNote(false); }
  };

  const c = d?.customer;
  const s = d?.stats;

  return (
    <Drawer open onClose={onClose} width="max-w-2xl">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-white/8 bg-surface/80 px-5 py-4 backdrop-blur">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-bold text-ink">{c?.name || 'Customer'}</h2>
          {c && <p className="truncate text-xs text-muted">{[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact on file'}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {c && <Button variant="ghost" icon="edit" onClick={() => setEditing(true)}>Edit</Button>}
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-white/6 hover:text-ink">
            <Icon name="close" size={20} />
          </button>
        </div>
      </div>

      {loading || !d || !c || !s ? (
        <div className="p-5"><SkeletonList count={5} /></div>
      ) : (
        <div className="space-y-6 p-5">
          {/* Tags */}
          {(c.tags.length > 0 || c.archived) && (
            <div className="flex flex-wrap gap-1.5">
              {c.archived && <Badge tone="neutral" dot>Archived</Badge>}
              {c.tags.map(t => <Badge key={t} tone="info">{t}</Badge>)}
            </div>
          )}

          {/* Stat row */}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            <MiniStat label="Lifetime value" value={gbp(s.ltv_pence)} tone="text-emerald" />
            <MiniStat label="Outstanding" value={gbp(s.outstanding_pence)} tone={s.outstanding_pence > 0 ? 'text-rose' : 'text-ink'} />
            <MiniStat label="Cleans done" value={String(s.jobs_done)} tone="text-ink" />
            <MiniStat label="Avg rating" value={s.avg_rating != null ? `${s.avg_rating}★` : '—'} tone="text-amber" />
            <MiniStat label="Next clean" value={s.next_job ? fmtDate(s.next_job) : '—'} tone="text-sky" />
            <MiniStat label="Regular / visit" value={s.recurring_pence ? gbp2(s.recurring_pence) : '—'} tone="text-ink" />
          </div>

          {c.notes && (
            <Section icon="sticky_note_2" title="Notes">
              <p className="whitespace-pre-wrap rounded-xl bg-black/20 p-3 text-sm text-ink/90">{c.notes}</p>
            </Section>
          )}

          {/* Properties */}
          <Section icon="home_work" title={`Properties (${d.properties.length})`}>
            {d.properties.length === 0 ? <Empty text="No properties on file." /> : (
              <div className="space-y-1.5">
                {d.properties.map(p => (
                  <div key={p.id} className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.03] px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-ink">{p.address}{p.postcode ? `, ${p.postcode}` : ''}</div>
                      <div className="text-xs text-muted">
                        {gbp2(p.price_pence)} · {p.frequency_weeks ? `every ${p.frequency_weeks}w` : 'ad-hoc'}
                        {p.round_name ? ` · ${p.round_name}` : ''}
                      </div>
                    </div>
                    {!p.active && <Badge tone="neutral">Inactive</Badge>}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Jobs */}
          <Section icon="cleaning_services" title={`Recent jobs (${d.jobs.length})`}>
            {d.jobs.length === 0 ? <Empty text="No jobs yet." /> : (
              <div className="space-y-1">
                {d.jobs.slice(0, 12).map(j => (
                  <div key={j.id} className="flex items-center justify-between gap-2 px-1 py-1 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone={JOB_TONE[j.status] || 'neutral'}>{j.status}</Badge>
                      <span className="truncate text-muted">{fmtDate(j.scheduled_date)}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-xs">
                      {j.rating ? <span className="text-amber">{j.rating}★</span> : null}
                      <span className="text-ink">{gbp2(j.price_pence)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Invoices */}
          <Section icon="receipt_long" title={`Invoices (${d.invoices.length})`}>
            {d.invoices.length === 0 ? <Empty text="No invoices raised." /> : (
              <div className="space-y-1">
                {d.invoices.slice(0, 12).map(inv => (
                  <div key={inv.id} className="flex items-center justify-between gap-2 px-1 py-1 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone={INV_TONE[inv.status] || 'neutral'}>{inv.status}</Badge>
                      <span className="truncate font-mono text-xs text-muted">{inv.number}</span>
                    </div>
                    <span className="shrink-0 text-ink">{gbp2(inv.amount_pence)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Notes & history */}
          <Section icon="forum" title="History & notes">
            <div className="mb-3 flex items-end gap-2">
              <Textarea rows={1} value={note} onChange={e => setNote(e.target.value)}
                placeholder="Add a note (access, complaint, call back…)"
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addNote(); }} />
              <Button variant="secondary" icon="add" loading={savingNote} onClick={addNote}>Note</Button>
            </div>
            {d.comms.length === 0 ? <Empty text="Nothing logged yet." /> : (
              <div className="space-y-2">
                {d.comms.map(m => (
                  <div key={m.id} className="flex gap-2 text-sm">
                    <Icon name={m.kind === 'note' ? 'sticky_note_2' : 'send'} size={15}
                      className="mt-0.5 shrink-0 text-muted/60" />
                    <div className="min-w-0">
                      <div className="text-ink/90">{m.content}</div>
                      <div className="text-[10px] uppercase tracking-wide text-muted/50">{m.kind} · {fmtTs(m.created_at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}

      {editing && c && (
        <EditModal customer={c} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); onChanged(); }} />
      )}
    </Drawer>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-xl border border-white/6 bg-white/[0.02] p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted/60">{label}</div>
      <div className={`mt-0.5 text-lg font-bold ${tone}`}>{value}</div>
    </div>
  );
}
function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <Icon name={icon} size={15} />{title}
      </div>
      {children}
    </div>
  );
}
const Empty = ({ text }: { text: string }) => <p className="px-1 text-sm text-muted/60">{text}</p>;

// ── Edit modal ────────────────────────────────────────────────────────────────
function EditModal({ customer, onClose, onSaved }: {
  customer: CustomerDetail['customer']; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState<CustomerPatch>({
    name: customer.name, email: customer.email || '', phone: customer.phone || '',
    notes: customer.notes || '', tags: customer.tags, archived: customer.archived,
  });
  const [saving, setSaving] = useState(false);
  const [tagText, setTagText] = useState((customer.tags || []).join(', '));
  const set = <K extends keyof CustomerPatch>(k: K, v: CustomerPatch[K]) => setF(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!(f.name || '').trim()) return toast('A name is required', 'warn');
    setSaving(true);
    try {
      await customersApi.update(customer.id, {
        ...f, tags: tagText.split(',').map(t => t.trim()).filter(Boolean),
      });
      toast('Customer updated', 'ok');
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save', 'danger'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title="Edit customer" width="max-w-lg">
      <div className="space-y-3">
        <Field label="Name"><Input value={f.name || ''} onChange={e => set('name', e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email"><Input type="email" value={f.email || ''} onChange={e => set('email', e.target.value)} /></Field>
          <Field label="Phone"><Input value={f.phone || ''} onChange={e => set('phone', e.target.value)} /></Field>
        </div>
        <Field label="Tags (comma separated)">
          <Input value={tagText} onChange={e => setTagText(e.target.value)} placeholder="vip, commercial, cash" />
        </Field>
        <Field label="Notes"><Textarea rows={3} value={f.notes || ''} onChange={e => set('notes', e.target.value)}
          placeholder="Access, gate codes, preferences…" /></Field>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={!!f.archived} onChange={e => set('archived', e.target.checked)}
            className="h-4 w-4 rounded border-white/20 bg-black/30 accent-accent" />
          Archived (hidden from the active book)
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={saving} onClick={save}>Save</Button>
      </div>
    </Modal>
  );
}
