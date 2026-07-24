// KS Sports Coaching — parent account: register, sign in, manage bookings.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  KSShell, KSButton, KSCard, KSInput, KSLabel, KSSelect, KSAlert, KSPill, Spinner, STATUS_PILL,
} from './KSKit';
import {
  ksApi, getParentToken, setParentToken, clearParentToken, money, dayName, shortDay,
  type KsAttendanceTotals, type KsBooking, type KsInfo, type KsParent, type KsPlan,
  type KsProgress, type KsSubInvoice, type KsSubscription,
} from '../../lib/ksApi';

function BookingCard({ b, onCancel, cutoff }:
  { b: KsBooking; onCancel?: (ref: string) => void; cutoff: number }) {
  const [busy, setBusy] = useState(false);
  return (
    <KSCard className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-bold text-slate-900">{b.service_name}</h3>
          <p className="mt-0.5 text-sm text-slate-600">
            {dayName(b.date)} · {b.start_time}–{b.end_time}
          </p>
        </div>
        <KSPill tone={STATUS_PILL[b.status] || 'slate'}>
          {b.status[0].toUpperCase() + b.status.slice(1)}
        </KSPill>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
        {[
          ['Player', b.child_name],
          ['Coach', b.coach_name || '—'],
          ['Price from', money(b.price_pence)],
          ['Ref', b.ref],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{k}</dt>
            <dd className="truncate font-semibold text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>

      {b.coach_notes && (
        <p className="mt-3 rounded-xl bg-blue-50 px-3 py-2 text-sm text-blue-800">
          <span className="font-bold">Coach notes:</span> {b.coach_notes}
        </p>
      )}

      {onCancel && b.status === 'confirmed' && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          {b.can_cancel ? (
            <KSButton tone="danger" loading={busy}
              onClick={async () => { setBusy(true); await onCancel(b.ref); setBusy(false); }}>
              Cancel this session
            </KSButton>
          ) : (
            <p className="text-sm text-slate-500">
              Within {cutoff} hours of kick-off — please call{' '}
              <a href="tel:07939554798" className="font-bold text-[#FF6B00] hover:underline">
                07939 554 798
              </a>{' '}to rearrange.
            </p>
          )}
        </div>
      )}
    </KSCard>
  );
}

/** A child's progress timeline plus their attendance record. */
function ProgressPanel() {
  const [children, setChildren] = useState<string[]>([]);
  const [child, setChild] = useState('');
  const [progress, setProgress] = useState<KsProgress | null>(null);
  const [attendance, setAttendance] = useState<KsAttendanceTotals | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ksApi.progressChildren()
      .then(r => { setChildren(r.children); setChild(c => c || r.children[0] || ''); })
      .catch(() => setChildren([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!child) { setProgress(null); setAttendance(null); return; }
    setLoading(true);
    Promise.all([
      ksApi.progress(child).catch(() => null),
      ksApi.attendanceHistory(child).catch(() => null),
    ]).then(([p, a]) => {
      setProgress(p);
      setAttendance(a?.totals || null);
    }).finally(() => setLoading(false));
  }, [child]);

  if (loading && !progress) {
    return <div className="flex justify-center py-12 text-slate-400"><Spinner /></div>;
  }
  if (!children.length) {
    return (
      <KSCard className="p-8 text-center">
        <p className="text-slate-600">
          Once your player has been to a session, their coach's notes appear here.
        </p>
      </KSCard>
    );
  }

  const stat = (label: string, value: React.ReactNode, tone = 'text-slate-900') => (
    <KSCard key={label} className="p-4">
      <div className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-extrabold ${tone}`}>{value}</div>
    </KSCard>
  );

  return (
    <div className="space-y-6">
      {children.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {children.map(c => (
            <button key={c} onClick={() => setChild(c)}
              className={`rounded-full border px-4 py-1.5 text-sm font-bold transition-colors
                ${child === c ? 'border-[#FF6B00] bg-[#FF6B00] text-white'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400'}`}>
              {c}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat('Sessions', progress?.summary.sessions ?? 0)}
        {stat('Average', progress?.summary.average_rating != null
          ? `${progress.summary.average_rating}/5` : '—', 'text-[#FF6B00]')}
        {stat('Attendance', attendance?.rate != null ? `${attendance.rate}%` : '—',
          attendance?.rate != null && attendance.rate < 70 ? 'text-red-500' : 'text-green-600')}
        {stat('Missed', attendance?.absent ?? 0,
          (attendance?.absent || 0) > 0 ? 'text-red-500' : 'text-slate-900')}
      </div>

      {!!progress?.skills_worked_on.length && (
        <section>
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">
            Skills worked on
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {progress.skills_worked_on.map(s => (
              <span key={s.key}
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-semibold text-slate-700">
                {s.label}
                <span className="ml-1.5 text-slate-400">×{s.sessions}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">Timeline</h3>
        {!progress?.notes.length ? (
          <p className="mt-3 text-slate-500">
            No coach notes yet for {child}. They'll appear here after each session.
          </p>
        ) : (
          <ol className="mt-4 space-y-0">
            {progress.notes.map((n, i) => (
              <li key={n.id} className="relative flex gap-4 pb-6">
                {/* Spine, stopped short on the last entry so it doesn't dangle. */}
                {i < progress.notes.length - 1 && (
                  <span className="absolute left-[7px] top-4 h-full w-0.5 bg-slate-200" aria-hidden />
                )}
                <span className="relative z-10 mt-1.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-white bg-[#FF6B00] ring-1 ring-slate-200" />
                <KSCard className="min-w-0 flex-1 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-slate-900">
                      {n.date ? shortDay(n.date) : ''}
                    </span>
                    <span className="text-xs text-slate-500">{n.service_name}</span>
                    {n.rating != null && (
                      <KSPill tone={n.rating >= 4 ? 'green' : n.rating >= 3 ? 'orange' : 'slate'}>
                        {n.rating}/5 {n.rating_label}
                      </KSPill>
                    )}
                  </div>
                  {!!n.skill_labels.length && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {n.skill_labels.map(l => (
                        <span key={l} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                          {l}
                        </span>
                      ))}
                    </div>
                  )}
                  {n.notes && <p className="mt-2.5 text-sm text-slate-700">{n.notes}</p>}
                  {n.coach_name && (
                    <p className="mt-2 text-xs font-semibold text-slate-400">— {n.coach_name}</p>
                  )}
                </KSCard>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** Monthly plan: sign up, see what's been billed, cancel. */
function BillingPanel() {
  const [plans, setPlans] = useState<KsPlan[]>([]);
  const [sub, setSub] = useState<KsSubscription | null>(null);
  const [invoices, setInvoices] = useState<KsSubInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    ksApi.subscription()
      .then(r => { setSub(r.subscription); setInvoices(r.invoices); setPlans(r.plans); })
      .catch(e => setError(e?.message || 'Could not load your plan.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const subscribe = async (plan: string) => {
    setBusy(plan);
    setError('');
    try {
      const r = await ksApi.subscribe(plan);
      setNotice(`You're on ${r.subscription.plan_label}. First payment ${shortDay(r.first_bill_on)} — the rest of this month is free.`);
      load();
    } catch (e: any) {
      setError(e?.message || 'Could not start that plan.');
    } finally {
      setBusy('');
    }
  };

  const cancel = async () => {
    setBusy('cancel');
    setError('');
    try {
      const r = await ksApi.unsubscribe();
      setNotice(r.note);
      load();
    } catch (e: any) {
      setError(e?.message || 'Could not cancel that plan.');
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return <div className="flex justify-center py-12 text-slate-400"><Spinner /></div>;
  }

  const live = sub?.active ? sub : null;

  return (
    <div className="space-y-8">
      {notice && <KSAlert tone="success">{notice}</KSAlert>}
      {error && <KSAlert>{error}</KSAlert>}

      {live ? (
        <KSCard className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <KSPill tone="green">Active plan</KSPill>
              <h3 className="mt-2 text-xl font-extrabold text-slate-900">{live.plan_label}</h3>
              <p className="mt-1 text-slate-600">
                {money(live.amount_pence)} a month
                {live.next_billing_date
                  ? ` · next payment ${shortDay(live.next_billing_date)}` : ''}
              </p>
            </div>
            <KSButton tone="ghost" loading={busy === 'cancel'} onClick={cancel}>
              Cancel plan
            </KSButton>
          </div>
          {live.sessions_included != null && (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <div className="flex items-center justify-between text-sm font-semibold text-slate-700">
                <span>This month</span>
                <span>{live.sessions_used_this_month ?? 0} of {live.sessions_included} booked</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-[#FF6B00]"
                  style={{ width: `${Math.min(100, ((live.sessions_used_this_month ?? 0) / live.sessions_included) * 100)}%` }} />
              </div>
            </div>
          )}
        </KSCard>
      ) : (
        <section>
          <h3 className="text-xl font-bold text-slate-900">Move to a monthly plan</h3>
          <p className="mt-1 text-slate-600">
            One payment a month instead of paying session by session. Cancel any time.
          </p>
          {sub && !sub.active && (
            <p className="mt-2 text-sm text-slate-500">
              Your previous plan ended{sub.cancelled_at
                ? ` on ${shortDay(new Date(sub.cancelled_at * 1000).toISOString().slice(0, 10))}` : ''}.
            </p>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {plans.map(p => (
              <KSCard key={p.key} className="flex flex-col p-5">
                <h4 className="font-bold text-slate-900">{p.label}</h4>
                <div className="mt-2 text-3xl font-extrabold text-slate-900">
                  {money(p.amount_pence)}
                  <span className="text-base font-semibold text-slate-400">/mo</span>
                </div>
                <p className="mt-2 flex-1 text-sm text-slate-600">{p.blurb}</p>
                <KSButton className="mt-4 w-full" loading={busy === p.key}
                  onClick={() => subscribe(p.key)}>
                  Choose this plan
                </KSButton>
              </KSCard>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500">Payments</h3>
        {invoices.length === 0 ? (
          <p className="mt-3 text-slate-500">Nothing billed yet.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {invoices.map(i => (
              <KSCard key={i.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-slate-900">
                    {new Date(`${i.period_start}T00:00:00`)
                      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
                  </div>
                  <div className="text-xs text-slate-500">
                    {shortDay(i.period_start)} – {shortDay(i.period_end)}
                  </div>
                </div>
                <span className="font-extrabold text-slate-900">{money(i.amount_pence)}</span>
                <KSPill tone={i.status === 'paid' ? 'green' : i.status === 'failed' ? 'red' : 'orange'}>
                  {i.status === 'paid' ? 'Paid' : i.status === 'failed' ? 'Failed' : 'Due'}
                </KSPill>
                {i.status !== 'paid' && i.checkout_url && (
                  <a href={i.checkout_url} target="_blank" rel="noreferrer">
                    <KSButton>Pay now</KSButton>
                  </a>
                )}
              </KSCard>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default function KSAccount() {
  const [parent, setParent] = useState<KsParent | null>(null);
  const [booting, setBooting] = useState(true);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [info, setInfo] = useState<KsInfo | null>(null);

  // form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [childName, setChildName] = useState('');
  const [childAge, setChildAge] = useState('');
  const [childSchool, setChildSchool] = useState('');
  const [childExperience, setChildExperience] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // bookings
  const [upcoming, setUpcoming] = useState<KsBooking[]>([]);
  const [history, setHistory] = useState<KsBooking[]>([]);
  const [cutoff, setCutoff] = useState(24);
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<'sessions' | 'progress' | 'billing'>('sessions');

  useEffect(() => { ksApi.info().then(setInfo).catch(() => { /* non-fatal */ }); }, []);

  const loadBookings = useCallback(async () => {
    try {
      const res = await ksApi.bookings();
      setUpcoming(res.upcoming);
      setHistory(res.history);
      setCutoff(res.cancel_cutoff_hours);
    } catch { /* an empty list is the honest fallback */ }
  }, []);

  useEffect(() => {
    if (!getParentToken()) { setBooting(false); return; }
    ksApi.parentMe()
      .then(r => { setParent(r.parent); return loadBookings(); })
      .catch(() => clearParentToken())
      .finally(() => setBooting(false));
  }, [loadBookings]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = mode === 'login'
        ? await ksApi.login(email.trim(), password)
        : await ksApi.register({
            name: name.trim(), email: email.trim(), phone: phone.trim(), password,
            child_name: childName.trim(), child_age: childAge || null,
            child_school: childSchool.trim(), child_experience: childExperience,
          });
      setParentToken(res.token);
      setParent(res.parent);
      setPassword('');
      await loadBookings();
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try { await ksApi.parentLogout(); } catch { /* token may already be gone */ }
    clearParentToken();
    setParent(null);
    setUpcoming([]);
    setHistory([]);
  };

  const cancel = async (ref: string) => {
    setNotice('');
    setError('');
    try {
      await ksApi.cancel(ref);
      setNotice(`Booking ${ref} cancelled. We've freed the slot up.`);
      await loadBookings();
    } catch (e: any) {
      setError(e?.message || 'Could not cancel that booking.');
    }
  };

  if (booting) {
    return (
      <KSShell>
        <div className="flex min-h-[50vh] items-center justify-center text-slate-400">
          <Spinner />
        </div>
      </KSShell>
    );
  }

  // ── Signed in ────────────────────────────────────────────────────
  if (parent) {
    return (
      <KSShell>
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">
                Hi {parent.name.split(' ')[0]}
              </h1>
              <p className="mt-1 text-slate-600">{parent.email}</p>
            </div>
            <div className="flex gap-2">
              <Link to="/ks/book"><KSButton>Book a session</KSButton></Link>
              <KSButton tone="ghost" onClick={signOut}>Sign out</KSButton>
            </div>
          </div>

          {notice && <div className="mt-5"><KSAlert tone="success">{notice}</KSAlert></div>}
          {error && <div className="mt-5"><KSAlert>{error}</KSAlert></div>}

          <div className="mt-7 flex gap-1 border-b border-slate-200">
            {([
              ['sessions', `Sessions${upcoming.length ? ` (${upcoming.length})` : ''}`],
              ['progress', 'Progress'],
              ['billing', 'Billing'],
            ] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`relative px-4 py-2.5 text-sm font-bold transition-colors
                  ${tab === id ? 'text-[#FF6B00]' : 'text-slate-500 hover:text-slate-800'}`}>
                {label}
                {tab === id && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[#FF6B00]" />
                )}
              </button>
            ))}
          </div>

          {tab === 'progress' && <div className="mt-8"><ProgressPanel /></div>}
          {tab === 'billing' && <div className="mt-8"><BillingPanel /></div>}

          {tab === 'sessions' && (
          <>
          <section className="mt-8">
            <h2 className="text-xl font-bold text-slate-900">
              Upcoming sessions{' '}
              <span className="text-base font-semibold text-slate-400">({upcoming.length})</span>
            </h2>
            <div className="mt-4 space-y-3">
              {upcoming.length === 0 ? (
                <KSCard className="p-8 text-center">
                  <p className="text-slate-600">Nothing booked yet.</p>
                  <Link to="/ks/book" className="mt-4 inline-block">
                    <KSButton>Book your first session</KSButton>
                  </Link>
                </KSCard>
              ) : upcoming.map(b => (
                <BookingCard key={b.id} b={b} onCancel={cancel} cutoff={cutoff} />
              ))}
            </div>
          </section>

          <section className="mt-10">
            <h2 className="text-xl font-bold text-slate-900">
              Booking history{' '}
              <span className="text-base font-semibold text-slate-400">({history.length})</span>
            </h2>
            <div className="mt-4 space-y-3">
              {history.length === 0 ? (
                <p className="text-slate-500">Past and cancelled sessions will appear here.</p>
              ) : history.map(b => <BookingCard key={b.id} b={b} cutoff={cutoff} />)}
            </div>
          </section>

          {!!parent.children.length && (
            <section className="mt-10">
              <h2 className="text-xl font-bold text-slate-900">Your players</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {parent.children.map(c => (
                  <KSCard key={c.id} className="p-4">
                    <div className="font-bold text-slate-900">{c.name}</div>
                    <div className="mt-1 text-sm text-slate-600">
                      {[c.age ? `Age ${c.age}` : null, c.school, c.experience]
                        .filter(Boolean).join(' · ') || 'No details yet'}
                    </div>
                  </KSCard>
                ))}
              </div>
            </section>
          )}
          </>
          )}
        </div>
      </KSShell>
    );
  }

  // ── Signed out ───────────────────────────────────────────────────
  return (
    <KSShell>
      <div className="mx-auto max-w-md px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">
          {mode === 'login' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p className="mt-1.5 text-slate-600">
          {mode === 'login'
            ? 'Sign in to see your bookings and manage sessions.'
            : 'One account for all your bookings, with text reminders before every session.'}
        </p>

        <KSCard className="mt-7 p-6">
          <div className="mb-6 flex rounded-xl bg-slate-100 p-1">
            {(['login', 'register'] as const).map(m => (
              <button key={m} onClick={() => { setMode(m); setError(''); }}
                className={`flex-1 rounded-lg py-2 text-sm font-bold transition-all
                  ${mode === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                {m === 'login' ? 'Sign in' : 'Register'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            {mode === 'register' && (
              <>
                <div>
                  <KSLabel>Your name</KSLabel>
                  <KSInput value={name} onChange={e => setName(e.target.value)}
                    placeholder="Parent / guardian" autoComplete="name" />
                </div>
                <div>
                  <KSLabel>Mobile</KSLabel>
                  <KSInput type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                    placeholder="07…" autoComplete="tel" />
                </div>
              </>
            )}

            <div>
              <KSLabel>Email</KSLabel>
              <KSInput type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" autoComplete="email" />
            </div>
            <div>
              <KSLabel hint={mode === 'register' ? '(8+ characters)' : undefined}>Password</KSLabel>
              <KSInput type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            </div>

            {mode === 'register' && (
              <div className="space-y-4 border-t border-slate-100 pt-4">
                <h3 className="font-bold text-slate-900">
                  Your player <span className="font-normal text-slate-400">(optional)</span>
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <KSLabel>Name</KSLabel>
                    <KSInput value={childName} onChange={e => setChildName(e.target.value)}
                      placeholder="e.g. Alfie" />
                  </div>
                  <div>
                    <KSLabel>Age</KSLabel>
                    <KSInput type="number" min={3} max={18} value={childAge}
                      onChange={e => setChildAge(e.target.value)} placeholder="9" />
                  </div>
                </div>
                <div>
                  <KSLabel>School</KSLabel>
                  <KSInput value={childSchool} onChange={e => setChildSchool(e.target.value)}
                    placeholder="e.g. Wincham Primary" />
                </div>
                <div>
                  <KSLabel>Experience</KSLabel>
                  <KSSelect value={childExperience} onChange={e => setChildExperience(e.target.value)}>
                    <option value="">Select…</option>
                    {(info?.experience_levels || []).map(l => <option key={l} value={l}>{l}</option>)}
                  </KSSelect>
                </div>
              </div>
            )}

            {error && <KSAlert>{error}</KSAlert>}

            <KSButton type="submit" loading={busy} className="w-full py-3">
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </KSButton>
          </form>
        </KSCard>

        <p className="mt-5 text-center text-sm text-slate-500">
          Booked as a guest? Register with the same email and we'll link those bookings to your account.
        </p>
        <p className="mt-3 text-center text-sm text-slate-400">
          Coach? <Link to="/ks/coach" className="font-bold text-[#FF6B00] hover:underline">Sign in here</Link>
        </p>
      </div>
    </KSShell>
  );
}
