// KS Sports Coaching — coach dashboard.
// Weekly schedule, today's parent contact details, mark sessions complete,
// and block out dates so the booking form stops offering them.
import { useCallback, useEffect, useState } from 'react';
import {
  KSShell, KSButton, KSCard, KSInput, KSLabel, KSAlert, KSPill, Spinner, STATUS_PILL, KSMark,
} from './KSKit';
import {
  ksApi, getCoachToken, setCoachToken, clearCoachToken, dayName, shortDay, isoDate,
  type KsBlock, type KsBooking, type KsSchedule,
} from '../../lib/ksApi';

function SessionRow({ b, onToggle, showContact }:
  { b: KsBooking; onToggle: (b: KsBooking) => void; showContact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const done = b.status === 'completed';
  const cancelled = b.status === 'cancelled';
  return (
    <div className={`rounded-xl border p-3.5 transition-colors
      ${cancelled ? 'border-slate-200 bg-slate-50 opacity-70'
        : done ? 'border-blue-200 bg-blue-50/50' : 'border-slate-200 bg-white'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-bold text-slate-900">
              {b.start_time}–{b.end_time}
            </span>
            <KSPill tone={STATUS_PILL[b.status] || 'slate'}>
              {b.status[0].toUpperCase() + b.status.slice(1)}
            </KSPill>
          </div>
          <div className="mt-1 font-bold text-slate-900">
            {b.child_name}
            {b.child_age ? <span className="font-normal text-slate-500"> · age {b.child_age}</span> : null}
          </div>
          <div className="text-sm text-slate-600">{b.service_name}</div>
          {(b.child_school || b.child_experience) && (
            <div className="mt-0.5 text-xs text-slate-500">
              {[b.child_school, b.child_experience].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        {!cancelled && (
          <KSButton tone={done ? 'secondary' : 'primary'} loading={busy}
            onClick={async () => { setBusy(true); await onToggle(b); setBusy(false); }}>
            {done ? 'Undo' : 'Mark done'}
          </KSButton>
        )}
      </div>

      {b.notes && (
        <p className="mt-2.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-bold">Parent note:</span> {b.notes}
        </p>
      )}

      {showContact && !cancelled && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 text-sm">
          <span className="font-semibold text-slate-700">{b.parent_name}</span>
          {b.parent_phone && (
            <a href={`tel:${b.parent_phone.replace(/\s/g, '')}`}
              className="font-bold text-[#FF6B00] hover:underline">{b.parent_phone}</a>
          )}
          <a href={`mailto:${b.parent_email}`} className="text-slate-500 hover:text-slate-800">
            {b.parent_email}
          </a>
          <span className="ml-auto font-mono text-xs text-slate-400">{b.ref}</span>
        </div>
      )}
    </div>
  );
}

function AvailabilityPanel({ onChanged }: { onChanged: () => void }) {
  const [blocks, setBlocks] = useState<KsBlock[]>([]);
  const [date, setDate] = useState(isoDate(1));
  const [start, setStart] = useState('00:00');
  const [end, setEnd] = useState('23:59');
  const [reason, setReason] = useState('');
  const [allDay, setAllDay] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    ksApi.availability().then(r => setBlocks(r.availability)).catch(() => setBlocks([]));
  }, []);
  useEffect(load, [load]);

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      await ksApi.blockTime({
        date,
        start_time: allDay ? '00:00' : start,
        end_time: allDay ? '23:59' : end,
        reason: reason.trim(),
      });
      setReason('');
      load();
      onChanged();
    } catch (e: any) {
      setError(e?.message || 'Could not block that time.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try { await ksApi.unblock(id); load(); onChanged(); } catch { /* refresh shows truth */ }
  };

  return (
    <KSCard className="p-5">
      <h2 className="text-lg font-bold text-slate-900">Block out time</h2>
      <p className="mt-1 text-sm text-slate-600">
        Parents won't be offered these slots. Existing bookings are never affected.
      </p>

      <div className="mt-4 space-y-3">
        <div>
          <KSLabel>Date</KSLabel>
          <KSInput type="date" value={date} min={isoDate(0)} onChange={e => setDate(e.target.value)} />
        </div>

        <label className="flex items-center gap-2.5 text-sm font-semibold text-slate-700">
          <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-[#FF6B00]" />
          All day
        </label>

        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <KSLabel>From</KSLabel>
              <KSInput type="time" value={start} onChange={e => setStart(e.target.value)} />
            </div>
            <div>
              <KSLabel>To</KSLabel>
              <KSInput type="time" value={end} onChange={e => setEnd(e.target.value)} />
            </div>
          </div>
        )}

        <div>
          <KSLabel hint="(optional)">Reason</KSLabel>
          <KSInput value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Holiday, course, other work…" />
        </div>

        {error && <KSAlert>{error}</KSAlert>}
        <KSButton onClick={add} loading={busy} className="w-full">Block this time</KSButton>
      </div>

      <div className="mt-6 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-bold uppercase tracking-wide text-slate-500">
          Blocked ({blocks.length})
        </h3>
        <div className="mt-3 space-y-2">
          {blocks.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing blocked — you're available on every slot.</p>
          ) : blocks.map(b => (
            <div key={b.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-slate-800">{shortDay(b.date)}</div>
                <div className="text-xs text-slate-500">
                  {b.start_time === '00:00' && b.end_time === '23:59'
                    ? 'All day' : `${b.start_time}–${b.end_time}`}
                  {b.reason ? ` · ${b.reason}` : ''}
                </div>
              </div>
              <button onClick={() => remove(b.id)}
                className="shrink-0 rounded-lg px-2 py-1 text-xs font-bold text-slate-400 hover:bg-red-50 hover:text-red-600">
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
    </KSCard>
  );
}

function CoachLogin({ onAuthed }: { onAuthed: (c: KsSchedule['coach']) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await ksApi.coachLogin(username.trim(), password);
      setCoachToken(res.token);
      onAuthed(res.coach);
    } catch (err: any) {
      setError(err?.message || 'Sign-in failed.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm px-4 py-14 sm:px-6">
      <div className="text-center">
        <div className="flex justify-center"><KSMark size={48} /></div>
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-slate-900">Coach sign-in</h1>
        <p className="mt-1.5 text-slate-600">Your schedule, sessions and availability.</p>
      </div>
      <KSCard className="mt-7 p-6">
        <form onSubmit={submit} className="space-y-4">
          <div>
            <KSLabel>Username</KSLabel>
            <KSInput value={username} onChange={e => setUsername(e.target.value)}
              placeholder="saul or kellie" autoCapitalize="none" autoCorrect="off"
              autoComplete="username" />
          </div>
          <div>
            <KSLabel>Password</KSLabel>
            <KSInput type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" autoComplete="current-password" />
          </div>
          {error && <KSAlert>{error}</KSAlert>}
          <KSButton type="submit" loading={busy} className="w-full py-3">Sign in</KSButton>
        </form>
      </KSCard>
    </div>
  );
}

export default function KSCoach() {
  const [coach, setCoach] = useState<KsSchedule['coach'] | null>(null);
  const [schedule, setSchedule] = useState<KsSchedule | null>(null);
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<'week' | 'today' | 'availability'>('week');
  const [error, setError] = useState('');

  const load = useCallback(async (w?: string) => {
    try {
      const s = await ksApi.schedule(w);
      setSchedule(s);
      setCoach(s.coach);
    } catch (e: any) {
      if (e?.status === 401) { clearCoachToken(); setCoach(null); }
      else setError(e?.message || 'Could not load the schedule.');
    }
  }, []);

  useEffect(() => {
    if (!getCoachToken()) { setBooting(false); return; }
    ksApi.coachMe()
      .then(r => { setCoach(r.coach); return load(); })
      .catch(() => clearCoachToken())
      .finally(() => setBooting(false));
  }, [load]);

  const shiftWeek = (days: number) => {
    const base = schedule ? new Date(`${schedule.week_start}T00:00:00`) : new Date();
    base.setDate(base.getDate() + days);
    const iso = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
    setWeek(iso);
    load(iso);
  };

  const toggleDone = async (b: KsBooking) => {
    try {
      await ksApi.complete(b.ref, b.status !== 'completed');
      await load(week);
    } catch (e: any) {
      setError(e?.message || 'Could not update that session.');
    }
  };

  const signOut = async () => {
    try { await ksApi.coachLogout(); } catch { /* already gone */ }
    clearCoachToken();
    setCoach(null);
    setSchedule(null);
  };

  if (booting) {
    return (
      <KSShell nav={false}>
        <div className="flex min-h-screen items-center justify-center text-slate-400"><Spinner /></div>
      </KSShell>
    );
  }

  if (!coach) {
    return <KSShell nav={false}><CoachLogin onAuthed={c => { setCoach(c); load(); }} /></KSShell>;
  }

  const today = schedule?.today_sessions || [];

  return (
    <KSShell nav={false} footer={false}>
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          <KSMark size={34} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-extrabold tracking-tight text-slate-900">{coach.name}</div>
            <div className="text-[11px] font-medium text-slate-500">KS Coach dashboard</div>
          </div>
          <KSButton tone="ghost" onClick={() => load(week)}>Refresh</KSButton>
          <KSButton tone="ghost" onClick={signOut}>Sign out</KSButton>
        </div>
        <div className="mx-auto flex max-w-5xl gap-1 px-3 sm:px-5">
          {([
            ['week', 'This week'],
            ['today', `Today${today.length ? ` (${today.length})` : ''}`],
            ['availability', 'Availability'],
          ] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`relative px-3 py-2.5 text-sm font-bold transition-colors
                ${tab === id ? 'text-[#FF6B00]' : 'text-slate-500 hover:text-slate-800'}`}>
              {label}
              {tab === id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[#FF6B00]" />}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {error && <div className="mb-5"><KSAlert>{error}</KSAlert></div>}

        {/* ── Totals ─────────────────────────────────────────────── */}
        {schedule && (
          <div className="mb-6 grid grid-cols-3 gap-3">
            {[
              ['Sessions', schedule.totals.sessions, 'text-slate-900'],
              ['Completed', schedule.totals.completed, 'text-blue-600'],
              ['Cancelled', schedule.totals.cancelled, 'text-red-500'],
            ].map(([label, value, tone]) => (
              <KSCard key={label as string} className="p-4">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</div>
                <div className={`mt-1 text-2xl font-extrabold ${tone}`}>{value}</div>
              </KSCard>
            ))}
          </div>
        )}

        {/* ── Week view ──────────────────────────────────────────── */}
        {tab === 'week' && schedule && (
          <>
            <div className="mb-4 flex items-center justify-between gap-2">
              <KSButton tone="secondary" onClick={() => shiftWeek(-7)}>← Previous</KSButton>
              <div className="text-center text-sm font-bold text-slate-700">
                {shortDay(schedule.week_start)} – {shortDay(schedule.week_end)}
              </div>
              <KSButton tone="secondary" onClick={() => shiftWeek(7)}>Next →</KSButton>
            </div>

            <div className="space-y-4">
              {schedule.days.map(d => (
                <div key={d.date}>
                  <h3 className={`mb-2 flex items-center gap-2 text-sm font-bold
                    ${d.is_today ? 'text-[#FF6B00]' : 'text-slate-700'}`}>
                    {dayName(d.date)}
                    {d.is_today && <KSPill tone="orange">Today</KSPill>}
                  </h3>
                  {d.blocks.map(b => (
                    <div key={b.id} className="mb-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3.5 py-2 text-sm text-slate-500">
                      Blocked {b.start_time === '00:00' && b.end_time === '23:59'
                        ? 'all day' : `${b.start_time}–${b.end_time}`}
                      {b.reason ? ` · ${b.reason}` : ''}
                    </div>
                  ))}
                  {d.sessions.length === 0 && d.blocks.length === 0 ? (
                    <p className="px-1 text-sm text-slate-400">No sessions</p>
                  ) : (
                    <div className="space-y-2">
                      {d.sessions.map(b => (
                        <SessionRow key={b.id} b={b} onToggle={toggleDone} showContact={d.is_today} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Today ──────────────────────────────────────────────── */}
        {tab === 'today' && (
          <div className="space-y-3">
            <h2 className="text-lg font-bold text-slate-900">
              {schedule ? dayName(schedule.today) : 'Today'}
            </h2>
            {today.length === 0 ? (
              <KSCard className="p-8 text-center text-slate-500">
                Nothing on today. Enjoy the rest.
              </KSCard>
            ) : today.map(b => (
              <SessionRow key={b.id} b={b} onToggle={toggleDone} showContact />
            ))}
          </div>
        )}

        {/* ── Availability ───────────────────────────────────────── */}
        {tab === 'availability' && <AvailabilityPanel onChanged={() => load(week)} />}
      </main>
    </KSShell>
  );
}
