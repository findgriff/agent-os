// KS Sports Coaching — public landing page.
// Every word of copy comes from /opt/ks-bot/knowledge.json, so the site and
// the chatbot always quote the same services, prices and policies.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { KSShell, KSButton, KSCard, KSPill, Spinner, KS_ORANGE } from './KSKit';
import { ksApi, type KsInfo } from '../../lib/ksApi';

const SERVICE_ART: Record<string, { icon: string; blurb: string }> = {
  '1-to-1-coaching': { icon: '⚽', blurb: 'One player, one plan' },
  'small-group-coaching': { icon: '👟', blurb: '2–6 players' },
  'team-coaching': { icon: '🏆', blurb: 'Grassroots teams' },
  'after-school-sports-clubs': { icon: '🏫', blurb: 'Weekly at your school' },
  'holiday-camps': { icon: '☀️', blurb: 'Full days, school breaks' },
};

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-200 last:border-0">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-4 text-left">
        <span className="text-[15px] font-semibold text-slate-900">{q}</span>
        <span className={`shrink-0 text-xl leading-none text-[#FF6B00] transition-transform duration-200 ${open ? 'rotate-45' : ''}`}>
          +
        </span>
      </button>
      {open && (
        <p className="whitespace-pre-line pb-4 pr-8 text-[15px] leading-relaxed text-slate-600">
          {a}
        </p>
      )}
    </div>
  );
}

export default function KSHome() {
  const [info, setInfo] = useState<KsInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    ksApi.info().then(setInfo).catch(() => setFailed(true));
  }, []);

  const biz = info?.business;

  return (
    <KSShell>
      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-gradient-to-b from-orange-50 to-white">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[#FF6B00]/10 blur-3xl" />
        <div className="relative mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <div className="max-w-2xl">
            <KSPill tone="orange">FA qualified · DBS checked · Insured</KSPill>
            <h1 className="mt-4 text-4xl font-extrabold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl">
              After-school sports clubs that build{' '}
              <span className="text-[#FF6B00]">skilful, confident kids.</span>
            </h1>
            <p className="mt-4 text-lg leading-relaxed text-slate-600">
              1-to-1, small group and team coaching across {biz?.area || 'the North West & Cheshire'}.
              Football, tennis, basketball, badminton, handball and rounders — all abilities welcome.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link to="/ks/book">
                <KSButton className="px-6 py-3 text-base">Book a session →</KSButton>
              </Link>
              <a href={`tel:${(biz?.phone || '').replace(/\s/g, '')}`}>
                <KSButton tone="secondary" className="px-6 py-3 text-base">
                  Call {biz?.phone || '07939 554 798'}
                </KSButton>
              </a>
            </div>
            <p className="mt-4 text-sm text-slate-500">
              First session is a reduced-price taster · 24 hours notice to rearrange free
            </p>
          </div>
        </div>
      </section>

      {/* ── Services ──────────────────────────────────────────────── */}
      <section id="services" className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">What we coach</h2>
        <p className="mt-2 text-slate-600">Pick the format that suits your player.</p>

        {failed && (
          <p className="mt-6 text-sm text-slate-500">
            Our service list is temporarily unavailable — please call {biz?.phone || '07939 554 798'}.
          </p>
        )}
        {!info && !failed && (
          <div className="mt-8 flex items-center gap-2 text-slate-400"><Spinner /> Loading services…</div>
        )}

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {info?.services.map(s => {
            const art = SERVICE_ART[s.key] || { icon: '⚽', blurb: '' };
            return (
              <KSCard key={s.key} className="flex flex-col p-5 transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-3xl" aria-hidden>{art.icon}</span>
                  {s.bookable
                    ? <KSPill tone="green">Book online</KSPill>
                    : <KSPill tone="slate">Enquire</KSPill>}
                </div>
                <h3 className="mt-3 text-lg font-bold text-slate-900">{s.name}</h3>
                <p className="mt-1.5 flex-1 text-sm leading-relaxed text-slate-600">{s.description}</p>
                <dl className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Price</dt>
                    <dd className="text-right font-bold text-slate-900">{s.price}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Who</dt>
                    <dd className="text-right text-slate-700">{s.audience}</dd>
                  </div>
                </dl>
                {s.bookable ? (
                  <Link to={`/ks/book?service=${s.key}`} className="mt-4">
                    <KSButton className="w-full">Book {s.name}</KSButton>
                  </Link>
                ) : (
                  <a href={`tel:${(biz?.phone || '').replace(/\s/g, '')}`} className="mt-4">
                    <KSButton tone="secondary" className="w-full">Call for a quote</KSButton>
                  </a>
                )}
              </KSCard>
            );
          })}
        </div>
      </section>

      {/* ── Coaches ───────────────────────────────────────────────── */}
      <section className="bg-slate-50 py-14">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">Meet the coaches</h2>
          <p className="mt-2 text-slate-600">
            The two people who will actually be on the grass with your child.
          </p>
          <div className="mt-8 grid gap-5 sm:grid-cols-2">
            {info?.coaches.map(c => (
              <KSCard key={c.slug} className="p-6">
                <div className="flex items-center gap-4">
                  <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#FF8A2B] to-[#FF6B00] text-2xl font-extrabold text-white">
                    {c.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
                  </span>
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">{c.name}</h3>
                    <p className="text-sm font-semibold text-[#FF6B00]">KS Sports Coach</p>
                  </div>
                </div>
                <p className="mt-4 text-[15px] leading-relaxed text-slate-600">{c.bio}</p>
              </KSCard>
            ))}
          </div>

          {!!info?.credentials.length && (
            <div className="mt-8 grid gap-2.5 sm:grid-cols-2">
              {info.credentials.map(c => (
                <div key={c} className="flex items-start gap-2.5 text-sm text-slate-700">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-green-100 text-[11px] font-bold text-green-700">
                    ✓
                  </span>
                  {c}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── CTA band ──────────────────────────────────────────────── */}
      <section className="py-14">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="relative overflow-hidden rounded-3xl px-6 py-12 text-center sm:px-12"
            style={{ background: `linear-gradient(135deg, ${KS_ORANGE}, #FF8A2B)` }}>
            <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              Ready to get started?
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-[17px] leading-relaxed text-white/90">
              Book online in under a minute. You'll get a text confirming the session,
              a reminder the day before, and a nudge an hour ahead.
            </p>
            <Link to="/ks/book" className="mt-7 inline-block">
              <span className="inline-flex items-center gap-2 rounded-xl bg-white px-7 py-3.5 text-base font-bold text-[#FF6B00] shadow-lg transition-transform hover:scale-[1.02] active:scale-[0.99]">
                Book now →
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* ── FAQ ───────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-3xl px-4 pb-4 sm:px-6">
        <h2 className="text-3xl font-extrabold tracking-tight text-slate-900">Common questions</h2>
        <KSCard className="mt-6 px-5">
          {info?.faq.map(f => <FaqItem key={f.question} q={f.question} a={f.answer} />)}
        </KSCard>
      </section>

      {/* ── Contact ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        <KSCard className="p-6 sm:p-8">
          <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">Get in touch</h2>
          <p className="mt-2 text-slate-600">
            Call, text or email — we reply within 24 hours.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <a href={`tel:${(biz?.phone || '').replace(/\s/g, '')}`}
              className="rounded-xl border border-slate-200 p-4 transition-colors hover:border-[#FF6B00] hover:bg-orange-50">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Phone</div>
              <div className="mt-1 font-bold text-slate-900">{biz?.phone || '07939 554 798'}</div>
            </a>
            <a href={`mailto:${biz?.email || ''}`}
              className="rounded-xl border border-slate-200 p-4 transition-colors hover:border-[#FF6B00] hover:bg-orange-50">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Email</div>
              <div className="mt-1 break-words font-bold text-slate-900">
                {biz?.email || 'kellie@kssportscoaching.co.uk'}
              </div>
            </a>
            <div className="rounded-xl border border-slate-200 p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Area</div>
              <div className="mt-1 font-bold text-slate-900">{biz?.area || 'North West & Cheshire'}</div>
            </div>
          </div>
        </KSCard>
      </section>
    </KSShell>
  );
}
