// KS Sports Coaching — 4-step booking flow.
// Service → date & time → player details → review & confirm.
// Works signed-in (details prefilled from the account) or as a guest.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  KSShell, KSButton, KSCard, KSInput, KSLabel, KSSelect, KSTextarea, KSAlert, KSPill, Spinner,
} from './KSKit';
import {
  ksApi, getParentToken, money, dayName, shortDay, isoDate,
  type KsInfo, type KsService, type KsSlot, type KsBooking, type KsParent,
} from '../../lib/ksApi';

const STEPS = ['Service', 'Date & time', 'Player', 'Confirm'];
const DATE_WINDOW = 28;   // days offered in the picker

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-7 flex items-center gap-1.5 sm:gap-3">
      {STEPS.map((label, i) => {
        const state = i < step ? 'done' : i === step ? 'active' : 'todo';
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
            <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold transition-colors
              ${state === 'done' ? 'bg-green-500 text-white'
                : state === 'active' ? 'bg-[#FF6B00] text-white'
                : 'bg-slate-200 text-slate-500'}`}>
              {state === 'done' ? '✓' : i + 1}
            </span>
            <span className={`hidden truncate text-sm font-semibold sm:block
              ${state === 'todo' ? 'text-slate-400' : 'text-slate-900'}`}>
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span className={`h-0.5 flex-1 rounded-full ${i < step ? 'bg-green-500' : 'bg-slate-200'}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default function KSBook() {
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [info, setInfo] = useState<KsInfo | null>(null);
  const [parent, setParent] = useState<KsParent | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');

  // Step 1 — service
  const [serviceKey, setServiceKey] = useState(params.get('service') || '');
  // Step 2 — date + slot
  const [date, setDate] = useState(isoDate(1));
  const [slots, setSlots] = useState<KsSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsReason, setSlotsReason] = useState('');
  const [startTime, setStartTime] = useState('');
  const [coachId, setCoachId] = useState<number | null>(null);
  // Step 3 — player + parent
  const [childName, setChildName] = useState('');
  const [childAge, setChildAge] = useState('');
  const [childSchool, setChildSchool] = useState('');
  const [childExperience, setChildExperience] = useState('');
  const [parentName, setParentName] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [parentPhone, setParentPhone] = useState('');
  const [notes, setNotes] = useState('');
  // Step 4
  const [booking, setBooking] = useState<KsBooking | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { ksApi.info().then(setInfo).catch(() => setError('Could not load services.')); }, []);

  // Prefill from the parent account when one is signed in.
  useEffect(() => {
    if (!getParentToken()) return;
    ksApi.parentMe().then(r => {
      setParent(r.parent);
      setParentName(n => n || r.parent.name);
      setParentEmail(e => e || r.parent.email);
      setParentPhone(p => p || r.parent.phone || '');
      const kid = r.parent.children[0];
      if (kid) {
        setChildName(n => n || kid.name);
        setChildAge(a => a || (kid.age ? String(kid.age) : ''));
        setChildSchool(s => s || kid.school || '');
        setChildExperience(x => x || kid.experience || '');
      }
    }).catch(() => { /* stale token — guest checkout still works */ });
  }, []);

  const bookable = useMemo(() => (info?.services || []).filter(s => s.bookable), [info]);
  const service: KsService | undefined = bookable.find(s => s.key === serviceKey);

  const loadSlots = useCallback(async (svc: string, d: string) => {
    if (!svc || !d) return;
    setSlotsLoading(true);
    setSlotsReason('');
    try {
      const res = await ksApi.slots(svc, d);
      setSlots(res.slots || []);
      setSlotsReason(res.reason || '');
    } catch (e: any) {
      setSlots([]);
      setSlotsReason(e?.message || 'Could not load times.');
    } finally {
      setSlotsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step === 1 && serviceKey) {
      setStartTime('');
      setCoachId(null);
      loadSlots(serviceKey, date);
    }
  }, [step, serviceKey, date, loadSlots]);

  const dates = useMemo(
    () => Array.from({ length: DATE_WINDOW }, (_, i) => isoDate(i)), []);

  const selectedSlot = slots.find(s => s.start_time === startTime);

  const canAdvance = [
    !!serviceKey,
    !!startTime,
    !!childName.trim() && !!parentName.trim() && /\S+@\S+\.\S+/.test(parentEmail),
    true,
  ][step];

  const confirm = async () => {
    setSubmitting(true);
    setError('');
    try {
      const res = await ksApi.book({
        service_key: serviceKey,
        date,
        start_time: startTime,
        coach_id: coachId,
        child_name: childName.trim(),
        child_age: childAge || null,
        child_school: childSchool.trim(),
        child_experience: childExperience,
        parent_name: parentName.trim(),
        parent_email: parentEmail.trim(),
        parent_phone: parentPhone.trim(),
        notes: notes.trim(),
      });
      setBooking(res.booking);
    } catch (e: any) {
      setError(e?.message || 'Could not complete the booking.');
      // A taken slot means the times on screen are stale — go back and refresh.
      if (e?.status === 409) {
        setStep(1);
        loadSlots(serviceKey, date);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ── Confirmation screen ───────────────────────────────────────────
  if (booking) {
    return (
      <KSShell>
        <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
          <KSCard className="p-7 text-center sm:p-10">
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-green-100 text-3xl">
              ✓
            </span>
            <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-slate-900">
              You're booked in!
            </h1>
            <p className="mt-2 text-slate-600">
              We've sent a confirmation text to {booking.parent_phone || 'your phone'}.
              Reference <span className="font-mono font-bold text-slate-900">{booking.ref}</span>.
            </p>

            <div className="mt-7 space-y-2.5 rounded-2xl bg-slate-50 p-5 text-left">
              {[
                ['Session', booking.service_name],
                ['Player', booking.child_name],
                ['When', `${dayName(booking.date)} at ${booking.start_time}`],
                ['Coach', booking.coach_name || '—'],
                ['From', money(booking.price_pence)],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 text-[15px]">
                  <span className="text-slate-500">{k}</span>
                  <span className="text-right font-bold text-slate-900">{v}</span>
                </div>
              ))}
            </div>

            <p className="mt-5 text-sm leading-relaxed text-slate-500">
              Bring boots or astros, shin pads, a filled water bottle and layers for the weather.
              Balls, bibs, cones and goals are all provided.
            </p>

            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Link to="/ks/login"><KSButton>View my bookings</KSButton></Link>
              <KSButton tone="secondary" onClick={() => {
                setBooking(null); setStep(0); setStartTime(''); setServiceKey('');
              }}>Book another</KSButton>
            </div>

            {!parent && (
              <p className="mt-6 border-t border-slate-100 pt-5 text-sm text-slate-500">
                <Link to="/ks/login" className="font-bold text-[#FF6B00] hover:underline">
                  Create an account
                </Link>{' '}
                with {booking.parent_email} to manage this booking online.
              </p>
            )}
          </KSCard>
        </div>
      </KSShell>
    );
  }

  return (
    <KSShell>
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900">Book a session</h1>
        <p className="mt-1.5 text-slate-600">
          Four quick steps. You'll get a text as soon as it's confirmed.
        </p>

        <div className="mt-8">
          <Stepper step={step} />

          <KSCard className="p-5 sm:p-7">
            {error && <div className="mb-5"><KSAlert>{error}</KSAlert></div>}

            {/* ── Step 1: service ────────────────────────────────── */}
            {step === 0 && (
              <>
                <h2 className="text-xl font-bold text-slate-900">What would you like to book?</h2>
                {!info && <div className="mt-5 flex items-center gap-2 text-slate-400"><Spinner /> Loading…</div>}
                <div className="mt-5 space-y-3">
                  {bookable.map(s => (
                    <button key={s.key} onClick={() => setServiceKey(s.key)}
                      className={`flex w-full items-start gap-3 rounded-xl border-2 p-4 text-left transition-all
                        ${serviceKey === s.key
                          ? 'border-[#FF6B00] bg-orange-50'
                          : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}>
                      <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2
                        ${serviceKey === s.key ? 'border-[#FF6B00] bg-[#FF6B00]' : 'border-slate-300'}`}>
                        {serviceKey === s.key && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-slate-900">{s.name}</span>
                          <KSPill tone="orange">{s.price}</KSPill>
                        </span>
                        <span className="mt-1 block text-sm leading-relaxed text-slate-600">
                          {s.description}
                        </span>
                        <span className="mt-1 block text-xs text-slate-500">
                          {s.duration} · {s.audience}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-4 text-sm text-slate-500">
                  Looking for after-school clubs at your school? Those are quoted individually —{' '}
                  <a href="tel:07939554798" className="font-bold text-[#FF6B00] hover:underline">give us a call</a>.
                </p>
              </>
            )}

            {/* ── Step 2: date + time ────────────────────────────── */}
            {step === 1 && (
              <>
                <h2 className="text-xl font-bold text-slate-900">Pick a date and time</h2>
                <p className="mt-1 text-sm text-slate-600">{service?.name} · {service?.duration}</p>

                <div className="mt-5 flex gap-2 overflow-x-auto pb-2">
                  {dates.map(d => {
                    const active = d === date;
                    const dt = new Date(`${d}T00:00:00`);
                    return (
                      <button key={d} onClick={() => setDate(d)}
                        className={`flex w-[62px] shrink-0 flex-col items-center rounded-xl border-2 py-2 transition-all
                          ${active ? 'border-[#FF6B00] bg-orange-50' : 'border-slate-200 hover:border-slate-300'}`}>
                        <span className="text-[11px] font-bold uppercase text-slate-500">
                          {dt.toLocaleDateString('en-GB', { weekday: 'short' })}
                        </span>
                        <span className={`text-lg font-extrabold ${active ? 'text-[#FF6B00]' : 'text-slate-900'}`}>
                          {dt.getDate()}
                        </span>
                        <span className="text-[10px] font-medium text-slate-400">
                          {dt.toLocaleDateString('en-GB', { month: 'short' })}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-5">
                  <KSLabel>Available times on {dayName(date)}</KSLabel>
                  {slotsLoading ? (
                    <div className="flex items-center gap-2 py-4 text-slate-400"><Spinner /> Checking availability…</div>
                  ) : slots.length === 0 ? (
                    <div className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                      {slotsReason || 'No free sessions on this day — try another date.'}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {slots.map(s => {
                        const active = startTime === s.start_time;
                        return (
                          <button key={s.start_time}
                            onClick={() => { setStartTime(s.start_time); setCoachId(s.coaches[0]?.id ?? null); }}
                            className={`rounded-xl border-2 py-2.5 text-sm font-bold transition-all
                              ${active ? 'border-[#FF6B00] bg-[#FF6B00] text-white'
                                : 'border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50'}`}>
                            {s.start_time}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {selectedSlot && selectedSlot.coaches.length > 1 && (
                  <div className="mt-5">
                    <KSLabel hint="(optional)">Preferred coach</KSLabel>
                    <div className="flex flex-wrap gap-2">
                      {selectedSlot.coaches.map(c => (
                        <button key={c.id} onClick={() => setCoachId(c.id)}
                          className={`rounded-xl border-2 px-4 py-2 text-sm font-bold transition-all
                            ${coachId === c.id ? 'border-[#FF6B00] bg-orange-50 text-[#C24F00]'
                              : 'border-slate-200 text-slate-700 hover:border-slate-300'}`}>
                          {c.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ── Step 3: player details ─────────────────────────── */}
            {step === 2 && (
              <>
                <h2 className="text-xl font-bold text-slate-900">Who's playing?</h2>
                {parent && (
                  <p className="mt-1 text-sm text-slate-500">
                    Signed in as {parent.email} — we've filled in what we know.
                  </p>
                )}

                <div className="mt-5 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <KSLabel>Player's name</KSLabel>
                      <KSInput value={childName} onChange={e => setChildName(e.target.value)}
                        placeholder="e.g. Alfie" autoComplete="off" />
                    </div>
                    <div>
                      <KSLabel hint="(5–16)">Age</KSLabel>
                      <KSInput type="number" min={3} max={18} value={childAge}
                        onChange={e => setChildAge(e.target.value)} placeholder="9" />
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <KSLabel hint="(optional)">School</KSLabel>
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

                  <div className="border-t border-slate-100 pt-4">
                    <h3 className="font-bold text-slate-900">Your details</h3>
                    <div className="mt-3 space-y-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <KSLabel>Your name</KSLabel>
                          <KSInput value={parentName} onChange={e => setParentName(e.target.value)}
                            placeholder="Parent / guardian" autoComplete="name" />
                        </div>
                        <div>
                          <KSLabel>Mobile</KSLabel>
                          <KSInput type="tel" value={parentPhone} onChange={e => setParentPhone(e.target.value)}
                            placeholder="07…" autoComplete="tel" />
                        </div>
                      </div>
                      <div>
                        <KSLabel>Email</KSLabel>
                        <KSInput type="email" value={parentEmail} onChange={e => setParentEmail(e.target.value)}
                          placeholder="you@example.com" autoComplete="email" />
                      </div>
                      <p className="text-xs leading-relaxed text-slate-500">
                        We'll text your mobile to confirm, the day before, and an hour ahead.
                        Reply STOP to any message to opt out.
                      </p>
                    </div>
                  </div>

                  <div>
                    <KSLabel hint="(optional)">Anything we should know?</KSLabel>
                    <KSTextarea rows={3} value={notes} onChange={e => setNotes(e.target.value)}
                      placeholder="Injuries, medical needs, position they want to work on…" />
                  </div>
                </div>
              </>
            )}

            {/* ── Step 4: review ─────────────────────────────────── */}
            {step === 3 && (
              <>
                <h2 className="text-xl font-bold text-slate-900">Check everything over</h2>
                <div className="mt-5 divide-y divide-slate-100 rounded-2xl bg-slate-50 px-5">
                  {[
                    ['Session', service?.name],
                    ['When', `${dayName(date)} · ${startTime}–${selectedSlot?.end_time || ''}`],
                    ['Coach', selectedSlot?.coaches.find(c => c.id === coachId)?.name
                      || selectedSlot?.coaches[0]?.name || 'Assigned by KS'],
                    ['Player', `${childName}${childAge ? `, age ${childAge}` : ''}`],
                    ['School', childSchool || '—'],
                    ['Experience', childExperience || '—'],
                    ['Parent', parentName],
                    ['Email', parentEmail],
                    ['Mobile', parentPhone || '—'],
                    ['Notes', notes || '—'],
                    ['Price', service ? `${service.price}` : '—'],
                  ].map(([k, v]) => (
                    <div key={k as string} className="flex justify-between gap-4 py-3 text-[15px]">
                      <span className="shrink-0 text-slate-500">{k}</span>
                      <span className="break-words text-right font-semibold text-slate-900">{v}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-4 text-sm leading-relaxed text-slate-500">
                  Payment is taken at the session. Free to rearrange with 24 hours notice —
                  weather and pitch closures are always rearranged free.
                </p>
              </>
            )}

            {/* ── Nav ────────────────────────────────────────────── */}
            <div className="mt-7 flex items-center justify-between gap-3 border-t border-slate-100 pt-5">
              <KSButton tone="ghost"
                onClick={() => (step === 0 ? navigate('/ks') : setStep(s => s - 1))}>
                ← {step === 0 ? 'Back to site' : 'Back'}
              </KSButton>
              {step < 3 ? (
                <KSButton disabled={!canAdvance} onClick={() => { setError(''); setStep(s => s + 1); }}>
                  Continue →
                </KSButton>
              ) : (
                <KSButton loading={submitting} onClick={confirm} className="px-6">
                  Confirm booking
                </KSButton>
              )}
            </div>
          </KSCard>

          {step === 1 && slots.length > 0 && (
            <p className="mt-4 text-center text-sm text-slate-500">
              Showing free slots for {shortDay(date)}. Times are UK local.
            </p>
          )}
        </div>
      </div>
    </KSShell>
  );
}
