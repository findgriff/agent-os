// Max Gleam time clock — the crew-facing surface at /timeclock.
//
// Built for a phone in a van: pick who you are once (remembered on the
// device), then one big CLOCK IN / CLOCK OUT button per job on today's round.
// No AGENT OS chrome and no HQ login — crews authenticate with the shared crew
// code (see MAXGLEAM_CREW_CODE), or an office user's existing HQ token.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState, Icon, Input, useToast } from '../../components/ui';
import {
  reportsApi, getCrewCode, setCrewCode, clearCrewCode, ReportsApiError,
  gbp, hoursMins, clockTime, dayLabel,
  type ClockBoard, type ClockCrew, type ClockJob,
} from '../../lib/reportsApi';
import { getToken } from '../../lib/api';

const CREW_ID_KEY = 'maxgleam_crew_id';
const ACCENT = '#19C3E6';

/** Live "12:34" elapsed counter for an open clock-in. */
function useElapsed(since: number | null): string {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return '00:00';
  const s = Math.max(0, now - since);
  const h = Math.floor(s / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
           : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

// ── Crew code gate ──────────────────────────────────────────────────────
function CodeGate({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-5">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/10 text-accent"
            style={{ boxShadow: `0 0 28px -8px ${ACCENT}88` }}>
            <Icon name="schedule" size={24} />
          </span>
          <div>
            <h1 className="font-display text-lg font-bold text-ink">Time clock</h1>
            <p className="text-[12px] text-muted">Max Gleam crew</p>
          </div>
        </div>
        <form onSubmit={e => { e.preventDefault(); if (code.trim()) { setCrewCode(code.trim()); onDone(); } }}>
          <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
            Crew code
          </label>
          <Input value={code} onChange={e => setCode(e.target.value)} autoFocus
            placeholder="Enter your crew code" type="password" />
          <Button variant="primary" className="mt-4 w-full min-h-[44px]" type="submit" disabled={!code.trim()}>
            Continue
          </Button>
        </form>
        <p className="mt-4 text-[11px] leading-relaxed text-muted/70">
          Ask the office for the code. It is stored on this device only.
        </p>
      </Card>
    </div>
  );
}

// ── Who are you? ────────────────────────────────────────────────────────
function CrewPicker({ crews, onPick }: { crews: ClockCrew[]; onPick: (c: ClockCrew) => void }) {
  return (
    <div className="mx-auto max-w-md space-y-3 p-5">
      <h2 className="font-display text-lg font-bold text-ink">Who&rsquo;s clocking in?</h2>
      <p className="text-[12px] text-muted">Tap your name. We&rsquo;ll remember it on this device.</p>
      {crews.length === 0 ? (
        <EmptyState icon="groups" title="No active crew"
          hint="Nobody is set up as an active subcontractor for this round." />
      ) : crews.map(c => (
        <button key={c.id} onClick={() => onPick(c)}
          className="flex w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.03] p-4
            text-left transition-all active:scale-[0.98] hover:border-accent/30 hover:bg-white/[0.06]">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
            <Icon name="person" size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-ink">{c.name}</div>
            {c.company_name && <div className="truncate text-[12px] text-muted">{c.company_name}</div>}
          </div>
          {c.open_log && <Badge tone="ok" dot>on the clock</Badge>}
          <Icon name="chevron_right" size={20} className="text-muted" />
        </button>
      ))}
    </div>
  );
}

// ── Job card with the big button ────────────────────────────────────────
function JobCard({ job, openHere, busy, locked, blockedBy, onIn, onOut }: {
  job: ClockJob;
  openHere: boolean;
  busy: boolean;
  locked: boolean;
  // The address of the OTHER job this crew is already on, if any. You can
  // only be on one clock at a time, so this card's Clock in would 409 — say
  // so up front rather than letting the tap bounce off the server.
  blockedBy: string | null;
  onIn: () => void;
  onOut: () => void;
}) {
  const over = job.logged_minutes > job.estimated_minutes;
  const blocked = !openHere && !!blockedBy;
  return (
    <Card className={`overflow-hidden p-0 transition-all ${openHere ? 'border-emerald/40' : ''}`}
      style={openHere ? { boxShadow: '0 0 34px -10px rgba(34,197,94,0.55)' } : undefined}>
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-ink">{job.address}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
              {job.postcode && <span className="font-mono">{job.postcode}</span>}
              {job.customer_name && <span className="truncate">· {job.customer_name}</span>}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-sm font-semibold tabular-nums text-ink">{gbp(job.price_pence)}</div>
            <div className="text-[11px] tabular-nums text-muted">est {job.estimated_minutes}m</div>
          </div>
        </div>

        {job.logged_minutes > 0 && (
          <div className="mt-3 flex items-center gap-2 text-[12px]">
            <Icon name="timer" size={14} className={over ? 'text-amber' : 'text-emerald'} />
            <span className="text-muted">Logged today</span>
            <span className={`font-semibold tabular-nums ${over ? 'text-amber' : 'text-emerald'}`}>
              {hoursMins(job.logged_minutes)}
            </span>
            {over && <Badge tone="warn">+{job.logged_minutes - job.estimated_minutes}m over</Badge>}
          </div>
        )}
      </div>

      {blocked && (
        <div className="flex items-center gap-1.5 border-t border-white/6 bg-white/[0.02] px-4 py-2 text-[11px] text-muted">
          <Icon name="lock_clock" size={13} className="text-amber" />
          Clock out of {blockedBy} first
        </div>
      )}

      <button
        onClick={openHere ? onOut : onIn}
        disabled={busy || locked || blocked}
        className={`flex w-full items-center justify-center gap-2 py-4 text-base font-bold uppercase
          tracking-wider transition-all active:scale-[0.98] disabled:opacity-50
          ${openHere
            ? 'bg-gradient-to-br from-[#F43F5E] to-[#BE123C] text-white'
            : 'bg-gradient-to-br from-[#2AD4F5] to-[#0EA5C9] text-[#04222b]'}`}>
        <Icon name={busy ? 'progress_activity' : openHere ? 'stop_circle' : 'play_circle'}
          size={22} className={busy ? 'animate-spin' : ''} />
        {openHere ? 'Clock out' : 'Clock in'}
      </button>
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────
export default function TimeClock() {
  const toast = useToast();
  // An office user already holds an HQ token — no crew code needed.
  const [gated, setGated] = useState(() => !getCrewCode() && !getToken());
  const [board, setBoard] = useState<ClockBoard | null>(null);
  const [crewId, setCrewId] = useState<number | null>(() => {
    const raw = localStorage.getItem(CREW_ID_KEY);
    return raw ? Number(raw) || null : null;
  });
  const [loading, setLoading] = useState(true);
  const [busyJob, setBusyJob] = useState<number | 'general' | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setBoard(await reportsApi.board());
      setError('');
    } catch (e) {
      if (e instanceof ReportsApiError && (e.status === 401 || e.status === 403)) {
        // A stale or wrong crew code — send them back to the gate.
        clearCrewCode();
        setGated(true);
      }
      setError(e instanceof Error ? e.message : 'Could not load today’s round');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (!gated) load(); }, [gated, load]);
  // Someone else may clock a shared job in or out — keep the board honest.
  useEffect(() => {
    if (gated) return;
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [gated, load]);

  const crew = useMemo(
    () => board?.crews.find(c => c.id === crewId) || null,
    [board, crewId]);

  const openLog = crew?.open_log || null;
  const elapsed = useElapsed(openLog?.clock_in ?? null);

  // Today's jobs for this crew — plus any unassigned job, which is how cover
  // work reaches a van that was not on the original schedule.
  const jobs = useMemo(() => {
    if (!board || !crewId) return [];
    return board.jobs.filter(j => j.subcontractor_id === crewId || j.subcontractor_id === null);
  }, [board, crewId]);

  // Any open clock blocks starting another job — you can only be on one at a
  // time, so a second Clock in would 409. Name what they're on so the other
  // cards can say "clock out of X first" instead of bouncing off the server:
  // the job's address, or "general duties" for a no-job clock-in.
  const openWhere = !openLog ? null
    : openLog.job_id
      ? jobs.find(j => j.id === openLog.job_id)?.address ?? `job #${openLog.job_id}`
      : 'general duties';

  const act = async (fn: () => Promise<unknown>, key: number | 'general', ok: string) => {
    setBusyJob(key);
    try {
      await fn();
      toast(ok, 'ok');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not go through', 'danger');
    } finally {
      setBusyJob(null);
    }
  };

  if (gated) return <CodeGate onDone={() => { setGated(false); setLoading(true); }} />;

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg">
        <Icon name="schedule" size={34} className="animate-pulse text-accent" />
        <p className="text-[12px] text-muted">Loading today&rsquo;s round…</p>
      </div>
    );
  }

  if (error && !board) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg p-5">
        <EmptyState icon="error" accent="#F43F5E" title="Could not load the time clock" hint={error}
          action={<Button icon="refresh" onClick={() => { setLoading(true); load(); }}>Try again</Button>} />
      </div>
    );
  }

  if (!crewId || !crew) {
    return (
      <div className="min-h-screen bg-bg">
        <CrewPicker crews={board?.crews || []} onPick={c => {
          localStorage.setItem(CREW_ID_KEY, String(c.id));
          setCrewId(c.id);
        }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg pb-10">
      <header className="sticky top-0 z-10 border-b border-white/6 bg-bg/85 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-xl">
        <div className="mx-auto flex max-w-md items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
            <Icon name="schedule" size={21} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-base font-bold text-ink">{crew.name}</div>
            <div className="text-[11px] text-muted">{board ? dayLabel(board.day) : ''}</div>
          </div>
          <Button variant="ghost" icon="swap_horiz" className="!px-2.5 !py-1.5 !text-[12px] min-h-[44px]"
            onClick={() => { localStorage.removeItem(CREW_ID_KEY); setCrewId(null); }}>
            Not you?
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-md space-y-4 p-4">
        {/* Live clock face — only while a log is open. */}
        {openLog && (
          <Card className="border-emerald/40 p-5 text-center"
            style={{ boxShadow: '0 0 40px -12px rgba(34,197,94,0.6)' }}>
            <div className="flex items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-emerald">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald" />
              </span>
              On the clock
            </div>
            <div className="mt-2 font-mono text-5xl font-bold tabular-nums text-ink">{elapsed}</div>
            <div className="mt-1 text-[12px] text-muted">
              since {clockTime(openLog.clock_in)}
              {openLog.job_id ? ` · job #${openLog.job_id}` : ' · general duties'}
            </div>
          </Card>
        )}

        {/* General clock-in, for work that is not one of today's scheduled jobs. */}
        {!openLog && (
          <Button variant="secondary" icon="more_time" className="w-full !py-3.5"
            loading={busyJob === 'general'} disabled={busyJob !== null}
            onClick={() => act(() => reportsApi.clockIn(crew.id, null), 'general',
              'Clocked in — general duties')}>
            Clock in without a job
          </Button>
        )}

        <div className="flex items-center gap-2">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
            Today&rsquo;s round
          </h2>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] tabular-nums text-muted">
            {jobs.length}
          </span>
          <Button variant="ghost" icon="refresh" className="ml-auto !px-2 !py-1 !text-[12px] min-h-[44px]"
            onClick={load}>Refresh</Button>
        </div>

        {jobs.length === 0 ? (
          <EmptyState icon="event_available" title="Nothing scheduled today"
            hint="No jobs on today's round for you. Use the button above if you're working anyway." />
        ) : jobs.map(job => (
          <JobCard key={job.id} job={job}
            openHere={openLog?.job_id === job.id}
            busy={busyJob === job.id}
            locked={busyJob !== null}
            blockedBy={openLog?.job_id === job.id ? null : openWhere}
            onIn={() => act(() => reportsApi.clockIn(crew.id, job.id), job.id,
              `Clocked in at ${job.address}`)}
            onOut={() => act(() => reportsApi.clockOut(crew.id), job.id,
              `Clocked out of ${job.address}`)} />
        ))}

        {openLog && !openLog.job_id && (
          <Button variant="danger" icon="stop_circle" className="w-full !py-3.5"
            loading={busyJob === 'general'} disabled={busyJob !== null}
            onClick={() => act(() => reportsApi.clockOut(crew.id), 'general', 'Clocked out')}>
            Clock out
          </Button>
        )}
      </div>
    </div>
  );
}
