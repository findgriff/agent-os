// KS Sports Coaching — parent account: register, sign in, manage bookings.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  KSShell, KSButton, KSCard, KSInput, KSLabel, KSSelect, KSAlert, KSPill, Spinner, STATUS_PILL,
} from './KSKit';
import {
  ksApi, getParentToken, setParentToken, clearParentToken, money, dayName,
  type KsBooking, type KsInfo, type KsParent,
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
