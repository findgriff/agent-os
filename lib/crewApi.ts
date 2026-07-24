// Max Gleam mobile crew view — the API a cleaner's phone talks to.
//
// Separate from lib/api.ts (HQ), lib/partnerApi.ts (partner companies) and
// lib/mgApi.ts (customers): a crew member signs in with a code texted to the
// number already on file, and the token that comes back is only good for
// their own round.

const CREW_KEY = 'maxgleam_crew_token';

export const getCrewToken = () => localStorage.getItem(CREW_KEY) || '';
export const setCrewToken = (t: string) => localStorage.setItem(CREW_KEY, t);
export const clearCrewToken = () => localStorage.removeItem(CREW_KEY);

export class CrewApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getCrewToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401) clearCrewToken();
    throw new CrewApiError(res.status, data.error || res.statusText);
  }
  return data as T;
}

// ── Types ───────────────────────────────────────────────────────────────
export interface Crew {
  id: number;
  name: string;
  phone: string | null;
  company_name: string | null;
}

export interface CrewPhoto {
  id: number;
  kind: string;
  caption: string | null;
  created_at: number;
}

export interface CrewJob {
  job_id: number;
  ref: string;
  property_id: number;
  address: string;
  postcode: string | null;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  scheduled_date: string;
  price_pence: number;
  frequency_weeks: number;
  job_notes: string | null;
  customer_notes: string | null;
  access_notes: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  maps_url: string;
  photos: CrewPhoto[];
}

export interface CrewToday {
  crew: Crew;
  date: string;
  jobs: CrewJob[];
  summary: { total: number; done: number; remaining: number; value_pence: number };
}

/** Outcome of the "on my way" text fired when a crew starts a job. */
export interface NotifyResult {
  trigger: string;
  status: 'sent' | 'dry_run' | 'duplicate' | 'disabled' | 'skipped_opt_out'
        | 'no_contact' | 'failed' | 'no_job';
  to?: string;
}

/** A one-line, crew-facing summary of whether the customer was told. Returns
 *  null when there is nothing worth saying (already sent, or office disabled). */
export function notifyNotice(n: NotifyResult | null | undefined): string | null {
  switch (n?.status) {
    case 'sent':            return 'Customer texted you’re on the way';
    case 'dry_run':         return 'Customer would be texted (test mode)';
    case 'skipped_opt_out': return 'Customer has opted out of texts';
    case 'no_contact':      return 'No number on file — customer not texted';
    default:                return null;   // duplicate / disabled / failed / no_job
  }
}

export interface CrewLoginResult {
  ok?: boolean;
  sent?: boolean;
  message?: string;
  dry_run?: boolean;
  code?: string;          // only ever returned when SMS is in dry-run mode
  token?: string;
  crew?: Crew;
}

// ── Calls ───────────────────────────────────────────────────────────────
export const crewApi = {
  requestCode: (phone: string) =>
    req<CrewLoginResult>('POST', '/api/maxgleam/crew/login', { phone }),
  verifyCode: (phone: string, code: string) =>
    req<CrewLoginResult>('POST', '/api/maxgleam/crew/login', { phone, code }),

  today: (date?: string) =>
    req<CrewToday>('GET', '/api/maxgleam/crew/today' + (date ? `?date=${date}` : '')),
  startJob: (jobId: number) =>
    req<{ job: CrewJob; notified: NotifyResult | null }>(
      'POST', '/api/maxgleam/crew/start-job', { job_id: jobId }),
  completeJob: (jobId: number, notes: string) =>
    req<{ job: CrewJob }>('POST', '/api/maxgleam/crew/complete-job',
      { job_id: jobId, notes }),
  reportIssue: (jobId: number, description: string, priority: string,
                photoDataUrl?: string) =>
    req<{ ok: boolean; work_request_id: number; photo_error: string | null }>(
      'POST', '/api/maxgleam/crew/report-issue',
      { job_id: jobId, description, priority, photo_data_url: photoDataUrl }),

  // Position reporting while a job is open. The server drops points that
  // arrive too fast or with a poor fix and says so in `stored`, so the phone
  // can report as often as the browser offers without flooding the log.
  sendPosition: (jobId: number, lat: number, lng: number, accuracy?: number) =>
    req<{ ok: boolean; stored: boolean; reason?: string; timestamp?: number }>(
      'POST', '/api/maxgleam/gps/update',
      { job_id: jobId, lat, lng, accuracy }),
};

export const photoUrl = (id: number) => `/api/maxgleam/photo/${id}`;
export const money = (pence: number) => `£${((pence || 0) / 100).toFixed(2)}`;
