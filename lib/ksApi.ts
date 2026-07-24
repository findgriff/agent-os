// KS Sports Coaching API client — public booking site.
//
// Separate from lib/api.ts and lib/partnerApi.ts: KS parents and coaches are
// not AGENT OS users, their sessions live in the KS database, and the site is
// public. Parent and coach tokens are kept under different keys so a coach
// signing in on a shared laptop cannot clobber a parent session.

const PARENT_KEY = 'ks_parent_token';
const COACH_KEY = 'ks_coach_token';

export const getParentToken = () => localStorage.getItem(PARENT_KEY) || '';
export const setParentToken = (t: string) => localStorage.setItem(PARENT_KEY, t);
export const clearParentToken = () => localStorage.removeItem(PARENT_KEY);

export const getCoachToken = () => localStorage.getItem(COACH_KEY) || '';
export const setCoachToken = (t: string) => localStorage.setItem(COACH_KEY, t);
export const clearCoachToken = () => localStorage.removeItem(COACH_KEY);

export class KsApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new KsApiError(res.status, data.error || res.statusText);
  return data as T;
}

// ── Types ───────────────────────────────────────────────────────────────
export interface KsService {
  key: string;
  name: string;
  description: string;
  duration: string;
  price: string;
  audience: string;
  price_from_pence: number;
  bookable: boolean;
  minutes: number | null;
  full_day: boolean;
}

export interface KsCoach { name: string; bio: string; slug: string }
export interface KsFaq { question: string; answer: string }

export interface KsInfo {
  business: { name: string; tagline: string; area: string; phone: string; email: string; website: string };
  coaches: KsCoach[];
  services: KsService[];
  faq: KsFaq[];
  credentials: string[];
  experience_levels: string[];
}

export interface KsSlot {
  start_time: string;
  end_time: string;
  starts_at: number;
  coaches: { id: number; name: string }[];
}

export interface KsBooking {
  id: number;
  ref: string;
  service_key: string;
  service_name: string;
  date: string;
  start_time: string;
  end_time: string;
  starts_at: number;
  coach_id: number;
  coach_name: string | null;
  child_name: string;
  child_age: number | null;
  child_school: string | null;
  child_experience: string | null;
  parent_name: string;
  parent_email: string;
  parent_phone: string | null;
  notes: string | null;
  coach_notes: string | null;
  price_pence: number;
  status: string;
  created_at: number;
  is_upcoming: boolean;
  can_cancel: boolean;
}

export interface KsChild {
  id: number; name: string; age: number | null; school: string | null; experience: string | null;
}

export interface KsParent {
  id: number; name: string; email: string; phone: string | null;
  sms_opt_out: boolean; children: KsChild[];
}

export interface KsBlock {
  id: number; coach_id: number; date: string; start_time: string; end_time: string; reason: string | null;
}

export interface KsDay {
  date: string; is_today: boolean; sessions: KsBooking[]; blocks: KsBlock[];
}

export interface KsSchedule {
  coach: { id: number; slug: string; name: string };
  week_start: string; week_end: string; today: string;
  days: KsDay[];
  today_sessions: KsBooking[];
  totals: { sessions: number; completed: number; cancelled: number };
}

export type KsAttendanceStatus = 'attended' | 'absent' | 'cancelled';

export interface KsAttendance {
  id: number;
  booking_id: number;
  child_name: string;
  status: KsAttendanceStatus;
  notes: string | null;
  marked_by: string | null;
  created_at: number;
  chargeable: boolean;
  date: string | null;
  start_time: string | null;
  service_name: string | null;
  coach_name: string | null;
  ref: string | null;
  price_pence: number | null;
}

export interface KsAttendanceTotals {
  attended: number; absent: number; cancelled: number; sessions: number;
  /** Attended as a % of sessions the child was expected at. Null when none yet. */
  rate: number | null;
  charged_pence: number;
}

export interface KsChildAttendance extends KsAttendanceTotals {
  child_name: string;
  last_seen: string | null;
}

export interface KsSkill { key: string; label: string }

export interface KsProgressNote {
  id: number;
  booking_id: number;
  child_name: string;
  coach_name: string | null;
  skills: string[];
  skill_labels: string[];
  notes: string | null;
  rating: number | null;
  rating_label: string | null;
  created_at: number;
  date: string | null;
  start_time: string | null;
  service_name: string | null;
  ref: string | null;
}

export interface KsProgress {
  child_name: string;
  notes: KsProgressNote[];
  skills_worked_on: { key: string; label: string; sessions: number }[];
  summary: {
    sessions: number;
    average_rating: number | null;
    recent_ratings: number[];
    latest: string | null;
  };
}

export interface KsPlan {
  key: string;
  label: string;
  sessions: number | null;
  amount_pence: number;
  blurb: string;
}

export interface KsSubscription {
  id: number;
  parent_email: string;
  plan: string;
  plan_label: string;
  sessions_included: number | null;
  amount_pence: number;
  active: boolean;
  next_billing_date: string | null;
  created_at: number;
  cancelled_at: number | null;
  sessions_used_this_month?: number;
  allowance_remaining?: number | null;
}

export interface KsSubInvoice {
  id: number;
  subscription_id: number;
  period_start: string;
  period_end: string;
  amount_pence: number;
  status: 'pending' | 'paid' | 'failed';
  checkout_url: string | null;
  paid_at: number | null;
  created_at: number;
}

export interface NewBooking {
  service_key: string;
  date: string;
  start_time: string;
  coach_id?: number | null;
  child_name: string;
  child_age?: number | string | null;
  child_school?: string;
  child_experience?: string;
  parent_name: string;
  parent_email: string;
  parent_phone?: string;
  notes?: string;
}

// ── Calls ───────────────────────────────────────────────────────────────
export const ksApi = {
  info: () => req<KsInfo>('GET', '/api/ks/services'),

  slots: (service: string, date: string) =>
    req<{ date: string; slots: KsSlot[]; reason?: string }>(
      'GET', `/api/ks/slots?service=${encodeURIComponent(service)}&date=${date}`),

  book: (data: NewBooking) =>
    req<{ booking: KsBooking }>('POST', '/api/ks/book', data, getParentToken()),

  bookings: (email?: string) =>
    req<{ upcoming: KsBooking[]; history: KsBooking[]; cancel_cutoff_hours: number }>(
      'GET', '/api/ks/bookings' + (email ? `?email=${encodeURIComponent(email)}` : ''),
      undefined, getParentToken()),

  cancel: (ref: string, email?: string) =>
    req<{ booking: KsBooking }>('POST', '/api/ks/cancel-booking', { ref, email }, getParentToken()),

  register: (data: Record<string, unknown>) =>
    req<{ token: string; parent: KsParent }>('POST', '/api/ks/parent-register', data),

  login: (email: string, password: string) =>
    req<{ token: string; parent: KsParent }>('POST', '/api/ks/parent-login', { email, password }),

  parentMe: () => req<{ parent: KsParent }>('GET', '/api/ks/parent-me', undefined, getParentToken()),

  parentLogout: () => req<{ ok: boolean }>('POST', '/api/ks/logout', {}, getParentToken()),

  coachLogin: (username: string, password: string) =>
    req<{ token: string; coach: { id: number; slug: string; name: string } }>(
      'POST', '/api/ks/coach/login', { username, password }),

  coachMe: () => req<{ coach: { id: number; slug: string; name: string } }>(
    'GET', '/api/ks/coach/me', undefined, getCoachToken()),

  coachLogout: () => req<{ ok: boolean }>('POST', '/api/ks/logout', {}, getCoachToken()),

  schedule: (week?: string) =>
    req<KsSchedule>('GET', '/api/ks/coach/schedule' + (week ? `?week=${week}` : ''),
      undefined, getCoachToken()),

  complete: (ref: string, completed: boolean, coachNotes?: string) =>
    req<{ booking: KsBooking }>('POST', '/api/ks/coach/complete',
      { ref, completed, coach_notes: coachNotes }, getCoachToken()),

  availability: () =>
    req<{ availability: KsBlock[] }>('GET', '/api/ks/coach/availability', undefined, getCoachToken()),

  blockTime: (data: { date: string; start_time?: string; end_time?: string; reason?: string }) =>
    req<{ availability: KsBlock }>('POST', '/api/ks/coach/availability', data, getCoachToken()),

  unblock: (id: number) =>
    req<{ ok: boolean }>('POST', '/api/ks/coach/availability', { delete_id: id }, getCoachToken()),

  // ── Attendance (coach writes, parent reads) ──────────────────────────
  markAttendance: (data: {
    ref: string; status: KsAttendanceStatus; child_name?: string; notes?: string;
  }) => req<{ attendance: KsAttendance; sms: string | null; charged_pence: number }>(
    'POST', '/api/ks/attendance/mark', data, getCoachToken()),

  attendanceHistory: (child: string, asCoach = false) =>
    req<{ child_name: string; attendance: KsAttendance[]; totals: KsAttendanceTotals }>(
      'GET', `/api/ks/attendance/history?child=${encodeURIComponent(child)}`,
      undefined, asCoach ? getCoachToken() : getParentToken()),

  attendanceSummary: (asCoach = false) =>
    req<{ children: KsChildAttendance[] }>('GET', '/api/ks/attendance/summary',
      undefined, asCoach ? getCoachToken() : getParentToken()),

  unmarkedSessions: () =>
    req<{ sessions: KsBooking[] }>('GET', '/api/ks/attendance/unmarked',
      undefined, getCoachToken()),

  // ── Progress ─────────────────────────────────────────────────────────
  skills: () => req<{ skills: KsSkill[]; ratings: Record<string, string> }>(
    'GET', '/api/ks/progress/skills'),

  saveProgress: (data: {
    ref: string; child_name?: string; skills?: string[]; notes?: string; rating?: number | null;
  }) => req<{ note: KsProgressNote }>('POST', '/api/ks/progress/save', data, getCoachToken()),

  progressChildren: () =>
    req<{ children: string[] }>('GET', '/api/ks/progress/children', undefined, getParentToken()),

  progress: (child: string, asCoach = false) =>
    req<KsProgress>('GET', `/api/ks/progress/${encodeURIComponent(child)}`,
      undefined, asCoach ? getCoachToken() : getParentToken()),

  // ── Subscriptions ────────────────────────────────────────────────────
  plans: () => req<{ plans: KsPlan[] }>('GET', '/api/ks/subscriptions/plans'),

  subscription: () => req<{
    subscription: KsSubscription | null; invoices: KsSubInvoice[]; plans: KsPlan[];
  }>('GET', '/api/ks/subscriptions/status', undefined, getParentToken()),

  subscribe: (plan: string) =>
    req<{ subscription: KsSubscription; first_bill_on: string }>(
      'POST', '/api/ks/subscriptions/create', { plan }, getParentToken()),

  unsubscribe: () =>
    req<{ subscription: KsSubscription; note: string }>(
      'POST', '/api/ks/subscriptions/cancel', {}, getParentToken()),
};

// ── Helpers ─────────────────────────────────────────────────────────────
export const money = (pence: number) =>
  pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;

export const dayName = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
};

export const shortDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

/** Local YYYY-MM-DD, `offset` days from today. */
export const isoDate = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
