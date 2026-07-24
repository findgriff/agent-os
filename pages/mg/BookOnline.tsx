// Max Gleam — self-serve booking at /book.
//
// Public: no login, opened from a link or a QR code on a van. Four steps on
// one page, because a customer standing at their door on 4G will abandon
// anything that feels like a form:
//
//   postcode → address + service → date → details → confirmed
//
// The step the customer is on is the only one expanded; the ones behind it
// collapse to a single line they can tap to go back and change.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  MGShell, MGButton, MGButtonLink, MGCard, MGInput, MGTextarea, MGLabel, MGField, MGAlert, MGMark,
} from './MGKit';
import {
  bookApi, type BookLookup, type BookProperty, type BookResult,
  type BookService, type BookSlot, type ServiceKey,
} from '../../lib/bookApi';
import { gbp, niceDate } from '../../lib/mgApi';

type Step = 'postcode' | 'property' | 'date' | 'details';

const SERVICE_ICON: Record<string, string> = {
  standard_clean: '🧽',
  deep_clean: '✨',
  window_clean: '🪟',
};

// ── Step chrome ─────────────────────────────────────────────────────────
function StepCard({ n, title, done, active, summary, onReopen, children }: {
  n: number; title: string; done: boolean; active: boolean;
  summary?: string; onReopen?: () => void; children: React.ReactNode;
}) {
  return (
    <MGCard className={`overflow-hidden transition-all ${active ? '' : 'opacity-90'}`}>
      <button type="button"
        onClick={done && !active && onReopen ? onReopen : undefined}
        disabled={!done || active || !onReopen}
        className={`flex w-full items-center gap-3 px-4 py-3.5 text-left
          ${done && !active && onReopen ? 'cursor-pointer hover:bg-slate-50' : 'cursor-default'}`}>
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-extrabold
          ${done ? 'bg-[#19C3E6] text-white' : active ? 'bg-[#19C3E6]/15 text-[#0E7C93]' : 'bg-slate-100 text-slate-400'}`}>
          {done ? '✓' : n}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-bold ${active || done ? 'text-slate-900' : 'text-slate-400'}`}>
            {title}
          </span>
          {!active && summary && (
            <span className="block truncate text-xs text-slate-500">{summary}</span>
          )}
        </span>
        {done && !active && onReopen && (
          <span className="shrink-0 text-xs font-bold text-[#0E7C93]">Change</span>
        )}
      </button>
      {active && <div className="border-t border-slate-100 px-4 py-4">{children}</div>}
    </MGCard>
  );
}

// ── Confirmation ────────────────────────────────────────────────────────
function Confirmed({ result, onAgain }: { result: BookResult; onAgain: () => void }) {
  return (
    <MGShell compact>
      <main className="mx-auto max-w-xl px-4 py-8 sm:px-6">
        <MGCard className="overflow-hidden">
          <div className="bg-gradient-to-br from-[#4FD8F5] to-[#19C3E6] px-6 py-8 text-center text-white">
            <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-white/25 text-3xl">
              ✓
            </div>
            <h1 className="text-xl font-extrabold">Booking requested</h1>
            <p className="mt-1 text-sm text-white/90">{result.confirmation}</p>
          </div>

          <dl className="divide-y divide-slate-100">
            {[
              ['Reference', <span key="r" className="font-mono font-bold">{result.ref}</span>],
              ['Service', result.service_label],
              ['Date', niceDate(result.date)],
              ['Address', result.address],
              ['Price', gbp(result.price_pence)],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex items-start justify-between gap-4 px-5 py-3">
                <dt className="text-sm font-semibold text-slate-500">{label}</dt>
                <dd className="text-right text-sm font-bold text-slate-900">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="border-t border-slate-100 bg-slate-50 px-5 py-4">
            <p className="text-sm text-slate-600">
              We&rsquo;ve sent your details to the office. Someone will confirm your
              slot shortly{result.sms_status === 'sent' ? ' — a text is on its way too' : ''}.
              Quote <span className="font-mono font-bold text-slate-900">{result.ref}</span> if you
              need to get in touch.
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <MGButtonLink href="/customer/login" className="w-full sm:flex-1">Track it in your account</MGButtonLink>
              <MGButton tone="secondary" onClick={onAgain} className="w-full sm:w-auto">Book another</MGButton>
            </div>
          </div>
        </MGCard>
      </main>
    </MGShell>
  );
}

// ── Page ────────────────────────────────────────────────────────────────
export default function BookOnline() {
  const [step, setStep] = useState<Step>('postcode');

  const [postcode, setPostcode] = useState('');
  const postcodeId = useId();
  const [lookup, setLookup] = useState<BookLookup | null>(null);
  const [looking, setLooking] = useState(false);

  const [property, setProperty] = useState<BookProperty | null>(null);
  const [service, setService] = useState<ServiceKey | null>(null);
  const [date, setDate] = useState('');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');

  const [error, setError] = useState('');
  const [booking, setBooking] = useState(false);
  const [result, setResult] = useState<BookResult | null>(null);

  // Scroll the newly-opened step into view on a phone, where the steps behind
  // it push it below the fold.
  const stepRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step !== 'postcode') {
      stepRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [step]);

  const services: BookService[] = lookup?.services ?? [];
  const openSlots = useMemo(
    () => (lookup?.slots ?? []).filter(s => s.available), [lookup]);

  const findProperty = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!postcode.trim()) return;
    setLooking(true);
    setError('');
    setProperty(null);
    setService(null);
    setDate('');
    try {
      const res = await bookApi.lookup(postcode.trim());
      setLookup(res);
      if (!res.found) {
        setError(res.message || 'We don’t cover that postcode yet.');
        setStep('postcode');
        return;
      }
      // One match is the common case — select it and move straight on.
      if (res.properties.length === 1) setProperty(res.properties[0]);
      setStep('property');
    } catch (err: any) {
      setError(err?.message || 'Could not look that postcode up.');
    } finally {
      setLooking(false);
    }
  }, [postcode]);

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!property || !service || !date) return;
    setBooking(true);
    setError('');
    try {
      setResult(await bookApi.book({
        property_id: property.property_id, service, date,
        name: name.trim(), email: email.trim(), phone: phone.trim(),
        notes: notes.trim() || undefined,
      }));
    } catch (err: any) {
      setError(err?.message || 'Could not place that booking.');
    } finally {
      setBooking(false);
    }
  }, [property, service, date, name, email, phone, notes]);

  const reset = () => {
    setResult(null); setStep('postcode'); setPostcode(''); setLookup(null);
    setProperty(null); setService(null); setDate('');
    setName(''); setEmail(''); setPhone(''); setNotes(''); setError('');
  };

  if (result) return <Confirmed result={result} onAgain={reset} />;

  const price = property && service ? property.prices[service] : null;

  return (
    <MGShell compact>
      <main className="mx-auto max-w-xl px-4 py-6 sm:px-6">
        <div className="mb-6 text-center">
          <div className="mb-3 flex justify-center"><MGMark size={44} /></div>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
            Book your clean
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Pick a date that suits you. Takes about a minute — no account needed.
          </p>
        </div>

        {error && <div className="mb-4"><MGAlert>{error}</MGAlert></div>}

        <div className="space-y-3" ref={stepRef}>
          {/* 1 — postcode */}
          <StepCard n={1} title="Your postcode" active={step === 'postcode'}
            done={!!lookup?.found && step !== 'postcode'}
            summary={lookup?.postcode}
            onReopen={() => setStep('postcode')}>
            <form onSubmit={findProperty}>
              <MGLabel htmlFor={postcodeId} hint="e.g. CH2 4BD">Postcode</MGLabel>
              <div className="flex gap-2">
                <MGInput id={postcodeId} value={postcode} autoFocus autoCapitalize="characters"
                  autoComplete="postal-code" placeholder="CH2 4BD"
                  onChange={e => setPostcode(e.target.value)} />
                <MGButton type="submit" loading={looking} disabled={!postcode.trim()}>
                  Find
                </MGButton>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                We&rsquo;ll match it to the address we already have on the round.
              </p>
            </form>
          </StepCard>

          {/* 2 — address + service */}
          <StepCard n={2} title="Address &amp; service" active={step === 'property'}
            done={!!property && !!service && step !== 'property'}
            summary={property && service
              ? `${property.address} · ${services.find(s => s.key === service)?.label}`
              : undefined}
            onReopen={() => setStep('property')}>
            {lookup?.matched_on === 'district' && (
              <div className="mb-3">
                <MGAlert tone="info">
                  No exact match for that postcode — here&rsquo;s everything we clean nearby.
                </MGAlert>
              </div>
            )}

            <MGLabel>Which address?</MGLabel>
            <div className="mb-4 space-y-2">
              {(lookup?.properties ?? []).map(p => (
                <button key={p.property_id} type="button"
                  onClick={() => setProperty(p)}
                  className={`w-full rounded-xl border px-3.5 py-3 text-left text-sm transition-all
                    ${property?.property_id === p.property_id
                      ? 'border-[#19C3E6] bg-[#19C3E6]/8 ring-2 ring-[#19C3E6]/20'
                      : 'border-slate-300 bg-white hover:border-slate-400'}`}>
                  <span className="block font-bold text-slate-900">{p.address}</span>
                  {p.postcode && <span className="text-xs text-slate-500">{p.postcode}</span>}
                </button>
              ))}
            </div>

            <MGLabel>What do you need?</MGLabel>
            <div className="space-y-2">
              {services.map(s => (
                <button key={s.key} type="button" onClick={() => setService(s.key)}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all
                    ${service === s.key
                      ? 'border-[#19C3E6] bg-[#19C3E6]/8 ring-2 ring-[#19C3E6]/20'
                      : 'border-slate-300 bg-white hover:border-slate-400'}`}>
                  <span className="text-xl" aria-hidden>{SERVICE_ICON[s.key] || '🧼'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-slate-900">{s.label}</span>
                    <span className="block text-xs text-slate-500">{s.blurb}</span>
                  </span>
                  {property && (
                    <span className="shrink-0 text-sm font-extrabold tabular-nums text-slate-900">
                      {gbp(property.prices[s.key])}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <MGButton className="mt-4 w-full" disabled={!property || !service}
              onClick={() => setStep('date')}>
              Continue
            </MGButton>
          </StepCard>

          {/* 3 — date */}
          <StepCard n={3} title="Pick a date" active={step === 'date'}
            done={!!date && step !== 'date'} summary={date ? niceDate(date) : undefined}
            onReopen={() => setStep('date')}>
            {openSlots.length === 0 ? (
              <MGAlert tone="warn">
                We&rsquo;re fully booked for the next fortnight — call the office and
                we&rsquo;ll find you a slot.
              </MGAlert>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {(lookup?.slots ?? []).map(s => (
                    <SlotButton key={s.date} slot={s} selected={date === s.date}
                      onPick={() => setDate(s.date)} />
                  ))}
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Greyed-out days are full or we&rsquo;re closed. We&rsquo;ll confirm your
                  slot before we come.
                </p>
                <MGButton className="mt-4 w-full" disabled={!date}
                  onClick={() => setStep('details')}>
                  Continue
                </MGButton>
              </>
            )}
          </StepCard>

          {/* 4 — details */}
          <StepCard n={4} title="Your details" active={step === 'details'} done={false}>
            <form onSubmit={submit} className="space-y-3">
              <MGField label="Your name">
                <MGInput value={name} onChange={e => setName(e.target.value)}
                  autoComplete="name" placeholder="Jane Smith" required />
              </MGField>
              <MGField label="Mobile">
                <MGInput value={phone} onChange={e => setPhone(e.target.value)}
                  type="tel" autoComplete="tel" placeholder="07700 900123" />
              </MGField>
              <MGField label="Email" hint="optional if you gave a mobile">
                <MGInput value={email} onChange={e => setEmail(e.target.value)}
                  type="email" autoComplete="email" placeholder="jane@example.com" />
              </MGField>
              <MGField label="Anything we should know?" hint="optional">
                <MGTextarea value={notes} rows={3} maxLength={500}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Side gate code, dog in the garden, parking…" />
              </MGField>

              {price !== null && (
                <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3.5 py-3">
                  <span className="text-sm font-semibold text-slate-600">Total</span>
                  <span className="text-lg font-extrabold tabular-nums text-slate-900">
                    {gbp(price)}
                  </span>
                </div>
              )}

              <MGButton type="submit" className="w-full" loading={booking}
                disabled={!name.trim() || (!phone.trim() && !email.trim())}>
                Request this booking
              </MGButton>
              <p className="text-center text-xs text-slate-500">
                Nothing is charged now. We&rsquo;ll confirm your slot first.
              </p>
            </form>
          </StepCard>
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          Already a customer?{' '}
          <a href="/customer/login" className="font-bold text-[#0E7C93] hover:underline">
            Sign in to your account
          </a>
        </p>
      </main>
    </MGShell>
  );
}

function SlotButton({ slot, selected, onPick }:
  { slot: BookSlot; selected: boolean; onPick: () => void }) {
  const [weekday, ...rest] = slot.label.split(' ');
  return (
    <button type="button" onClick={onPick} disabled={!slot.available}
      title={slot.reason === 'full' ? 'Fully booked'
        : slot.reason === 'closed' ? 'Closed' : undefined}
      className={`rounded-xl border px-2 py-2.5 text-center transition-all
        ${!slot.available ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-300'
          : selected ? 'border-[#19C3E6] bg-[#19C3E6]/10 ring-2 ring-[#19C3E6]/20'
          : 'border-slate-300 bg-white hover:border-slate-400'}`}>
      <span className={`block text-[11px] font-bold uppercase tracking-wide
        ${slot.available ? 'text-slate-500' : 'text-slate-300'}`}>
        {weekday}
      </span>
      <span className={`block text-sm font-extrabold
        ${slot.available ? 'text-slate-900' : 'text-slate-300'}`}>
        {rest.join(' ')}
      </span>
      {slot.available && slot.remaining <= 3 && (
        <span className="mt-0.5 block text-[10px] font-bold text-amber-600">
          {slot.remaining} left
        </span>
      )}
    </button>
  );
}
