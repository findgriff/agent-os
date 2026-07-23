// KS Sports Coaching — light, sporty UI kit.
//
// The AGENT OS primitives in components/ui.tsx are dark-theme only and the
// global stylesheet paints the body near-black, so the public KS site brings
// its own shell and controls. Brand orange is #FF6B00 throughout.
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

export const KS_ORANGE = '#FF6B00';

// ── Shell ───────────────────────────────────────────────────────────────
// Repaints the body light for the lifetime of any KS page — the AGENT OS
// stylesheet sets a near-black body that would otherwise show through on
// overscroll and behind the fixed header.
export function KSShell({ children, nav = true, footer = true }:
  { children: React.ReactNode; nav?: boolean; footer?: boolean }) {
  useEffect(() => {
    const { body } = document;
    const prevBg = body.style.background;
    const prevColor = body.style.color;
    body.style.background = '#FFFFFF';
    body.style.color = '#0F172A';
    return () => { body.style.background = prevBg; body.style.color = prevColor; };
  }, []);

  return (
    <div className="min-h-screen bg-white font-sans text-slate-900 antialiased">
      {nav && <KSNav />}
      {children}
      {footer && <KSFooter />}
    </div>
  );
}

const NAV_LINKS = [
  { to: '/ks', label: 'Home', end: true },
  { to: '/ks/book', label: 'Book' },
  { to: '/ks/login', label: 'My account' },
];

function KSNav() {
  const { pathname } = useLocation();
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <Link to="/ks" className="flex min-w-0 items-center gap-2.5">
          <KSMark />
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-extrabold leading-tight tracking-tight text-slate-900">
              KS Sports Coaching
            </span>
            <span className="hidden text-[11px] font-medium text-slate-500 sm:block">
              North West &amp; Cheshire
            </span>
          </span>
        </Link>
        <nav className="ml-auto flex items-center gap-1">
          {NAV_LINKS.map(l => {
            const active = l.end ? pathname === l.to : pathname.startsWith(l.to);
            return (
              <Link key={l.to} to={l.to}
                className={`rounded-lg px-2.5 py-1.5 text-sm font-semibold transition-colors sm:px-3
                  ${active ? 'text-[#FF6B00]' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
                {l.label}
              </Link>
            );
          })}
          <Link to="/ks/book"
            className="ml-1 hidden rounded-xl bg-[#FF6B00] px-4 py-2 text-sm font-bold text-white shadow-sm transition-all hover:bg-[#E85F00] hover:shadow-md active:scale-[0.98] sm:inline-block">
            Book now
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function KSMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#FF8A2B] to-[#FF6B00] font-extrabold text-white shadow-[0_4px_14px_-4px_rgba(255,107,0,0.6)]"
      style={{ width: size, height: size, fontSize: size * 0.4 }}>
      KS
    </span>
  );
}

function KSFooter() {
  return (
    <footer className="mt-16 border-t border-slate-200 bg-slate-50">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 sm:grid-cols-3 sm:px-6">
        <div>
          <div className="flex items-center gap-2.5">
            <KSMark size={32} />
            <span className="font-extrabold tracking-tight">KS Sports Coaching</span>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            After-school sports clubs that build skilful, confident kids.
          </p>
        </div>
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Contact</h3>
          <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
            <li><a className="hover:text-[#FF6B00]" href="tel:07939554798">07939 554 798</a></li>
            <li><a className="hover:text-[#FF6B00]" href="mailto:kellie@kssportscoaching.co.uk">
              kellie@kssportscoaching.co.uk</a></li>
            <li>North West &amp; Cheshire, UK</li>
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Quick links</h3>
          <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
            <li><Link className="hover:text-[#FF6B00]" to="/ks/book">Book a session</Link></li>
            <li><Link className="hover:text-[#FF6B00]" to="/ks/login">My bookings</Link></li>
            <li><Link className="hover:text-[#FF6B00]" to="/ks/coach">Coach login</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-slate-200 py-4 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} KS Sports Coaching · FA qualified · DBS checked · Insured
      </div>
    </footer>
  );
}

// ── Controls ────────────────────────────────────────────────────────────
type BtnTone = 'primary' | 'secondary' | 'ghost' | 'danger';
const TONES: Record<BtnTone, string> = {
  primary: 'bg-[#FF6B00] text-white hover:bg-[#E85F00] shadow-sm hover:shadow-md',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:border-slate-400 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-white text-red-600 border border-red-200 hover:bg-red-50 hover:border-red-300',
};

export function KSButton({ tone = 'primary', loading, children, className = '', ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: BtnTone; loading?: boolean }) {
  return (
    <button {...props} disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold
        transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50
        ${TONES[tone]} ${className}`}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />
  );
}

export function KSCard({ children, className = '' }:
  { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)] ${className}`}>
      {children}
    </div>
  );
}

export function KSLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <label className="mb-1.5 block text-sm font-semibold text-slate-700">
      {children}
      {hint && <span className="ml-1.5 font-normal text-slate-400">{hint}</span>}
    </label>
  );
}

const FIELD = `w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-[15px] text-slate-900
  placeholder:text-slate-400 focus:border-[#FF6B00] focus:outline-none focus:ring-2 focus:ring-[#FF6B00]/20`;

export function KSInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${FIELD} ${props.className || ''}`} />;
}

export function KSSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${FIELD} ${props.className || ''}`} />;
}

export function KSTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${FIELD} ${props.className || ''}`} />;
}

export function KSAlert({ tone = 'error', children }:
  { tone?: 'error' | 'success' | 'info'; children: React.ReactNode }) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-700',
    success: 'border-green-200 bg-green-50 text-green-700',
    info: 'border-blue-200 bg-blue-50 text-blue-700',
  }[tone];
  return (
    <div className={`rounded-xl border px-3.5 py-2.5 text-sm font-medium ${styles}`} role="alert">
      {children}
    </div>
  );
}

export function KSPill({ children, tone = 'slate' }:
  { children: React.ReactNode; tone?: 'slate' | 'orange' | 'green' | 'red' | 'blue' }) {
  const styles = {
    slate: 'bg-slate-100 text-slate-600',
    orange: 'bg-orange-100 text-[#C24F00]',
    green: 'bg-green-100 text-green-700',
    red: 'bg-red-100 text-red-700',
    blue: 'bg-blue-100 text-blue-700',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${styles}`}>
      {children}
    </span>
  );
}

export const STATUS_PILL: Record<string, 'slate' | 'orange' | 'green' | 'red' | 'blue'> = {
  confirmed: 'green', completed: 'blue', cancelled: 'red',
};
