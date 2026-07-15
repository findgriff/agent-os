// AGENT OS — atmospheric login. Aurora field + drifting star particles,
// centred glass card with the wordmark and credential entry.
import React, { useMemo, useState } from 'react';
import { api, setToken, ApiError } from '../lib/api';
import type { User } from '../lib/types';
import { Button, Input, Icon } from '../components/ui';
import { Logo } from '../components/Logo';

// A cheap, static field of particles — positions/timings computed once so
// re-renders don't reshuffle them. Pure CSS animations keep this 60fps.
type Particle = { top: number; left: number; size: number; delay: number; dur: number; drift: boolean };

export default function Login({ onAuthed }: { onAuthed: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const particles = useMemo<Particle[]>(() =>
    Array.from({ length: 42 }).map((_, i) => ({
      top: Math.random() * 100,
      left: Math.random() * 100,
      size: 1 + Math.random() * 2.5,
      delay: Math.random() * 6,
      dur: 3 + Math.random() * 5,
      drift: i % 3 === 0,
    })), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const r = await api.login(email.trim(), password);
      setToken(r.token);
      onAuthed(r.user);
    } catch (err) {
      setError(err instanceof ApiError ? (err.message || 'Login failed') : 'Something went wrong. Try again.');
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-bg text-ink">
      {/* KITT scanner — a slow red sweep across the very top of the screen */}
      <div className="kitt-track absolute inset-x-0 top-0 z-20 h-[3px]">
        <div className="kitt-sweep" />
      </div>

      {/* Aurora field */}
      <div className="aurora-bg animate-aurora absolute inset-0" />
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-60" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(25,195,230,0.10),transparent_55%)]" />

      {/* Star / particle field */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {particles.map((p, i) => (
          <div
            key={i}
            className={`absolute rounded-full bg-white ${p.drift ? 'animate-float' : 'animate-twinkle'}`}
            style={{
              top: `${p.top}%`,
              left: `${p.left}%`,
              width: p.size,
              height: p.size,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.dur}s`,
              boxShadow: '0 0 6px rgba(255,255,255,0.6)',
            }}
          />
        ))}
      </div>

      {/* Card */}
      <div className="relative z-10 flex min-h-screen items-center justify-center p-5">
        <div className="relative w-full max-w-md">
          {/* Ambient glow behind the card */}
          <div className="pointer-events-none absolute -inset-6 -z-10 rounded-[2.5rem] bg-[radial-gradient(ellipse_at_center,rgba(25,195,230,0.18),transparent_70%)] blur-xl" />

          <div className={`glass-raised w-full rounded-3xl p-8 shadow-2xl shadow-black/50 ring-1 ring-accent/10 animate-[fadeInUp_0.6s_ease-out] transition-all duration-300 sm:p-10
            ${loading ? 'ring-accent/30 shadow-[0_0_60px_-16px_rgba(25,195,230,0.4)]' : ''}`}>
            <div className="flex flex-col items-center text-center">
              <div className="relative">
                <div className="absolute -inset-3 rounded-full bg-[radial-gradient(circle,rgba(25,195,230,0.28),transparent_70%)] blur-md animate-pulse" />
                <div className={`relative rounded-2xl transition-transform duration-500 ${loading ? 'scale-110' : ''}`}>
                  <div className="animate-float"><Logo size={56} showText={false} /></div>
                </div>
              </div>
              <h1 className="mt-5 bg-gradient-to-r from-accent via-ink to-violet bg-clip-text font-display text-3xl font-bold tracking-[0.18em] text-transparent">
                AGENT OS
              </h1>
              <p className="mt-1.5 max-w-xs text-[11px] uppercase tracking-[0.22em] text-muted">
                The Operating System for Autonomous Intelligence
              </p>
            </div>

            <form onSubmit={submit} className="mt-8 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">Email</span>
                <Input
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@business.com"
                  disabled={loading}
                />
              </label>

              <label className="block">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="block text-xs font-semibold uppercase tracking-wider text-muted">Password</span>
                  <button type="button" tabIndex={-1}
                    className="text-xs font-medium text-accent/80 transition-colors hover:text-accent hover:underline">
                    Forgot password?
                  </button>
                </div>
                <Input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  disabled={loading}
                />
              </label>

              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-rose/25 bg-rose/10 px-3 py-2.5 text-sm text-rose shadow-[0_0_20px_-6px_rgba(244,63,94,0.35)] animate-[fadeInUp_0.25s_ease-out]">
                  <Icon name="error" size={18} className="mt-px shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                loading={loading}
                icon="login"
                className="w-full py-2.5 text-[15px]"
              >
                {loading ? 'Authenticating…' : 'Enter AGENT OS'}
              </Button>
            </form>

            <div className="mt-7 flex items-center justify-center gap-1.5 text-[11px] uppercase tracking-[0.25em] text-muted/70">
              <span className="h-1 w-1 rounded-full bg-accent animate-pulseGlow" />
              secure channel
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
