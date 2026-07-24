// Max Gleam — customer payment portal (/customer/payments).
//
// What is owed, what is coming, what has been settled. The Pay Now button
// asks the server for a SumUp hosted checkout and sends the browser there;
// no card details ever touch this page or this server.
//
// SumUp redirects back here with ?paid=<invoice number> once the customer is
// done, and the payments endpoint re-checks any open checkout on load, so the
// page shows "Paid" on return rather than inviting a second payment.
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  MGShell, MGButton, MGCard, MGInput, MGLabel, MGAlert, MGPill, MGSpinner,
} from './MGKit';
import {
  mgApi, getCustomerToken, setCustomerToken, clearCustomerToken,
  gbp, niceDate, niceStamp,
  type MgCustomer, type MgInvoice, type MgPayments,
} from '../../lib/mgApi';

export default function CustomerPayments() {
  const [signedIn, setSignedIn] = useState(!!getCustomerToken());
  const [data, setData] = useState<MgPayments | null>(null);
  const [customer, setCustomer] = useState<MgCustomer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const returnedFrom = params.get('paid');

  const load = useCallback(async () => {
    if (!getCustomerToken()) { setSignedIn(false); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      setData(await mgApi.payments());
      setSignedIn(true);
    } catch (err) {
      // An expired capability token means sign in again, not an error page.
      if (err && typeof err === 'object' && (err as { status?: number }).status === 401) {
        clearCustomerToken(); setSignedIn(false);
      } else {
        setError(err instanceof Error ? err.message : 'Could not load your account');
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!signedIn) {
    return <PaymentsLogin onAuthed={c => { setCustomer(c); load(); }} />;
  }

  const s = data?.summary;
  const settled = returnedFrom
    && !data?.due.some(i => i.number === returnedFrom);

  return (
    <MGShell compact>
      <main className="mx-auto max-w-2xl px-4 pb-20 pt-6 sm:px-6">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">Payments</h1>
            <p className="mt-1 text-sm text-slate-500">
              {customer?.name ? `${customer.name} · ` : ''}Invoices and payment history
            </p>
          </div>
          <Link to="/customer/login"
            className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-100">
            Back to my account
          </Link>
        </header>

        {/* Returned from SumUp */}
        {returnedFrom && (
          <div className="mb-5">
            {settled ? (
              <MGAlert tone="success">
                Thank you — payment for {returnedFrom} has been received.
              </MGAlert>
            ) : (
              <MGAlert tone="info">
                We haven’t seen the payment for {returnedFrom} land yet. If you’ve
                just paid, give it a moment and refresh.
              </MGAlert>
            )}
            <button onClick={() => { params.delete('paid'); setParams(params, { replace: true }); }}
              className="-mx-2 mt-2 rounded px-2 py-1 text-xs font-semibold text-slate-400 hover:text-slate-600">
              Dismiss
            </button>
          </div>
        )}
        {!!s?.newly_paid.length && !returnedFrom && (
          <div className="mb-5">
            <MGAlert tone="success">
              Payment received for {s.newly_paid.join(', ')}. Thank you.
            </MGAlert>
          </div>
        )}

        {error && (
          <div className="mb-5">
            <MGAlert>{error}</MGAlert>
            <button onClick={() => load()}
              className="mt-2 inline-flex min-h-[44px] items-center rounded-lg px-3 text-sm font-semibold text-[#0E7C93] hover:bg-slate-100">
              Try again
            </button>
          </div>
        )}

        {loading && !data ? (
          <div className="flex justify-center py-20 text-slate-400">
            <MGSpinner className="h-7 w-7" />
          </div>
        ) : !data ? null : (
          <div className="space-y-8">
            {/* Totals */}
            <div className="grid grid-cols-3 gap-2.5">
              <Total label="Due now" value={gbp(s!.unpaid_pence)}
                tone={s!.unpaid_pence > 0 ? 'amber' : 'slate'} />
              <Total label="Coming up" value={gbp(s!.upcoming_pence)} tone="slate" />
              <Total label="Paid" value={gbp(s!.paid_pence)} tone="green" />
            </div>

            {/* Due now */}
            <section>
              <SectionHead title="Due now"
                hint={data.due.length ? 'Pay securely by card through SumUp.' : undefined} />
              {data.due.length === 0 ? (
                <MGCard className="px-6 py-10 text-center">
                  <p className="text-base font-bold text-green-700">All settled</p>
                  <p className="mt-1 text-sm text-slate-500">
                    You have nothing outstanding. Thank you.
                  </p>
                </MGCard>
              ) : (
                <div className="space-y-3">
                  {data.due.map(inv => (
                    <InvoiceCard key={inv.id} invoice={inv}>
                      {data.can_pay_online ? (
                        <PayButton invoice={inv} />
                      ) : (
                        <p className="mt-3 text-sm text-slate-500">
                          Card payment isn’t available right now — please pay by
                          bank transfer or speak to the office.
                        </p>
                      )}
                    </InvoiceCard>
                  ))}
                </div>
              )}
            </section>

            {/* Upcoming cleans */}
            {data.upcoming.length > 0 && (
              <section>
                <SectionHead title="Coming up"
                  hint="Booked cleans — you’ll be invoiced after each visit." />
                <MGCard className="divide-y divide-slate-100">
                  {data.upcoming.map(u => (
                    <div key={u.job_id} className="flex items-center gap-3 p-4">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold">{u.address}</div>
                        <div className="text-xs text-slate-500">
                          {niceDate(u.scheduled_date)}
                          {u.postcode ? ` · ${u.postcode}` : ''}
                        </div>
                      </div>
                      <span className="shrink-0 text-sm font-bold tabular-nums text-slate-700">
                        {gbp(u.price_pence)}
                      </span>
                    </div>
                  ))}
                </MGCard>
              </section>
            )}

            {/* History */}
            <section>
              <SectionHead title="Payment history" />
              {data.history.length === 0 ? (
                <MGCard className="px-6 py-10 text-center text-sm text-slate-500">
                  No payments yet.
                </MGCard>
              ) : (
                <div className="space-y-3">
                  {data.history.map(inv => (
                    <InvoiceCard key={inv.id} invoice={inv} />
                  ))}
                </div>
              )}
            </section>

            <p className="text-center text-xs text-slate-400">
              Card payments are handled by SumUp. Max Gleam never sees or stores
              your card details.
            </p>
          </div>
        )}
      </main>
    </MGShell>
  );
}

// ── Pay Now ─────────────────────────────────────────────────────────────

/** Asks the server for a SumUp checkout, then hands the browser over. */
export function PayButton({ invoice, className = '' }:
  { invoice: MgInvoice; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true); setError(null);
    try {
      const r = await mgApi.pay(invoice.id);
      // A full navigation, not a new tab: in-app browsers on phones often
      // block window.open, and SumUp sends the customer back here anyway.
      window.location.href = r.checkout_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the payment');
      setBusy(false);
    }
  }

  return (
    <div className={`mt-3 ${className}`}>
      <MGButton onClick={pay} loading={busy}
        className="min-h-[52px] w-full text-base">
        {busy ? 'Opening secure checkout…' : `Pay ${gbp(invoice.amount_pence)} now`}
      </MGButton>
      {error && <div className="mt-2"><MGAlert>{error}</MGAlert></div>}
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────

function Total({ label, value, tone }:
  { label: string; value: string; tone: 'amber' | 'green' | 'slate' }) {
  const colour = { amber: 'text-amber-600', green: 'text-green-600', slate: 'text-slate-700' }[tone];
  return (
    <MGCard className="min-w-0 p-3.5">
      <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">
        {label}
      </div>
      <div className={`mt-1 truncate text-base font-extrabold tabular-nums sm:text-xl ${colour}`}
        title={value}>{value}</div>
    </MGCard>
  );
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-extrabold tracking-tight">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-slate-500">{hint}</p>}
    </div>
  );
}

function InvoiceCard({ invoice, children }:
  { invoice: MgInvoice; children?: React.ReactNode }) {
  const paid = invoice.status === 'paid';
  return (
    <MGCard className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-sm font-bold">{invoice.number}</div>
          <div className="truncate text-sm text-slate-600">{invoice.address || '—'}</div>
          <div className="mt-0.5 text-xs text-slate-400">
            Issued {niceStamp(invoice.issued_at)}
            {invoice.paid_at ? ` · Paid ${niceStamp(invoice.paid_at)}` : ''}
            {paid && invoice.method ? ` · ${methodLabel(invoice.method)}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="text-lg font-extrabold tabular-nums">
            {gbp(invoice.amount_pence)}
          </span>
          <MGPill tone={paid ? 'green' : 'amber'}>{paid ? 'Paid' : 'Unpaid'}</MGPill>
        </div>
      </div>
      {invoice.vat_pence > 0 && (
        <p className="mt-1 text-xs text-slate-400">
          Includes {gbp(invoice.vat_pence)} VAT
        </p>
      )}
      {children}
    </MGCard>
  );
}

function methodLabel(method: string): string {
  return {
    cash: 'Cash', transfer: 'Bank transfer',
    sumup_reader: 'Card in person', sumup_online: 'Card online',
  }[method] || method;
}

// ── Sign in ─────────────────────────────────────────────────────────────

function PaymentsLogin({ onAuthed }: { onAuthed: (c: MgCustomer) => void }) {
  const [identifier, setIdentifier] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await mgApi.login(identifier, ref);
      setCustomerToken(r.token);
      onAuthed(r.customer);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not match those details');
      setBusy(false);
    }
  }

  return (
    <MGShell compact>
      <main className="mx-auto max-w-md px-4 py-10 sm:px-6">
        <div className="mb-7 text-center">
          <h1 className="text-2xl font-extrabold tracking-tight">Your payments</h1>
          <p className="mt-1.5 text-sm text-slate-500">
            Sign in to see your invoices and pay by card.
          </p>
        </div>
        <MGCard className="p-5">
          <form onSubmit={submit} className="space-y-4">
            <div>
              <MGLabel hint="(whichever we have for you)">Email or mobile</MGLabel>
              <MGInput required value={identifier} autoComplete="email"
                onChange={e => setIdentifier(e.target.value)}
                placeholder="you@example.com" />
            </div>
            <div>
              <MGLabel hint="(on your invoice or text)">Job reference</MGLabel>
              <MGInput required value={ref} onChange={e => setRef(e.target.value)}
                placeholder="MG-0042" />
            </div>
            {error && <MGAlert>{error}</MGAlert>}
            <MGButton type="submit" loading={busy} className="w-full py-4 text-base">
              Sign in
            </MGButton>
          </form>
        </MGCard>
        <p className="mt-6 text-center text-xs text-slate-400">
          Your reference is on your invoice and in any text we’ve sent you.
        </p>
      </main>
    </MGShell>
  );
}
