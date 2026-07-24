// Max Gleam — Crew management (office roster). Add and edit crew, set pay
// rates, log leave, and record payroll. The crew-facing app lives elsewhere;
// this is the office side. Backed by lib/crewAdminApi.ts.
import { useEffect, useState } from 'react';
import {
  Icon, Button, Card, Badge, Input, Select, Textarea, Modal, Drawer,
  EmptyState, SkeletonList, useToast, Stat, Toggle, Field,
} from '../../components/ui';
import { crewAdminApi } from '../../lib/crewAdminApi';
import type {
  CrewRow, CrewSummary, CrewDetail, CrewCore, NewCrew, Leave,
} from '../../lib/crewAdminApi';

const gbp = (p: number) => `£${((p || 0) / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
const gbp2 = (p: number) => `£${((p || 0) / 100).toFixed(2)}`;
const fmtDate = (d?: string | null) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
const fmtTs = (t?: number | null) =>
  t ? new Date(t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '';

const LEAVE_TONE: Record<string, 'info' | 'danger' | 'neutral'> = {
  holiday: 'info', sick: 'danger', unavailable: 'neutral',
};
const JOB_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  done: 'ok', scheduled: 'info', skipped: 'warn', missed: 'danger',
};

export default function CrewManage() {
  const toast = useToast();
  const [crews, setCrews] = useState<CrewRow[]>([]);
  const [summary, setSummary] = useState<CrewSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const load = () => {
    setLoading(true);
    crewAdminApi.list()
      .then(r => { setCrews(r.crews); setSummary(r.summary); setError(''); })
      .catch(e => { setError(e instanceof Error ? e.message : 'Could not load crew'); toast('Could not load crew', 'danger'); })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Crew</h1>
          <p className="text-sm text-muted">Your roster — pay rates, leave and payroll in one place.</p>
        </div>
        <Button variant="primary" icon="person_add" onClick={() => setAdding(true)}>Add crew</Button>
      </div>

      {summary && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Active crew" value={summary.active} icon="badge" accent="#19C3E6" delay={0} />
          <Stat label="On leave" value={summary.on_leave} icon="beach_access" accent="#F59E0B" delay={60} />
          <Stat label="Upcoming jobs" value={summary.upcoming_jobs} icon="event_upcoming" accent="#38BDF8" delay={120} />
          <Stat label="Paid to date" value={gbp(summary.paid_total_pence)} icon="payments" accent="#22C55E" delay={180} />
        </div>
      )}

      {loading ? <SkeletonList count={5} />
        : error && crews.length === 0 ? (
          <EmptyState icon="error" accent="#F43F5E" title="Couldn't load crew" hint={error}
            action={<Button icon="refresh" onClick={load}>Try again</Button>} />
        ) : crews.length === 0 ? (
          <EmptyState icon="engineering" title="No crew yet"
            hint="Add your first cleaner or subcontractor to start." />
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {crews.map((c, i) => (
              <button key={c.id} onClick={() => setOpenId(c.id)} className="text-left">
                <Card hover className={`animate-fadeInUp p-3.5 ${!c.active ? 'opacity-60' : ''}`} style={{ animationDelay: `${i * 30}ms` }}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-ink">{c.name}</span>
                        {c.on_leave && <Badge tone="warn" dot>On leave</Badge>}
                        {!c.active && <Badge tone="neutral">Inactive</Badge>}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted">
                        {c.company_name || c.phone || c.email || 'No contact on file'}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                        <span className="flex items-center gap-1"><Icon name="cleaning_services" size={13} />{c.jobs_done} done</span>
                        {c.upcoming > 0 && <span className="flex items-center gap-1 text-sky"><Icon name="event" size={13} />{c.upcoming} upcoming</span>}
                        <span className="flex items-center gap-1"><Icon name="sell" size={13} />{gbp2(c.rate_per_clean_pence)}/clean</span>
                      </div>
                    </div>
                    <Icon name="chevron_right" size={20} className="shrink-0 text-muted/70" />
                  </div>
                </Card>
              </button>
            ))}
          </div>
        )}

      {openId != null && (
        <CrewDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />
      )}
      {adding && (
        <CrewFormModal onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); }} />
      )}
    </div>
  );
}

// ── Detail drawer ─────────────────────────────────────────────────────────────
function CrewDrawer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<CrewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [deletingLeave, setDeletingLeave] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    crewAdminApi.get(id).then(r => { setD(r); setLoadErr(''); })
      .catch(e => { setLoadErr(e instanceof Error ? e.message : 'Could not load crew'); toast('Could not load crew', 'danger'); })
      .finally(() => setLoading(false));
  };
  useEffect(load, [id]);

  const removeLeave = async (l: Leave) => {
    if (deletingLeave !== null) return;
    setDeletingLeave(l.id);
    try { await crewAdminApi.deleteLeave(l.id); toast('Leave removed', 'ok'); load(); }
    catch { toast('Could not remove leave', 'danger'); }
    finally { setDeletingLeave(null); }
  };

  const c = d?.crew;
  const s = d?.stats;

  return (
    <Drawer open onClose={onClose} width="max-w-2xl">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-white/8 bg-surface/80 px-5 py-4 backdrop-blur">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-bold text-ink">{c?.name || 'Crew'}</h2>
          {c && <p className="truncate text-xs text-muted">{[c.company_name, c.phone, c.email].filter(Boolean).join(' · ') || 'No contact on file'}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {c && <Button variant="ghost" icon="edit" onClick={() => setEditing(true)}>Edit</Button>}
          <button onClick={onClose} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-white/6 hover:text-ink">
            <Icon name="close" size={20} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-5"><SkeletonList count={5} /></div>
      ) : loadErr || !d || !c || !s ? (
        <div className="p-5">
          <EmptyState icon="error" accent="#F43F5E" title="Couldn't load this crew member"
            hint={loadErr || undefined} action={<Button icon="refresh" onClick={load}>Try again</Button>} />
        </div>
      ) : (
        <div className="space-y-6 p-5">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={c.active ? 'ok' : 'neutral'} dot>{c.active ? 'Active' : 'Inactive'}</Badge>
            {s.on_leave && <Badge tone="warn" dot>On leave now</Badge>}
          </div>

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <MiniStat label="Rate / clean" value={gbp2(c.rate_per_clean_pence)} tone="text-ink" />
            <MiniStat label="Cleans done" value={String(s.jobs_done)} tone="text-emerald" />
            <MiniStat label="Upcoming" value={String(s.upcoming)} tone="text-sky" />
            <MiniStat label="Paid to date" value={gbp(s.total_paid_pence)} tone="text-ink" />
          </div>

          {c.notes && (
            <Section icon="sticky_note_2" title="Notes">
              <p className="whitespace-pre-wrap rounded-xl bg-black/20 p-3 text-sm text-ink/90">{c.notes}</p>
            </Section>
          )}

          {/* Leave */}
          <Section icon="beach_access" title="Leave & availability"
            action={<Button variant="ghost" icon="add" onClick={() => setLeaveOpen(true)}>Add</Button>}>
            {d.leave.length === 0 ? <Empty text="No upcoming leave booked." /> : (
              <div className="space-y-1.5">
                {d.leave.map(l => (
                  <div key={l.id} className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.03] px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone={LEAVE_TONE[l.kind] || 'neutral'}>{l.kind}</Badge>
                      <span className="truncate text-sm text-ink">{fmtDate(l.date_from)} – {fmtDate(l.date_to)}</span>
                      {l.notes && <span className="truncate text-xs text-muted">· {l.notes}</span>}
                    </div>
                    <button onClick={() => removeLeave(l)} aria-label="Remove" title="Remove" disabled={deletingLeave === l.id}
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-rose/10 hover:text-rose disabled:opacity-40">
                      <Icon name={deletingLeave === l.id ? 'progress_activity' : 'delete'} size={16}
                        className={deletingLeave === l.id ? 'animate-spin' : ''} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Jobs */}
          <Section icon="cleaning_services" title="Recent jobs">
            {d.jobs.length === 0 ? <Empty text="No jobs assigned yet." /> : (
              <div className="space-y-1">
                {d.jobs.slice(0, 10).map(j => (
                  <div key={j.id} className="flex items-center justify-between gap-2 px-1 py-1 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone={JOB_TONE[j.status] || 'neutral'}>{j.status}</Badge>
                      <span className="truncate text-muted">{fmtDate(j.scheduled_date)} · {j.address}</span>
                    </div>
                    <span className="shrink-0 text-ink tabular-nums">{gbp2(j.price_pence)}</span>
                  </div>
                ))}
                {d.jobs.length > 10 && (
                  <p className="px-1 pt-1 text-xs text-muted">Showing the 10 most recent of {d.jobs.length}.</p>
                )}
              </div>
            )}
          </Section>

          {/* Payroll */}
          <Section icon="payments" title="Payroll"
            action={<Button variant="ghost" icon="add" onClick={() => setPayOpen(true)}>Record</Button>}>
            {d.payroll.length === 0 ? <Empty text="No payments recorded." /> : (
              <div className="space-y-1">
                {d.payroll.map(p => (
                  <div key={p.id} className="flex items-center justify-between gap-2 px-1 py-1 text-sm">
                    <span className="truncate text-muted">
                      {fmtDate(p.date_from)}–{fmtDate(p.date_to)}{p.jobs_done ? ` · ${p.jobs_done} cleans` : ''} · {fmtTs(p.paid_at)}
                    </span>
                    <span className="shrink-0 font-medium text-emerald tabular-nums">{gbp2(p.amount_pence)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}

      {editing && c && (
        <CrewFormModal crew={c} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); onChanged(); }} />
      )}
      {leaveOpen && (
        <LeaveModal crewId={id} onClose={() => setLeaveOpen(false)}
          onSaved={() => { setLeaveOpen(false); load(); onChanged(); }} />
      )}
      {payOpen && c && (
        <PayModal crewId={id} rate={c.rate_per_clean_pence} onClose={() => setPayOpen(false)}
          onSaved={() => { setPayOpen(false); load(); onChanged(); }} />
      )}
    </Drawer>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-xl border border-white/6 bg-white/[0.02] p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-0.5 text-lg font-bold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}
function Section({ icon, title, action, children }: { icon: string; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
          <Icon name={icon} size={15} />{title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
const Empty = ({ text }: { text: string }) => <p className="px-1 text-sm text-muted">{text}</p>;

// ── Add / edit crew ───────────────────────────────────────────────────────────
function CrewFormModal({ crew, onClose, onSaved }: {
  crew?: CrewCore; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [f, setF] = useState<NewCrew & { active?: boolean }>({
    name: crew?.name || '', phone: crew?.phone || '', email: crew?.email || '',
    company_name: crew?.company_name || '', notes: crew?.notes || '',
    rate_per_clean_pence: crew?.rate_per_clean_pence ?? 7000, active: crew?.active ?? true,
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }));

  const save = async () => {
    if (!(f.name || '').trim()) return toast('A name is required', 'warn');
    setSaving(true);
    try {
      if (crew) await crewAdminApi.update(crew.id, f);
      else await crewAdminApi.create(f);
      toast(crew ? 'Crew updated' : 'Crew added', 'ok');
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save', 'danger'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={crew ? 'Edit crew' : 'Add crew'} width="max-w-lg">
      <div className="space-y-3">
        <Field label={<>Name <span className="text-rose">*</span></>}><Input value={f.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Dave Smith" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone"><Input value={f.phone || ''} onChange={e => set('phone', e.target.value)} placeholder="07…" /></Field>
          <Field label="Email"><Input type="email" value={f.email || ''} onChange={e => set('email', e.target.value)} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Company name (optional)"><Input value={f.company_name || ''} onChange={e => set('company_name', e.target.value)} placeholder="Sole trader / Ltd" /></Field>
          <Field label="Pay rate per clean (£)">
            <Input type="number" min={0} step="0.01"
              value={f.rate_per_clean_pence != null ? String(f.rate_per_clean_pence / 100) : ''}
              onChange={e => set('rate_per_clean_pence', Math.round((parseFloat(e.target.value) || 0) * 100))}
              placeholder="70" />
          </Field>
        </div>
        <Field label="Notes"><Textarea rows={2} value={f.notes || ''} onChange={e => set('notes', e.target.value)}
          placeholder="Vehicle, area, day preferences…" /></Field>
        {crew && (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.03] px-3 py-2.5 text-sm text-muted">
            <span>Active (available for assignment)</span>
            <Toggle checked={!!f.active} onChange={() => set('active', !f.active)}
              ariaLabel="Active (available for assignment)" />
          </div>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={saving} onClick={save}>{crew ? 'Save' : 'Add crew'}</Button>
      </div>
    </Modal>
  );
}

// ── Add leave ─────────────────────────────────────────────────────────────────
function LeaveModal({ crewId, onClose, onSaved }: { crewId: number; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState('holiday');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!from) return toast('Pick a start date', 'warn');
    setSaving(true);
    try {
      await crewAdminApi.addLeave(crewId, { kind, date_from: from, date_to: to || from, notes });
      toast('Leave booked', 'ok');
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not save leave', 'danger'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title="Book leave" width="max-w-md">
      <div className="space-y-3">
        <Field label="Type">
          <Select className="w-full" value={kind} onChange={e => setKind(e.target.value)}>
            <option value="holiday">Holiday</option>
            <option value="sick">Sick</option>
            <option value="unavailable">Unavailable</option>
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From"><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
        </div>
        <Field label="Notes (optional)"><Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Cover arranged…" /></Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={saving} onClick={save}>Book</Button>
      </div>
    </Modal>
  );
}

// ── Record payment ────────────────────────────────────────────────────────────
function PayModal({ crewId, rate, onClose, onSaved }: {
  crewId: number; rate: number; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [jobs, setJobs] = useState('');
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  // Convenience: entering a clean count pre-fills the amount at the crew's rate.
  const onJobs = (v: string) => {
    setJobs(v);
    const n = parseInt(v, 10);
    if (n > 0 && !amount) setAmount(String((n * rate) / 100));
  };

  const save = async () => {
    const pence = Math.round((parseFloat(amount) || 0) * 100);
    if (!from) return toast('Pick a start date', 'warn');
    if (pence <= 0) return toast('Enter the amount paid', 'warn');
    setSaving(true);
    try {
      await crewAdminApi.recordPay(crewId, {
        date_from: from, date_to: to || from,
        jobs_done: parseInt(jobs, 10) || 0, amount_pence: pence,
      });
      toast('Payment recorded', 'ok');
      onSaved();
    } catch (e: any) { toast(e?.message || 'Could not record payment', 'danger'); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title="Record payment" width="max-w-md">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Period from"><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="Period to"><Input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cleans (optional)"><Input type="number" min={0} value={jobs} onChange={e => onJobs(e.target.value)} placeholder="12" /></Field>
          <Field label="Amount paid (£)"><Input type="number" min={0} step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="840" /></Field>
        </div>
        <p className="text-xs text-muted/60">Tip: entering a clean count fills the amount at {gbp2(rate)}/clean — edit if it differs.</p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={saving} onClick={save}>Record</Button>
      </div>
    </Modal>
  );
}
