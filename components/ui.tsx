// AGENT OS design system — glassy dark UI primitives.
import React, { createContext, useContext, useCallback, useState } from 'react';

// ── Icon (Material Symbols Rounded) ─────────────────────────────────────
export function Icon({ name, className = '', size = 20, fill = false, style }:
  { name: string; className?: string; size?: number; fill?: boolean; style?: React.CSSProperties }) {
  return (
    <span
      className={`material-symbols-rounded select-none leading-none ${className}`}
      style={{ fontSize: size, fontVariationSettings: fill ? "'FILL' 1" : "'FILL' 0", ...style }}
    >{name}</span>
  );
}

// ── Button ──────────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'glass';
const btnStyles: Record<BtnVariant, string> = {
  primary: 'bg-gradient-to-br from-[#2AD4F5] to-[#0EA5C9] text-[#04222b] hover:brightness-110 font-semibold shadow-[0_0_20px_rgba(25,195,230,0.3),inset_0_1px_0_rgba(255,255,255,0.35)] hover:shadow-[0_0_36px_rgba(25,195,230,0.5),inset_0_1px_0_rgba(255,255,255,0.35)]',
  secondary: 'bg-raised text-ink hover:bg-[#1a2942] border border-white/10 hover:border-accent/30 hover:shadow-[0_0_18px_-4px_rgba(25,195,230,0.3)]',
  ghost: 'text-muted hover:text-ink hover:bg-white/5',
  danger: 'bg-rose/90 text-white hover:bg-rose hover:shadow-[0_0_24px_-4px_rgba(244,63,94,0.5)]',
  glass: 'glass text-ink hover:bg-white/10 hover:shadow-[0_0_18px_-4px_rgba(25,195,230,0.25)]',
};
export function Button({ variant = 'secondary', icon, children, className = '', loading, ...props }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; icon?: string; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-sm transition-all
        disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97] ${btnStyles[variant]} ${className}`}
    >
      {loading ? <Icon name="progress_activity" className="animate-spin" size={18} />
               : icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </button>
  );
}

// ── Card ────────────────────────────────────────────────────────────────
export const Card = React.forwardRef<HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { glass?: boolean; hover?: boolean }>(
  ({ children, className = '', glass, hover, ...rest }, ref) => {
  return (
    <div ref={ref} {...rest}
      className={`${glass ? 'glass' : 'card'} rounded-2xl ${hover ? 'transition-all duration-200 hover:border-accent/25 hover:-translate-y-0.5 hover:shadow-[0_10px_36px_-8px_rgba(25,195,230,0.28)]' : ''} ${className}`}>
      {children}
    </div>
  );
});
Card.displayName = 'Card';

// ── Badge ───────────────────────────────────────────────────────────────
type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'violet';
const badgeTones: Record<BadgeTone, string> = {
  ok: 'bg-emerald/15 text-emerald border-emerald/25',
  warn: 'bg-amber/15 text-amber border-amber/25',
  danger: 'bg-rose/15 text-rose border-rose/25',
  info: 'bg-accent/15 text-accent border-accent/25',
  violet: 'bg-violet/15 text-violet border-violet/25',
  neutral: 'bg-white/5 text-muted border-white/10',
};
export function Badge({ tone = 'neutral', children, className = '', dot }:
  { tone?: BadgeTone; children: React.ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${badgeTones[tone]} ${className}`}>
      {dot && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {children}
    </span>
  );
}

export const STATUS_TONE: Record<string, BadgeTone> = {
  idle: 'neutral', running: 'info', flagged: 'warn', error: 'danger',
};
export const TEAM_COLOUR: Record<string, string> = {
  marketing: '#38BDF8', sales: '#F43F5E', technical: '#A78BFA', platform: '#22C55E',
};

// ── Toggle ──────────────────────────────────────────────────────────────
export function Toggle({ checked, onChange, disabled }:
  { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={onChange}
      className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-40
        ${checked ? 'bg-accent shadow-[0_0_12px_rgba(25,195,230,0.5)]' : 'bg-white/10'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform
        ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

// ── Textarea / Input ────────────────────────────────────────────────────
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props}
    className={`w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm text-ink
      placeholder:text-muted/60 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 ${props.className || ''}`} />;
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props}
    className={`w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm text-ink
      placeholder:text-muted/60 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 ${props.className || ''}`} />;
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props}
    className={`rounded-xl bg-black/30 border border-white/10 px-2.5 py-1.5 text-sm text-ink
      focus:outline-none focus:border-accent/50 ${props.className || ''}`} />;
}

// ── Modal ───────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, width = 'max-w-lg' }:
  { open: boolean; onClose: () => void; title?: string; children: React.ReactNode; width?: string }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-[pageFade_0.25s_ease-out_both]" />
      <div className={`relative w-full ${width} glass-raised rounded-2xl p-5 animate-scaleIn`}
        onClick={e => e.stopPropagation()}>
        {title && (
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
            <button onClick={onClose} className="text-muted hover:text-ink"><Icon name="close" /></button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// ── Drawer (slide from right) ───────────────────────────────────────────
export function Drawer({ open, onClose, children, width = 'max-w-md' }:
  { open: boolean; onClose: () => void; children: React.ReactNode; width?: string }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-[pageFade_0.25s_ease-out_both]" />
      <div className={`relative h-full w-full ${width} glass-raised border-l border-white/10 overflow-y-auto animate-slideInRight`}
        onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// ── EmptyState ──────────────────────────────────────────────────────────
export function EmptyState({ icon = 'inbox', title, hint, action, accent = '#19C3E6', large, children }:
  { icon?: string; title: string; hint?: string; action?: React.ReactNode; accent?: string; large?: boolean; children?: React.ReactNode }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 text-center animate-fadeInUp ${large ? 'py-20' : 'py-16'}`}>
      <div className="relative">
        <div className={`absolute inset-0 rounded-3xl animate-pulse ${large ? '-m-2' : '-m-1.5'}`}
          style={{ border: `1px solid ${accent}30` }} />
        {/* slow orbiting dashed ring — a satellite path around the icon */}
        <div className={`pointer-events-none absolute inset-0 rounded-full border border-dashed animate-[spin_18s_linear_infinite] ${large ? '-m-5' : '-m-4'}`}
          style={{ borderColor: `${accent}26` }} />
        <div className={`grid place-items-center rounded-3xl glass ${large ? 'h-20 w-20' : 'h-14 w-14'}`}
          style={{ color: accent, boxShadow: `0 0 32px -8px ${accent}55` }}>
          <Icon name={icon} size={large ? 34 : 26} />
        </div>
      </div>
      <div className={`font-display text-ink ${large ? 'text-lg font-semibold' : ''}`}>{title}</div>
      {hint && <div className="max-w-xs text-sm text-muted">{hint}</div>}
      {children}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ── SkeletonList ────────────────────────────────────────────────────────
export function SkeletonList({ count = 4, className = '' }: { count?: number; className?: string }) {
  return (
    <div className={`space-y-3 ${className}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton h-16 rounded-2xl" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  );
}

// ── Toast system ────────────────────────────────────────────────────────
type Toast = { id: number; message: string; tone: BadgeTone };
const ToastCtx = createContext<(message: string, tone?: BadgeTone) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: BadgeTone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, message, tone }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-6 right-6 z-[60] flex flex-col gap-2">
        {toasts.map(t => {
          const glow = t.tone === 'danger' ? '#F43F5E' : t.tone === 'ok' ? '#22C55E'
            : t.tone === 'warn' ? '#F59E0B' : '#19C3E6';
          return (
            <div key={t.id}
              className="glass-raised relative flex items-center gap-2 overflow-hidden rounded-xl px-4 py-3 text-sm text-ink shadow-xl animate-slideInRight"
              style={{ borderColor: `${glow}44`, boxShadow: `0 12px 40px -10px rgba(0,0,0,0.7), 0 0 24px -8px ${glow}55` }}>
              <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r-full"
                style={{ background: glow, boxShadow: `0 0 10px ${glow}` }} />
              <Icon size={18} className={badgeTones[t.tone].split(' ')[1]}
                name={t.tone === 'danger' ? 'error' : t.tone === 'ok' ? 'check_circle' : 'info'} />
              {t.message}
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

// ── Stat tile ───────────────────────────────────────────────────────────
export function Stat({ label, value, icon, accent = '#19C3E6', delay = 0 }:
  { label: string; value: React.ReactNode; icon?: string; accent?: string; delay?: number }) {
  return (
    <Card glass hover className="group relative overflow-hidden p-4 animate-fadeInUp"
      style={{ animationDelay: `${delay}ms` }}>
      {/* accent hairline along the top edge */}
      <div className="pointer-events-none absolute inset-x-4 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}55, transparent)` }} />
      {/* soft accent wash behind the corner */}
      <div className="pointer-events-none absolute -right-7 -top-9 h-24 w-24 rounded-full opacity-20 blur-2xl transition-opacity duration-300 group-hover:opacity-40"
        style={{ background: accent }} />
      <div className="relative flex items-center gap-3">
        {icon && (
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-110"
            style={{ background: `${accent}1a`, color: accent, boxShadow: `0 0 20px -8px ${accent}66, inset 0 1px 0 ${accent}22` }}>
            <Icon name={icon} size={20} />
          </div>
        )}
        <div className="min-w-0">
          <div className="font-display text-2xl font-bold leading-tight text-ink tabular-nums">{value}</div>
          <div className="truncate text-xs text-muted">{label}</div>
        </div>
      </div>
    </Card>
  );
}

// ── useCountUp — eased count-up for stat numbers ────────────────────────
export function useCountUp(target: number, ms = 700): number {
  const [v, setV] = useState(0);
  // Animate from the last displayed value (not 0) so live/polled numbers ease
  // to their new value instead of flashing back to zero on every update.
  const fromRef = React.useRef(0);
  React.useEffect(() => {
    let raf = 0; const start = performance.now(); const from = fromRef.current;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      const cur = Math.round(from + (target - from) * eased);
      setV(cur); fromRef.current = cur;
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
