// Max Gleam — mobile crew view (/crew).
//
// This is the one AGENT OS surface designed for a cold, wet thumb: white
// background, no chrome, one job per card, and every action a full-width
// target. A cleaner opens it at the van and works down the round in order,
// so the page never asks them to hunt for anything.
//
// Sign-in is a code texted to the number already on the crew list — no
// password to forget on site. The token lives in localStorage so the app
// survives the phone locking between stops.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MGShell, MGMark, MGButton, MGCard, MGInput, MGTextarea, MGLabel,
  MGAlert, MGPill, MGSpinner,
} from './MGKit';
import {
  crewApi, getCrewToken, setCrewToken, clearCrewToken, photoUrl, money, notifyNotice,
  type Crew, type CrewJob, type CrewToday,
} from '../../lib/crewApi';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

// Location sharing is remembered per device, defaults off, and is only ever
// consulted while a job is open (see useJobTracking).
const TRACKING_KEY = 'maxgleam_crew_tracking';

type TrackState = 'off' | 'starting' | 'live' | 'denied' | 'error';

/**
 * Report this phone's position while a job is open.
 *
 * Deliberately bounded: the watch starts when a job is started and stops the
 * moment it completes or the crew switches sharing off, so the app cannot
 * follow anyone home. The server also refuses points for a job that is not
 * open, which is what makes that a guarantee rather than a promise.
 */
function useJobTracking(jobId: number | null, enabled: boolean) {
  const [state, setState] = useState<TrackState>('off');
  const [lastFix, setLastFix] = useState<number | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    if (!enabled || !jobId || !('geolocation' in navigator)) {
      setState(enabled && !('geolocation' in navigator) ? 'error' : 'off');
      return;
    }
    setState('starting');

    const id = navigator.geolocation.watchPosition(
      pos => {
        setState('live');
        // The browser fires far more often than the log needs; one request at
        // a time keeps a poor connection from queueing a backlog of stale fixes.
        if (sending.current) return;
        sending.current = true;
        crewApi.sendPosition(jobId, pos.coords.latitude, pos.coords.longitude,
          pos.coords.accuracy)
          .then(r => { if (r.stored) setLastFix(Date.now()); })
          .catch(() => { /* a dropped fix is not worth interrupting the round */ })
          .finally(() => { sending.current = false; });
      },
      err => setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'error'),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 });

    return () => {
      navigator.geolocation.clearWatch(id);
      setState('off');
    };
  }, [jobId, enabled]);

  return { state, lastFix, tracking: state === 'live' || state === 'starting' };
}

function TrackingBar({ enabled, onToggle, state, lastFix, address }: {
  enabled: boolean; onToggle: (on: boolean) => void;
  state: TrackState; lastFix: number | null; address: string;
}) {
  const look = !enabled ? { tone: 'slate' as const, text: 'Location sharing off' }
    : state === 'live' ? { tone: 'green' as const, text: 'Sharing your location' }
    : state === 'starting' ? { tone: 'amber' as const, text: 'Finding your location…' }
    : state === 'denied' ? { tone: 'red' as const, text: 'Location blocked in your browser' }
    : state === 'error' ? { tone: 'red' as const, text: 'Location unavailable' }
    : { tone: 'slate' as const, text: 'Location sharing off' };

  return (
    <MGCard className="mb-4 p-4">
      <div className="flex items-center gap-3">
        <span className="text-xl leading-none" aria-hidden>{enabled ? '📡' : '📴'}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <MGPill tone={look.tone}>{look.text}</MGPill>
          </div>
          <p className="mt-1 truncate text-xs text-slate-500">
            While you&rsquo;re on {address}
            {lastFix ? ` · last sent ${new Date(lastFix).toLocaleTimeString('en-GB',
              { hour: '2-digit', minute: '2-digit' })}` : ''}
          </p>
        </div>
        <MGButton tone={enabled ? 'secondary' : 'primary'} className="shrink-0"
          onClick={() => onToggle(!enabled)}>
          {enabled ? 'Stop' : 'Share'}
        </MGButton>
      </div>
      {state === 'denied' && (
        <p className="mt-2.5 text-xs text-slate-500">
          Your browser is blocking location. Allow it in the site settings, then tap Share again.
        </p>
      )}
    </MGCard>
  );
}

export default function CrewApp() {
  const [crew, setCrew] = useState<Crew | null>(null);
  const [booting, setBooting] = useState(true);

  // A stored token is only trustworthy if the server still honours it, so
  // the boot check is a real request rather than a presence test.
  useEffect(() => {
    if (!getCrewToken()) { setBooting(false); return; }
    crewApi.today()
      .then(r => setCrew(r.crew))
      .catch(() => clearCrewToken())
      .finally(() => setBooting(false));
  }, []);

  if (booting) {
    return (
      <MGShell compact>
        <div className="flex items-center justify-center py-24 text-slate-400">
          <MGSpinner className="h-7 w-7" />
        </div>
      </MGShell>
    );
  }
  if (!crew) return <CrewLogin onAuthed={setCrew} />;
  return <CrewRound crew={crew} onSignOut={() => { clearCrewToken(); setCrew(null); }} />;
}

// ── Sign in ─────────────────────────────────────────────────────────────

function CrewLogin({ onAuthed }: { onAuthed: (c: Crew) => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await crewApi.requestCode(phone);
      setStage('code');
      // Texts are disabled on this box (dry-run); show the code so the round
      // can still be opened rather than leaving the crew stuck at a prompt.
      setHint(r.dry_run && r.code
        ? `Texts are in test mode — your code is ${r.code}`
        : r.message || 'Check your phone for the code.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code');
    } finally { setBusy(false); }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await crewApi.verifyCode(phone, code);
      if (r.token && r.crew) { setCrewToken(r.token); onAuthed(r.crew); }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code is not right');
    } finally { setBusy(false); }
  }

  return (
    <MGShell compact>
      <main className="mx-auto max-w-md px-4 py-10 sm:px-6">
        <div className="mb-7 text-center">
          <h1 className="text-2xl font-extrabold tracking-tight">Crew sign-in</h1>
          <p className="mt-1.5 text-sm text-slate-500">
            {stage === 'phone'
              ? 'Enter the mobile number the office has for you.'
              : 'Enter the 6-digit code we just sent.'}
          </p>
        </div>

        <MGCard className="p-5">
          {stage === 'phone' ? (
            <form onSubmit={sendCode} className="space-y-4">
              <div>
                <MGLabel>Mobile number</MGLabel>
                <MGInput type="tel" inputMode="tel" autoComplete="tel" required
                  value={phone} onChange={e => setPhone(e.target.value)}
                  placeholder="07700 900123" className="py-3.5 text-lg" />
              </div>
              {error && <MGAlert>{error}</MGAlert>}
              <MGButton type="submit" loading={busy} className="w-full py-4 text-base">
                Text me a code
              </MGButton>
            </form>
          ) : (
            <form onSubmit={verify} className="space-y-4">
              {hint && <MGAlert tone="info">{hint}</MGAlert>}
              <div>
                <MGLabel>Code</MGLabel>
                <MGInput inputMode="numeric" autoComplete="one-time-code" required
                  maxLength={6} value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="py-3.5 text-center text-xl font-bold tracking-[0.3em] sm:text-2xl sm:tracking-[0.4em]" />
              </div>
              {error && <MGAlert>{error}</MGAlert>}
              <MGButton type="submit" loading={busy} disabled={code.length < 6}
                className="w-full py-4 text-base">
                Sign in
              </MGButton>
              <MGButton type="button" tone="ghost" className="w-full"
                onClick={() => { setStage('phone'); setCode(''); setError(null); }}>
                Use a different number
              </MGButton>
            </form>
          )}
        </MGCard>

        <p className="mt-6 text-center text-xs text-slate-400">
          Can’t get in? Call the office.
        </p>
      </main>
    </MGShell>
  );
}

// ── The round ───────────────────────────────────────────────────────────

function CrewRound({ crew, onSignOut }: { crew: Crew; onSignOut: () => void }) {
  const [data, setData] = useState<CrewToday | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState('');

  const load = useCallback(async (d?: string) => {
    setLoading(true); setError(null);
    try {
      setData(await crewApi.today(d));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your round');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(date || undefined); }, [load, date]);

  // The job the crew is stood on: started, not finished. Tracking follows it.
  const activeJob = data?.jobs.find(j => j.started_at && !j.completed_at && j.status !== 'done')
    ?? null;
  const [shareLocation, setShareLocation] = useState(
    () => localStorage.getItem(TRACKING_KEY) === '1');
  const setShare = useCallback((on: boolean) => {
    localStorage.setItem(TRACKING_KEY, on ? '1' : '0');
    setShareLocation(on);
  }, []);
  const track = useJobTracking(activeJob?.job_id ?? null, shareLocation && !!activeJob);

  const summary = data?.summary;
  const progress = summary && summary.total
    ? Math.round((summary.done / summary.total) * 100) : 0;

  return (
    <MGShell compact>
      <main className="mx-auto max-w-xl px-4 pb-[max(6rem,env(safe-area-inset-bottom))] pt-5 sm:px-6">
        {/* Who and when */}
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-extrabold tracking-tight">
              {crew.name.split(' ')[0]}’s round
            </h1>
            <p className="text-sm text-slate-500">{prettyDate(data?.date || date)}</p>
          </div>
          <button onClick={onSignOut}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-100 min-h-[40px]">
            Sign out
          </button>
        </div>

        {/* Progress */}
        {summary && summary.total > 0 && (
          <MGCard className="mb-4 p-4">
            <div className="mb-2.5 flex items-baseline justify-between">
              <span className="text-sm font-bold">
                {summary.done} of {summary.total} done
              </span>
              <span className="text-sm font-semibold text-slate-500">
                {money(summary.value_pence)} on the round
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-[#19C3E6] transition-[width] duration-500"
                style={{ width: `${progress}%` }} />
            </div>
          </MGCard>
        )}

        {/* Location sharing — only ever offered while a job is actually open */}
        {activeJob && (
          <TrackingBar enabled={shareLocation} onToggle={setShare}
            state={track.state} lastFix={track.lastFix} address={activeJob.address} />
        )}

        {/* Day picker — for catching up on yesterday, or looking ahead */}
        <div className="mb-4 flex items-center gap-2">
          <MGInput type="date" value={date || data?.date || ''}
            onChange={e => setDate(e.target.value)} className="flex-1" />
          {date && (
            <MGButton tone="secondary" onClick={() => setDate('')}>Today</MGButton>
          )}
        </div>

        {error && <MGAlert>{error}</MGAlert>}

        {loading && !data ? (
          <div className="space-y-3">
            {[0, 1, 2].map(i => (
              <div key={i} className="h-40 animate-pulse rounded-2xl bg-slate-100" />
            ))}
          </div>
        ) : !data?.jobs.length ? (
          <MGCard className="px-6 py-14 text-center">
            <div className="mb-3 flex justify-center"><MGMark size={44} /></div>
            <p className="text-base font-bold">Nothing booked</p>
            <p className="mt-1 text-sm text-slate-500">
              No jobs on your round for this day.
            </p>
          </MGCard>
        ) : (
          <div className="space-y-4">
            {data.jobs.map((job, i) => (
              <JobCard key={job.job_id} job={job} stop={i + 1}
                onChanged={() => load(date || undefined)} />
            ))}
          </div>
        )}
      </main>
    </MGShell>
  );
}

// ── One stop ────────────────────────────────────────────────────────────

function JobCard({ job, stop, onChanged }:
  { job: CrewJob; stop: number; onChanged: () => void }) {
  const [panel, setPanel] = useState<'none' | 'complete' | 'issue' | 'photos'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const done = job.status === 'done';
  const started = !!job.started_at && !done;

  const toggle = (p: typeof panel) => {
    setError(null);
    setPanel(cur => (cur === p ? 'none' : p));
  };

  async function start() {
    setBusy(true); setError(null);
    try {
      const res = await crewApi.startJob(job.job_id);
      setNotice(notifyNotice(res.notified));   // "Customer texted you're on the way", or null
      onChanged();
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not start the job'); }
    finally { setBusy(false); }
  }

  return (
    <MGCard className={`overflow-hidden ${done ? 'opacity-70' : ''}`}>
      {/* Address block — the biggest thing on the card, because it is the
          only thing that matters while you are looking for the house. */}
      <div className="border-b border-slate-100 p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-extrabold
            ${done ? 'bg-green-100 text-green-700' : 'bg-[#19C3E6] text-white'}`}>
            {done ? '✓' : stop}
          </span>
          {done
            ? <MGPill tone="green">Complete</MGPill>
            : started
              ? <MGPill tone="amber">In progress</MGPill>
              : <MGPill tone="slate">To do</MGPill>}
          <span className="ml-auto text-sm font-bold text-slate-500">
            {money(job.price_pence)}
          </span>
        </div>
        <h2 className="text-lg font-extrabold leading-snug tracking-tight">{job.address}</h2>
        {job.postcode && (
          <p className="mt-0.5 text-base font-bold text-slate-500">{job.postcode}</p>
        )}
        {job.customer_name && (
          <p className="mt-1.5 text-sm text-slate-500">{job.customer_name}</p>
        )}
      </div>

      {/* Instructions */}
      <div className="space-y-3 p-4">
        <Detail label="What to clean"
          value={job.job_notes || job.customer_notes
            || `Regular clean, every ${job.frequency_weeks} weeks`} />
        {job.access_notes && <Detail label="Access" value={job.access_notes} tone="amber" />}
        {job.customer_notes && job.job_notes && (
          <Detail label="Customer notes" value={job.customer_notes} />
        )}
      </div>

      {/* Navigate / call / photos */}
      <div className="grid grid-cols-3 gap-2 px-4 pb-3">
        <a href={job.maps_url} target="_blank" rel="noreferrer"
          className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-xl
            border border-slate-300 bg-white text-xs font-bold text-slate-700
            transition-colors hover:bg-slate-50 active:scale-[0.98]">
          <span className="text-lg leading-none">📍</span> Navigate
        </a>
        <a href={job.customer_phone ? `tel:${job.customer_phone}` : undefined}
          aria-disabled={!job.customer_phone}
          className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-xl
            border border-slate-300 bg-white text-xs font-bold text-slate-700 transition-colors
            ${job.customer_phone ? 'hover:bg-slate-50 active:scale-[0.98]'
              : 'pointer-events-none opacity-40'}`}>
          <span className="text-lg leading-none">📞</span> Call
        </a>
        <button onClick={() => toggle('photos')}
          className="flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-xl
            border border-slate-300 bg-white text-xs font-bold text-slate-700
            transition-colors hover:bg-slate-50 active:scale-[0.98]">
          <span className="text-lg leading-none">🖼️</span>
          Photos{job.photos.length ? ` (${job.photos.length})` : ''}
        </button>
      </div>

      {panel === 'photos' && (
        <div className="border-t border-slate-100 p-4">
          {job.photos.length ? (
            <div className="grid grid-cols-3 gap-2">
              {job.photos.map(p => (
                <a key={p.id} href={photoUrl(p.id)} target="_blank" rel="noreferrer"
                  className="block overflow-hidden rounded-lg border border-slate-200">
                  <img src={photoUrl(p.id)} alt={p.caption || `${p.kind} photo`}
                    loading="lazy" className="h-24 w-full object-cover" />
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No photos for this property yet.</p>
          )}
        </div>
      )}

      {/* Primary actions */}
      <div className="space-y-2 border-t border-slate-100 bg-slate-50/60 p-4">
        {error && <MGAlert>{error}</MGAlert>}
        {notice && !done && (
          <p className="flex items-center gap-1.5 text-center text-sm font-semibold text-[#0E9BB8]">
            <span aria-hidden>💬</span>{notice}
          </p>
        )}
        {!done && (
          <div className="grid grid-cols-2 gap-2">
            <MGButton tone="secondary" onClick={start} loading={busy} disabled={started}
              className="min-h-[52px] w-full text-base">
              {started ? 'Started' : 'Start job'}
            </MGButton>
            <MGButton onClick={() => toggle('complete')}
              className="min-h-[52px] w-full text-base">
              Complete job
            </MGButton>
          </div>
        )}
        {done && (
          <p className="text-center text-sm font-semibold text-green-700">
            Completed{job.completed_at ? ` at ${clockOf(job.completed_at)}` : ''}
          </p>
        )}
        <MGButton tone="ghost" onClick={() => toggle('issue')} className="w-full min-h-[48px]">
          Report an issue
        </MGButton>
      </div>

      {panel === 'complete' && (
        <CompletePanel job={job} onDone={() => { setPanel('none'); onChanged(); }}
          onCancel={() => setPanel('none')} />
      )}
      {panel === 'issue' && (
        <IssuePanel job={job} onDone={() => { setPanel('none'); onChanged(); }}
          onCancel={() => setPanel('none')} />
      )}
    </MGCard>
  );
}

function Detail({ label, value, tone }:
  { label: string; value: string; tone?: 'amber' }) {
  return (
    <div className={`rounded-xl px-3.5 py-3 ${tone === 'amber'
      ? 'border border-amber-200 bg-amber-50' : 'bg-slate-50'}`}>
      <div className={`mb-1 text-[11px] font-extrabold uppercase tracking-wider
        ${tone === 'amber' ? 'text-amber-700' : 'text-slate-400'}`}>
        {label}
      </div>
      <p className={`whitespace-pre-line text-sm font-medium leading-relaxed
        ${tone === 'amber' ? 'text-amber-900' : 'text-slate-700'}`}>
        {value}
      </p>
    </div>
  );
}

// ── Complete ────────────────────────────────────────────────────────────

function CompletePanel({ job, onDone, onCancel }:
  { job: CrewJob; onDone: () => void; onCancel: () => void }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await crewApi.completeJob(job.job_id, notes); onDone(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not complete the job'); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-t border-slate-200 bg-white p-4">
      <MGLabel hint="optional">Anything the office should know?</MGLabel>
      <MGTextarea rows={3} value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="Back gate locked, did fronts only…" />
      {error && <MGAlert>{error}</MGAlert>}
      <div className="grid grid-cols-2 gap-2">
        <MGButton type="button" tone="secondary" onClick={onCancel}
          className="min-h-[52px] w-full">Cancel</MGButton>
        <MGButton type="submit" loading={busy} className="min-h-[52px] w-full text-base">
          Mark complete
        </MGButton>
      </div>
    </form>
  );
}

// ── Report an issue ─────────────────────────────────────────────────────

function IssuePanel({ job, onDone, onCancel }:
  { job: CrewJob; onDone: () => void; onCancel: () => void }) {
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<string>('normal');
  const [photo, setPhoto] = useState<string | undefined>();
  const [photoName, setPhotoName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function pickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > PHOTO_MAX_BYTES) {
      setError('That photo is over 5MB — take a smaller one.');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setPhoto(String(reader.result)); setPhotoName(file.name); };
    reader.onerror = () => setError('Could not read that photo');
    reader.readAsDataURL(file);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await crewApi.reportIssue(job.job_id, description, priority, photo);
      // The report is saved even when the photo is rejected; say so rather
      // than letting the crew think the whole thing failed.
      if (r.photo_error) setError(`Reported — but the photo failed: ${r.photo_error}`);
      else onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the report');
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border-t border-slate-200 bg-white p-4">
      <div>
        <MGLabel>What’s the problem?</MGLabel>
        <MGTextarea rows={3} required value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Cracked pane in the bay window, customer aware…" />
      </div>

      <div>
        <MGLabel>How urgent?</MGLabel>
        <div className="grid grid-cols-4 gap-1.5">
          {PRIORITIES.map(p => (
            <button key={p} type="button" onClick={() => setPriority(p)}
              className={`min-h-[44px] rounded-xl border text-xs font-bold capitalize transition-colors
                ${priority === p
                  ? 'border-[#19C3E6] bg-[#19C3E6]/10 text-[#0E7C93]'
                  : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}>
              {p}
            </button>
          ))}
        </div>
      </div>

      <div>
        <MGLabel hint="optional">Photo</MGLabel>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png" capture="environment"
          onChange={pickPhoto}
          className="block w-full text-sm text-slate-600 file:mr-3 file:min-h-[44px] file:rounded-xl
            file:border file:border-slate-300 file:bg-white file:px-4 file:text-sm file:font-bold
            file:text-slate-700" />
        {photoName && (
          <p className="mt-1.5 text-xs font-semibold text-green-700">Attached: {photoName}</p>
        )}
      </div>

      {error && <MGAlert>{error}</MGAlert>}
      <div className="grid grid-cols-2 gap-2">
        <MGButton type="button" tone="secondary" onClick={onCancel}
          className="min-h-[52px] w-full">Cancel</MGButton>
        <MGButton type="submit" loading={busy} disabled={!description.trim()}
          className="min-h-[52px] w-full text-base">
          Send report
        </MGButton>
      </div>
    </form>
  );
}

// ── Formatting ──────────────────────────────────────────────────────────

function prettyDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const label = d.toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long' });
  return isToday ? `Today · ${label}` : label;
}

function clockOf(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-GB',
    { hour: '2-digit', minute: '2-digit' });
}
