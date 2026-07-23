// Partner portal sign-in — company code + password.
// Standalone shell: no AGENT OS sidebar, no HQ session.
import { useState } from 'react';
import { Button, Icon, Input } from '../components/ui';
import { partnerApi, setPartnerToken, type Partner } from '../lib/partnerApi';

export default function PartnerLogin({ onAuthed }: { onAuthed: (p: Partner) => void }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !password) {
      setError('Enter your company code and password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await partnerApi.login(code.trim(), password);
      setPartnerToken(res.token);
      onAuthed(res.partner);
    } catch (err: any) {
      setError(err?.message || 'Sign-in failed. Please try again.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg px-4 py-10">
      {/* ambient wash — teal above, deep space below */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(25,195,230,0.16),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,rgba(167,139,250,0.08),transparent_55%)]" />

      <div className="relative w-full max-w-md">
        {/* Brand */}
        <div className="mb-7 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-accent/30 bg-accent/10 shadow-[0_0_30px_-8px_rgba(25,195,230,0.7)]">
            <Icon name="cleaning_services" size={28} style={{ color: '#19C3E6' }} />
          </span>
          <h1 className="mt-4 font-display text-2xl font-bold tracking-tight text-ink">
            Max Gleam <span className="text-accent">Partner Portal</span>
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            Jobs, work requests and payments for partner companies.
          </p>
        </div>

        <form onSubmit={submit}
          className="glass rounded-2xl border border-white/10 p-6 shadow-2xl backdrop-blur-xl animate-fadeInUp">
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
            Company code
          </label>
          <Input
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="e.g. LEESHENDRY"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="username"
            className="tracking-wider"
          />

          <label className="mb-1.5 mt-4 block text-xs font-semibold uppercase tracking-wider text-muted">
            Password
          </label>
          <div className="relative">
            <Input
              type={show ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              className="pr-11"
            />
            <button type="button" onClick={() => setShow(s => !s)}
              aria-label={show ? 'Hide password' : 'Show password'}
              className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted transition-colors hover:bg-white/5 hover:text-ink">
              <Icon name={show ? 'visibility_off' : 'visibility'} size={18} />
            </button>
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-rose/25 bg-rose/10 px-3 py-2 text-sm text-rose">
              <Icon name="error" size={18} className="mt-px shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Button type="submit" variant="primary" loading={busy} className="mt-5 w-full py-2.5">
            Sign in
          </Button>

          <p className="mt-4 text-center text-xs leading-relaxed text-muted/70">
            Trouble signing in? Contact the Max Gleam office and we'll reset your access.
          </p>
        </form>

        <div className="mt-6 text-center text-[11px] uppercase tracking-[0.2em] text-muted/40">
          Max Gleam · Partner Access
        </div>
      </div>
    </div>
  );
}
