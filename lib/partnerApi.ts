// Partner portal API client — deliberately separate from lib/api.ts.
//
// Partners are maxgleam users, not AGENT OS users, and their session token
// is issued by a different database. Sharing `agentos_token` would let a
// partner session bleed into the HQ app (and vice-versa), so the portal
// keeps its own key and its own fetch wrapper.

const TOKEN_KEY = 'maxgleam_partner_token';

export const getPartnerToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setPartnerToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearPartnerToken = () => localStorage.removeItem(TOKEN_KEY);

export class PartnerApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getPartnerToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401) clearPartnerToken();
    throw new PartnerApiError(res.status, data.error || res.statusText);
  }
  return data as T;
}

// ── Types ───────────────────────────────────────────────────────────────
export interface PartnerCompany {
  id: number;
  name: string;
  code: string;
  colour: string;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
}

export interface Partner {
  id: number;
  name: string;
  email: string;
  company: PartnerCompany;
}

export interface PartnerJob {
  id: number;
  scheduled_date: string;
  status: string;
  price_pence: number;
  address: string;
  postcode: string | null;
  customer_name: string | null;
  crew_name: string | null;
  notes: string | null;
  access_notes: string | null;
  completed_at: number | null;
  signoff_status: string | null;
}

export interface PartnerJobs {
  upcoming: PartnerJob[];
  completed: PartnerJob[];
  overdue: PartnerJob[];
  window: { upcoming_days: number; completed_days: number; today: string };
}

export interface PartnerProperty {
  id: number;
  address: string;
  postcode: string | null;
  price_pence: number;
  customer_name: string | null;
}

export interface WorkRequest {
  id: number;
  title: string;
  description: string | null;
  service_type: string;
  priority: string;
  status: string;
  scheduled_date: string | null;
  property_id: number | null;
  address?: string | null;
  postcode?: string | null;
  created_at: number;
}

export interface PartnerInvoice {
  id: number;
  number: string;
  amount_pence: number;
  vat_pence: number;
  status: string;
  method: string | null;
  issued_at: number;
  paid_at: number | null;
  scheduled_date: string | null;
  address: string;
  postcode: string | null;
}

export interface PartnerPayments {
  invoices: PartnerInvoice[];
  summary: {
    paid_pence: number;
    unpaid_pence: number;
    invoice_count: number;
    completed_jobs_30d: number;
    completed_value_30d_pence: number;
  };
}

// ── Route optimisation ──────────────────────────────────────────────────
// Served by /api/maxgleam/optimize-route, which accepts a partner token and
// scopes the result to this company's own properties.
export interface RouteStop {
  position: number;
  job_id: number;
  property_id: number;
  address: string;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
  estimated_time: string | null;
  estimated_depart: string | null;
  drive_km_from_previous: number | null;
  drive_minutes_from_previous: number | null;
  service_minutes: number;
  customer_name: string | null;
  crew_name: string | null;
  round_name: string | null;
  access_notes: string | null;
  status: string;
  price_pence: number;
  /** False when the property has no coordinates and cannot be ordered. */
  routable: boolean;
}

export interface OptimizedRoute {
  date: string;
  crew_id: number | null;
  crew_name: string | null;
  stops: RouteStop[];
  stop_count: number;
  routed_count: number;
  unroutable_count: number;
  total_distance_km: number;
  total_drive_time_min: number;
  total_service_time_min: number;
  total_day_minutes: number;
  finish_estimate: string | null;
  day_start: string;
  value_pence: number;
  assumptions: {
    algorithm: string; distance: string; speed: string;
    service_minutes: number; start: string;
  };
}

export interface Crew { id: number; name: string; phone: string | null }

// ── Referrals ───────────────────────────────────────────────────────────
export interface Referral {
  id: number;
  customer_id: number;
  referrer_name: string | null;
  referrer_email: string | null;
  referred_email: string;
  referred_name: string | null;
  status: 'pending' | 'signed_up' | 'rewarded';
  discount_pence: number;
  rewarded_invoice_id: number | null;
  rewarded_at: number | null;
  created_at: number;
}

export interface Referrer { id: number; name: string; email: string | null; phone: string | null }

export interface Referrals {
  referrals: Referral[];
  referrers: Referrer[];
  summary: {
    total: number; pending: number; signed_up: number; rewarded: number;
    earned_pence: number; awaiting_invoice_pence: number;
  };
  discount_pence: number;
}

export interface NewWorkRequest {
  title: string;
  description?: string;
  property_id?: number | null;
  service_type?: string;
  priority?: string;
}

// ── Calls ───────────────────────────────────────────────────────────────
export const partnerApi = {
  login: (code: string, password: string) =>
    req<{ token: string; partner: Partner }>('POST', '/api/partner/login', { code, password }),
  me: () => req<{ partner: Partner }>('GET', '/api/partner/me'),
  logout: () => req<{ ok: boolean }>('POST', '/api/partner/logout'),
  jobs: () => req<PartnerJobs>('GET', '/api/partner/jobs'),
  properties: () => req<{ properties: PartnerProperty[]; service_types: string[]; priorities: string[] }>(
    'GET', '/api/partner/properties'),
  workRequests: () => req<{ work_requests: WorkRequest[] }>('GET', '/api/partner/work-request'),
  submitWorkRequest: (data: NewWorkRequest) =>
    req<{ work_request: WorkRequest }>('POST', '/api/partner/work-request', data),
  payments: () => req<PartnerPayments>('GET', '/api/partner/payments'),

  // Digital sign-off — scoped server-side to this partner's own jobs.
  signoffStatus: () => req<SignoffStatus>('GET', '/api/maxgleam/signoff-status'),
  sendSignoffLink: (jobId: number) =>
    req<{ ok: boolean; status: string; to: string; url: string }>(
      'POST', `/api/maxgleam/signoff/${jobId}/send`),

  // Route optimisation — same scoping rule: the server only ever returns
  // stops on this partner's own properties.
  route: (date: string, crewId?: number | null) =>
    req<OptimizedRoute>('GET', `/api/maxgleam/optimize-route?date=${encodeURIComponent(date)}`
      + (crewId ? `&crew_id=${crewId}` : '')),
  crews: () => req<{ crews: Crew[] }>('GET', '/api/maxgleam/crews'),

  // Referrals — scoped to this partner's own customers, like everything else.
  referrals: () => req<Referrals>('GET', '/api/maxgleam/referrals'),
  createReferral: (data: { customer_id: number; referred_email: string; referred_name?: string }) =>
    req<{ referral: Referral }>('POST', '/api/maxgleam/referrals/create', data),
};

export interface SignoffJob {
  job_id: number;
  ref: string;
  address: string;
  postcode: string | null;
  scheduled_date: string;
  completed_at: number | null;
  signoff_status: string | null;
  signoff_at: number | null;
  signoff_note: string;
  rating: number | null;
  price_pence: number;
  crew_name: string | null;
  customer_name: string | null;
  signoff_url?: string;
}

export interface SignoffStatus {
  pending: SignoffJob[];
  overdue: SignoffJob[];
  signed: SignoffJob[];
  auto_approved: SignoffJob[];
  summary: {
    pending: number; overdue: number; signed: number; auto_approved: number;
    average_rating: number | null; rated: number; auto_approve_hours: number;
  };
}

// ── Formatting helpers ──────────────────────────────────────────────────
export const gbp = (pence: number) =>
  `£${((pence || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const prettyDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

export const titleCase = (s: string) =>
  (s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
