// Max Gleam — customer portal. Login with a job reference plus the email or
// mobile on file, then see upcoming cleans, past cleans with their sign-off
// status, payment history, and how to reach the company doing the work.
import { useCallback, useEffect, useState } from 'react';
import {
  MGShell, MGButton, MGCard, MGInput, MGLabel, MGAlert, MGPill, MGSpinner, signoffLook, Stars,
} from './MGKit';
import {
  mgApi, setCustomerToken, clearCustomerToken, getCustomerToken,
  gbp, niceDate, niceStamp, photoUrl,
  type MgCompany, type MgCustomer, type MgInvoice, type MgJob,
} from '../../lib/mgApi';

type Tab = 'cleans' | 'payments' | 'contact';

function JobCard({ job }: { job: MgJob }) {
  const look = signoffLook(job.signoff_status);
  const done = job.status === 'done';
  return (
    <MGCard className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-bold text-slate-900">{niceDate(job.scheduled_date)}</div>
          <div className="truncate text-sm text-slate-600">{job.address}</div>
          {job.postcode && <div className="text-xs text-slate-400">{job.postcode}</div>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="text-sm font-bold tabular-nums text-slate-900">{gbp(job.price_pence)}</span>
          {done ? <MGPill tone={look.tone}>{look.label}</MGPill>
                : <MGPill tone="teal">Scheduled</MGPill>}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span className="font-mono">{job.ref}</span>
        {job.crew_name && <span>Cleaner: {job.crew_name}</span>}
        {job.signoff_at && <span>Signed {niceStamp(job.signoff_at)}</span>}
      </div>

      {job.rating ? (
        <div className="mt-2.5 flex items-center gap-2">
          <Stars value={job.rating} size={16} />
          <span className="text-xs font-semibold text-slate-500">{job.rating}/5</span>
        </div>
      ) : null}

      {job.signoff_note && (
        <p className="mt-2.5 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
          "{job.signoff_note}"
        </p>
      )}

      {!!job.photos.length && (
        <div className="mt-3 grid grid-cols-4 gap-2">
          {job.photos.slice(0, 4).map(p => (
            <img key={p.id} src={photoUrl(p.id)} alt={p.caption || 'Job photo'} loading="lazy"
              className="h-16 w-full rounded-lg border border-slate-200 object-cover" />
          ))}
        </div>
      )}

      {job.can_sign_off && job.signoff_url && (
        <a href={job.signoff_url} className="mt-3 block">
          <MGButton className="w-full">Sign off this clean →</MGButton>
        </a>
      )}
    </MGCard>
  );
}

export default function CustomerPortal() {
  const [customer, setCustomer] = useState<MgCustomer | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<Tab>('cleans');

  const [identifier, setIdentifier] = useState('');
  const [ref, setRef] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [upcoming, setUpcoming] = useState<MgJob[]>([]);
  const [past, setPast] = useState<MgJob[]>([]);
  const [invoices, setInvoices] = useState<MgInvoice[]>([]);
  const [paySummary, setPaySummary] = useState<{ paid_pence: number; unpaid_pence: number; count: number } | null>(null);
  const [company, setCompany] = useState<MgCompany | null>(null);

  const loadAll = useCallback(async () => {
    const [j, p, c] = await Promise.allSettled([mgApi.jobs(), mgApi.payments(), mgApi.contact()]);
    if (j.status === 'fulfilled') {
      setUpcoming(j.value.upcoming);
      setPast(j.value.past);
      setCustomer(j.value.customer);
    }
    if (p.status === 'fulfilled') { setInvoices(p.value.invoices); setPaySummary(p.value.summary); }
    if (c.status === 'fulfilled') setCompany(c.value.company);
  }, []);

  useEffect(() => {
    if (!getCustomerToken()) { setBooting(false); return; }
    mgApi.jobs()
      .then(async r => { setCustomer(r.customer); await loadAll(); })
      .catch(() => clearCustomerToken())
      .finally(() => setBooting(false));
  }, [loadAll]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await mgApi.login(identifier.trim(), ref.trim());
      setCustomerToken(res.token);
      setCustomer(res.customer);
      await loadAll();
    } catch (err: any) {
      setError(err?.message || 'Could not sign you in.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    clearCustomerToken();
    setCustomer(null);
    setUpcoming([]); setPast([]); setInvoices([]); setCompany(null);
    setIdentifier(''); setRef('');
  };

  if (booting) {
    return (
      <MGShell compact>
        <div className="flex min-h-[50vh] items-center justify-center text-slate-400"><MGSpinner /></div>
      </MGShell>
    );
  }

  // ── Signed out ───────────────────────────────────────────────────
  if (!customer) {
    return (
      <MGShell compact>
        <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">Your cleans</h1>
          <p className="mt-1.5 text-slate-600">
            See your visits, sign-offs and payments. No password needed.
          </p>

          <MGCard className="mt-6 p-6">
            <form onSubmit={submit} className="space-y-4">
              <div>
                <MGLabel hint="(whichever we have for you)">Email or mobile number</MGLabel>
                <MGInput value={identifier} onChange={e => setIdentifier(e.target.value)}
                  placeholder="you@example.com or 07…" autoComplete="email"
                  autoCapitalize="none" autoCorrect="off" />
              </div>
              <div>
                <MGLabel hint="(on your invoice or text)">Job reference</MGLabel>
                <MGInput value={ref} onChange={e => setRef(e.target.value)}
                  placeholder="MG-0026" autoCapitalize="characters" autoCorrect="off"
                  spellCheck={false} className="font-mono tracking-wider" />
              </div>
              {error && <MGAlert>{error}</MGAlert>}
              <MGButton type="submit" loading={busy} className="w-full py-3">Sign in</MGButton>
            </form>
          </MGCard>

          <p className="mt-5 text-center text-sm leading-relaxed text-slate-500">
            Can't find your reference? It's on your invoice and in any text we've sent you —
            or give us a call and we'll read it out.
          </p>
        </div>
      </MGShell>
    );
  }

  // ── Signed in ────────────────────────────────────────────────────
  const TABS: { id: Tab; label: string }[] = [
    { id: 'cleans', label: `Cleans${upcoming.length ? ` (${upcoming.length})` : ''}` },
    { id: 'payments', label: 'Payments' },
    { id: 'contact', label: 'Contact' },
  ];

  return (
    <MGShell>
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-extrabold tracking-tight text-slate-900">
              Hi {(customer.name || '').split(' ')[0] || 'there'}
            </h1>
            <p className="truncate text-sm text-slate-500">
              {customer.email || customer.phone}
            </p>
          </div>
          <MGButton tone="ghost" onClick={signOut}>Sign out</MGButton>
        </div>

        {/* Tabs */}
        <div className="mt-5 flex gap-1 overflow-x-auto border-b border-slate-200">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`relative shrink-0 px-3.5 py-2.5 text-sm font-bold transition-colors
                ${tab === t.id ? 'text-[#0E7C93]' : 'text-slate-500 hover:text-slate-800'}`}>
              {t.label}
              {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[#19C3E6]" />}
            </button>
          ))}
        </div>

        {/* ── Cleans ─────────────────────────────────────────────── */}
        {tab === 'cleans' && (
          <div className="mt-6 space-y-8">
            <section>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-500">
                Upcoming cleans
              </h2>
              {upcoming.length === 0 ? (
                <MGCard className="p-6 text-center text-slate-500">
                  Nothing scheduled right now. We'll text you before your next visit.
                </MGCard>
              ) : (
                <div className="space-y-3">{upcoming.map(j => <JobCard key={j.job_id} job={j} />)}</div>
              )}
            </section>

            <section>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-500">
                Past cleans
              </h2>
              {past.length === 0 ? (
                <p className="text-sm text-slate-500">No past cleans on record yet.</p>
              ) : (
                <div className="space-y-3">{past.map(j => <JobCard key={j.job_id} job={j} />)}</div>
              )}
            </section>
          </div>
        )}

        {/* ── Payments ───────────────────────────────────────────── */}
        {tab === 'payments' && (
          <div className="mt-6 space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <MGCard className="p-4">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Paid</div>
                <div className="mt-1 text-2xl font-extrabold text-green-600">
                  {gbp(paySummary?.paid_pence || 0)}
                </div>
              </MGCard>
              <MGCard className="p-4">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Outstanding</div>
                <div className="mt-1 text-2xl font-extrabold text-amber-600">
                  {gbp(paySummary?.unpaid_pence || 0)}
                </div>
              </MGCard>
            </div>

            {invoices.length === 0 ? (
              <MGCard className="p-6 text-center text-slate-500">No invoices yet.</MGCard>
            ) : (
              <div className="space-y-3">
                {invoices.map(inv => (
                  <MGCard key={inv.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-mono font-bold text-slate-900">{inv.number}</div>
                        <div className="truncate text-sm text-slate-600">{inv.address || '—'}</div>
                        <div className="text-xs text-slate-400">
                          Issued {niceStamp(inv.issued_at)}
                          {inv.paid_at ? ` · Paid ${niceStamp(inv.paid_at)}` : ''}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <span className="font-bold tabular-nums text-slate-900">{gbp(inv.amount_pence)}</span>
                        <MGPill tone={inv.status === 'paid' ? 'green' : 'amber'}>
                          {inv.status === 'paid' ? 'Paid' : 'Unpaid'}
                        </MGPill>
                      </div>
                    </div>
                    {inv.status === 'unpaid' && inv.sumup_checkout_url && (
                      <a href={inv.sumup_checkout_url} target="_blank" rel="noopener noreferrer"
                        className="mt-3 block">
                        <MGButton className="w-full">Pay this invoice</MGButton>
                      </a>
                    )}
                  </MGCard>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Contact ────────────────────────────────────────────── */}
        {tab === 'contact' && (
          <div className="mt-6">
            {company ? (
              <MGCard className="p-6">
                <h2 className="text-lg font-bold text-slate-900">{company.name}</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Looks after the cleaning at your property.
                </p>
                <div className="mt-5 space-y-3">
                  {company.contact_name && (
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Contact</div>
                      <div className="font-semibold text-slate-800">{company.contact_name}</div>
                    </div>
                  )}
                  {company.contact_phone && (
                    <a href={`tel:${company.contact_phone.replace(/\s/g, '')}`}
                      className="block rounded-xl border border-slate-200 p-4 transition-colors hover:border-[#19C3E6] hover:bg-[#19C3E6]/5">
                      <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Phone</div>
                      <div className="mt-0.5 font-bold text-slate-900">{company.contact_phone}</div>
                    </a>
                  )}
                  {company.contact_email && (
                    <a href={`mailto:${company.contact_email}`}
                      className="block rounded-xl border border-slate-200 p-4 transition-colors hover:border-[#19C3E6] hover:bg-[#19C3E6]/5">
                      <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Email</div>
                      <div className="mt-0.5 break-words font-bold text-slate-900">{company.contact_email}</div>
                    </a>
                  )}
                </div>
              </MGCard>
            ) : (
              <MGCard className="p-6 text-center text-slate-500">
                Your cleans are handled directly by Max Gleam — give us a call any time.
              </MGCard>
            )}
          </div>
        )}
      </div>
    </MGShell>
  );
}
