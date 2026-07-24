// Max Gleam customer-facing UI kit — clean, light, teal (#19C3E6).
// The AGENT OS primitives are dark-theme only, so the customer surfaces
// bring their own shell and controls. Mobile-first: customers open these
// pages from a text message on a phone.
import { useEffect } from 'react';

export const MG_TEAL = '#19C3E6';
export const MG_INK = '#0F2733';

export function MGShell({ children, compact }:
  { children: React.ReactNode; compact?: boolean }) {
  // The global stylesheet paints the body near-black; repaint it light for
  // the lifetime of any customer page (and restore it on the way out).
  useEffect(() => {
    const { body } = document;
    const prevBg = body.style.background;
    const prevColor = body.style.color;
    body.style.background = '#F6FAFC';
    body.style.color = MG_INK;
    return () => { body.style.background = prevBg; body.style.color = prevColor; };
  }, []);

  return (
    <div className="min-h-screen bg-[#F6FAFC] font-sans text-[#0F2733] antialiased">
      <header className="border-b border-slate-200 bg-white">
        <div className={`mx-auto flex items-center gap-2.5 px-4 pb-3.5 pt-[max(0.875rem,env(safe-area-inset-top))] ${compact ? 'max-w-xl' : 'max-w-4xl'} sm:px-6`}>
          <MGMark />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold leading-tight tracking-tight">Max Gleam</div>
            <div className="text-[11px] font-medium text-slate-500">Window cleaning</div>
          </div>
        </div>
      </header>
      {children}
      <footer className="mt-12 border-t border-slate-200 bg-white pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-xs text-slate-500">
        Max Gleam · Professional window cleaning
      </footer>
    </div>
  );
}

export function MGMark({ size = 34 }: { size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-xl font-extrabold text-white shadow-[0_3px_12px_-3px_rgba(25,195,230,0.7)]"
      style={{ width: size, height: size, fontSize: size * 0.42,
        background: 'linear-gradient(135deg, #4FD8F5, #19C3E6)' }}>
      MG
    </span>
  );
}

type Tone = 'primary' | 'secondary' | 'ghost' | 'danger';
const TONES: Record<Tone, string> = {
  primary: 'bg-[#19C3E6] text-white hover:bg-[#12AECE] shadow-sm hover:shadow-md',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:border-slate-400 hover:bg-slate-50',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-white text-red-600 border border-red-200 hover:bg-red-50',
};

export function MGButton({ tone = 'primary', loading, children, className = '', ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; loading?: boolean }) {
  return (
    <button {...props} disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold
        transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50
        ${TONES[tone]} ${className}`}>
      {loading && <MGSpinner />}
      {children}
    </button>
  );
}

export function MGSpinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
}

export function MGCard({ children, className = '' }:
  { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,39,51,0.06)] ${className}`}>
      {children}
    </div>
  );
}

export function MGLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <label className="mb-1.5 block text-sm font-semibold text-slate-700">
      {children}
      {hint && <span className="ml-1.5 font-normal text-slate-400">{hint}</span>}
    </label>
  );
}

const FIELD = `w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-[16px] text-slate-900
  placeholder:text-slate-400 focus:border-[#19C3E6] focus:outline-none focus:ring-2 focus:ring-[#19C3E6]/20`;

export function MGInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${FIELD} ${props.className || ''}`} />;
}

export function MGTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${FIELD} ${props.className || ''}`} />;
}

export function MGAlert({ tone = 'error', children }:
  { tone?: 'error' | 'success' | 'info' | 'warn'; children: React.ReactNode }) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-700',
    success: 'border-green-200 bg-green-50 text-green-700',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    warn: 'border-amber-200 bg-amber-50 text-amber-800',
  }[tone];
  return (
    <div className={`rounded-xl border px-3.5 py-2.5 text-sm font-medium ${styles}`} role="alert">
      {children}
    </div>
  );
}

export function MGPill({ children, tone = 'slate' }:
  { children: React.ReactNode; tone?: 'slate' | 'teal' | 'green' | 'amber' | 'red' }) {
  const styles = {
    slate: 'bg-slate-100 text-slate-600',
    teal: 'bg-[#19C3E6]/12 text-[#0E7C93]',
    green: 'bg-green-100 text-green-700',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${styles}`}>
      {children}
    </span>
  );
}

/** Sign-off status → pill tone + human label. */
export function signoffLook(status: string | null): { tone: 'slate' | 'teal' | 'green' | 'amber' | 'red'; label: string } {
  switch (status) {
    case 'signed': return { tone: 'green', label: 'Signed off' };
    case 'auto-approved': return { tone: 'teal', label: 'Auto-approved' };
    case 'sent': case 'pending': return { tone: 'amber', label: 'Awaiting sign-off' };
    default: return { tone: 'slate', label: 'Not requested' };
  }
}

// ── Star rating ─────────────────────────────────────────────────────────
export function Stars({ value, onChange, size = 40 }:
  { value: number; onChange?: (n: number) => void; size?: number }) {
  const readOnly = !onChange;
  return (
    <div className="flex items-center gap-1" role={readOnly ? undefined : 'radiogroup'}
      aria-label={readOnly ? `Rated ${value} out of 5` : 'Rating'}>
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} type="button" disabled={readOnly}
          onClick={() => onChange?.(n)}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          aria-checked={value === n} role={readOnly ? undefined : 'radio'}
          className={`leading-none transition-transform ${readOnly ? 'cursor-default' : 'hover:scale-110 active:scale-95'}`}
          style={{ fontSize: size }}>
          <span className={n <= value ? 'text-[#FFB020]' : 'text-slate-300'}>★</span>
        </button>
      ))}
    </div>
  );
}
