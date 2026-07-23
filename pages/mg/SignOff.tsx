// Max Gleam — customer digital sign-off.
// Opened straight from an SMS on a phone: no login, no app, one thumb.
// Access is granted by the HMAC token in the link, so the page is useless
// to anyone who did not receive the text.
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  MGShell, MGButton, MGCard, MGAlert, MGPill, MGSpinner, MGTextarea, Stars,
} from './MGKit';
import {
  mgApi, compressImage, gbp, niceDate, niceStamp, photoUrl,
  type MgJob, type MgSignoffView,
} from '../../lib/mgApi';

function JobSummary({ job }: { job: MgJob }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-4">
      <div className="font-bold text-slate-900">{job.address}</div>
      {job.postcode && <div className="text-sm text-slate-500">{job.postcode}</div>}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {[
          ['Cleaned', niceDate(job.scheduled_date)],
          ['Reference', job.ref],
          ['Cleaner', job.crew_name || job.company_name],
          ['Price', gbp(job.price_pence)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{k}</dt>
            <dd className="truncate font-semibold text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function SignOff() {
  const { jobId } = useParams();
  const [params] = useSearchParams();
  const token = params.get('t') || '';
  const id = Number(jobId);

  const [view, setView] = useState<MgSignoffView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);

  const [rating, setRating] = useState(0);
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<MgJob | null>(null);
  const [photoWarning, setPhotoWarning] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!id || !token) { setLoadError('This link is incomplete.'); setLoading(false); return; }
    mgApi.signoff(id, token)
      .then(setView)
      .catch(e => setLoadError(e?.message || 'This sign-off link could not be opened.'))
      .finally(() => setLoading(false));
  }, [id, token]);

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    try {
      setPhoto(await compressImage(file));
      setPhotoName(file.name);
    } catch (e: any) {
      setError(e?.message || 'Could not read that photo.');
    }
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await mgApi.submitSignoff(id, token, {
        rating: rating || null, note: note.trim(), photo_data_url: photo,
      });
      setDone(res.job);
      if (res.photo_error) setPhotoWarning(res.photo_error);
    } catch (e: any) {
      setError(e?.message || 'Could not save your sign-off.');
    } finally {
      setBusy(false);
    }
  };

  // ── States ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <MGShell compact>
        <div className="flex min-h-[50vh] items-center justify-center text-slate-400"><MGSpinner /></div>
      </MGShell>
    );
  }

  if (loadError) {
    return (
      <MGShell compact>
        <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">
          <MGCard className="p-6 text-center">
            <div className="text-4xl">🔗</div>
            <h1 className="mt-3 text-xl font-bold text-slate-900">This link isn't working</h1>
            <p className="mt-2 text-slate-600">{loadError}</p>
            <p className="mt-4 text-sm text-slate-500">
              Please check the text message you were sent, or give us a call and we'll sort it out.
            </p>
          </MGCard>
        </div>
      </MGShell>
    );
  }

  const job = done || view!.job;

  // Thank-you state, shown right after signing and on any later revisit.
  if (done || view!.already_signed) {
    const shownRating = done ? rating : job.rating || 0;
    return (
      <MGShell compact>
        <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">
          <MGCard className="p-6 text-center sm:p-8">
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-green-100 text-3xl">✓</span>
            <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-slate-900">
              {done ? 'Thank you!' : 'Already signed off'}
            </h1>
            <p className="mt-2 text-slate-600">
              {done
                ? 'Your sign-off has been recorded and sent to the team.'
                : `This clean was signed off on ${niceStamp(job.signoff_at)}.`}
            </p>

            {shownRating > 0 && (
              <div className="mt-5 flex justify-center"><Stars value={shownRating} size={30} /></div>
            )}
            {job.signoff_note && (
              <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-left text-sm text-slate-700">
                "{job.signoff_note}"
              </p>
            )}
            {photoWarning && (
              <div className="mt-4 text-left">
                <MGAlert tone="warn">
                  Your sign-off was saved, but the photo could not be: {photoWarning}
                </MGAlert>
              </div>
            )}

            <div className="mt-6 text-left"><JobSummary job={job} /></div>

            {!!job.photos.length && (
              <div className="mt-4 grid grid-cols-3 gap-2">
                {job.photos.map(p => (
                  <img key={p.id} src={photoUrl(p.id)} alt={p.caption || 'Job photo'}
                    loading="lazy"
                    className="h-24 w-full rounded-xl border border-slate-200 object-cover" />
                ))}
              </div>
            )}

            {job.company_phone && (
              <p className="mt-6 text-sm text-slate-500">
                Something not right?{' '}
                <a href={`tel:${job.company_phone.replace(/\s/g, '')}`}
                  className="font-bold text-[#19C3E6] hover:underline">Call {job.company_name}</a>
              </p>
            )}
          </MGCard>
        </div>
      </MGShell>
    );
  }

  // ── The sign-off form ─────────────────────────────────────────────
  return (
    <MGShell compact>
      <div className="mx-auto max-w-xl px-4 py-6 sm:px-6 sm:py-10">
        <MGCard className="p-5 sm:p-7">
          <MGPill tone="teal">Clean completed</MGPill>
          <h1 className="mt-3 text-2xl font-extrabold leading-snug tracking-tight text-slate-900">
            Was your clean completed to your satisfaction?
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-slate-600">
            Tap below to confirm. It takes a few seconds and helps {job.company_name} keep
            standards high.
          </p>

          <div className="mt-5"><JobSummary job={job} /></div>

          {!!job.photos.length && (
            <div className="mt-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">Photos from the visit</div>
              <div className="grid grid-cols-3 gap-2">
                {job.photos.map(p => (
                  <img key={p.id} src={photoUrl(p.id)} alt={p.caption || 'Job photo'}
                    loading="lazy"
                    className="h-24 w-full rounded-xl border border-slate-200 object-cover" />
                ))}
              </div>
            </div>
          )}

          {/* Rating */}
          <div className="mt-6">
            <div className="text-sm font-semibold text-slate-700">How did we do?</div>
            <div className="mt-2 flex items-center gap-3">
              <Stars value={rating} onChange={setRating} />
              {rating > 0 && (
                <span className="text-sm font-semibold text-slate-500">
                  {['', 'Poor', 'Fair', 'Good', 'Great', 'Excellent'][rating]}
                </span>
              )}
            </div>
          </div>

          {/* Note */}
          <div className="mt-5">
            <div className="mb-1.5 text-sm font-semibold text-slate-700">
              Anything you'd like to add? <span className="font-normal text-slate-400">(optional)</span>
            </div>
            <MGTextarea rows={3} value={note} maxLength={1000}
              onChange={e => setNote(e.target.value)}
              placeholder="Missed a window, gate left open, or just a thank you…" />
          </div>

          {/* Photo */}
          <div className="mt-5">
            <div className="mb-1.5 text-sm font-semibold text-slate-700">
              Add a photo <span className="font-normal text-slate-400">(optional)</span>
            </div>
            <input ref={fileRef} type="file" accept="image/*" capture="environment"
              className="hidden" onChange={e => pickPhoto(e.target.files?.[0])} />
            {photo ? (
              <div className="flex items-center gap-3 rounded-xl border border-slate-200 p-2.5">
                <img src={photo} alt="Your upload"
                  className="h-16 w-16 shrink-0 rounded-lg object-cover" />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-600">{photoName}</span>
                <button onClick={() => { setPhoto(null); setPhotoName(''); if (fileRef.current) fileRef.current.value = ''; }}
                  className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-bold text-slate-400 hover:bg-red-50 hover:text-red-600">
                  Remove
                </button>
              </div>
            ) : (
              <MGButton tone="secondary" className="w-full" onClick={() => fileRef.current?.click()}>
                📷 Take or choose a photo
              </MGButton>
            )}
          </div>

          {error && <div className="mt-5"><MGAlert>{error}</MGAlert></div>}

          <MGButton onClick={submit} loading={busy} className="mt-6 w-full py-3.5 text-base">
            ✓ Confirm my clean
          </MGButton>

          <p className="mt-4 text-center text-xs leading-relaxed text-slate-500">
            If we don't hear from you within {view!.auto_approve_hours} hours the clean is
            automatically approved. You can still call us any time if there's a problem.
          </p>
        </MGCard>
      </div>
    </MGShell>
  );
}
