// Max Gleam reporting + time clock API.
//
// The reports page is an HQ surface and rides the HQ token. The time clock is
// a crew surface: subcontractors have no accounts, so it sends a shared crew
// code instead (X-Crew-Code). Either credential is accepted by the timeclock
// endpoints — an office user opening /timeclock just works.

import { getToken } from './api';

const CREW_KEY = 'maxgleam_crew_code';

export const getCrewCode = () => localStorage.getItem(CREW_KEY) || '';
export const setCrewCode = (c: string) => localStorage.setItem(CREW_KEY, c);
export const clearCrewCode = () => localStorage.removeItem(CREW_KEY);

export class ReportsApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const crew = getCrewCode();
  if (crew) headers['X-Crew-Code'] = crew;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ReportsApiError(res.status, data.error || res.statusText);
  return data as T;
}

// ── Types ───────────────────────────────────────────────────────────────
export interface RevenueDay { date: string; revenue_pence: number; jobs: number }

export interface CrewPerformance {
  crew_id: number;
  name: string;
  jobs_completed: number;
  revenue_pence: number;
  avg_rating: number | null;
  rated: number;
  signed_off: number;
  logged_jobs: number;
  avg_minutes: number | null;
}

export interface OverdueSignoff {
  job_id: number;
  address: string;
  scheduled_date: string;
  completed_at: number | null;
  crew_name: string | null;
  price_pence: number;
  days_overdue: number;
}

export interface ReportsData {
  generated_at: number;
  tenant_id: number;
  window_days: number;
  revenue: {
    series: RevenueDay[];
    total_pence: number;
    peak_pence: number;
    week_pence: number;
    month_pence: number;
  };
  jobs: {
    completed_window: number;
    completed_week: number;
    completed_month: number;
    week_start: string;
    month_start: string;
    avg_value_pence: number;
  };
  ratings: { average: number | null; rated: number };
  retention: {
    active_properties: number;
    cleaned_recently: number;
    lapsed: number;
    window_weeks: number;
    rate_pct: number;
  };
  crew: CrewPerformance[];
  top_crew: CrewPerformance | null;
  overdue_signoffs: {
    count: number;
    auto_approve_hours: number;
    jobs: OverdueSignoff[];
  };
  time: {
    logged_jobs: number;
    total_minutes: number;
    avg_minutes: number | null;
    estimated_minutes: number;
  };
}

export interface TimeLog {
  id: number;
  job_id: number | null;
  subcontractor_id: number | null;
  clock_in: number;
  clock_out: number | null;
  total_minutes: number | null;
  notes: string | null;
  crew_name: string | null;
  address: string | null;
  postcode: string | null;
  scheduled_date: string | null;
  price_pence: number | null;
  day: string;
  open: boolean;
  elapsed_minutes: number;
  estimated_minutes: number;
}

export interface TimeHistory {
  day: string;
  logs: TimeLog[];
  open_count: number;
  summary: {
    entries: number;
    completed: number;
    total_minutes: number;
    total_hours: number;
    avg_minutes: number | null;
    estimated_minutes: number;
  };
  by_crew: { crew_id: number; name: string; minutes: number; jobs: number; open: boolean }[];
}

export interface ClockJob {
  id: number;
  scheduled_date: string;
  status: string;
  price_pence: number;
  subcontractor_id: number | null;
  started_at: number | null;
  address: string;
  postcode: string | null;
  customer_name: string | null;
  crew_name: string | null;
  logged_minutes: number;
  estimated_minutes: number;
}

export interface OpenLog {
  id: number;
  job_id: number | null;
  subcontractor_id: number;
  clock_in: number;
  crew_name: string | null;
  elapsed_minutes: number;
}

export interface ClockCrew {
  id: number;
  name: string;
  company_name: string | null;
  open_log: OpenLog | null;
}

export interface ClockBoard {
  day: string;
  jobs: ClockJob[];
  crews: ClockCrew[];
  open_logs: OpenLog[];
  estimated_minutes: number;
}

export type ReportKind = 'revenue' | 'jobs' | 'crew' | 'retention' | 'overdue' | 'time';

// ── Staff activity ──────────────────────────────────────────────────────
export type ActorType = 'crew' | 'user' | 'partner' | 'customer' | 'system';

export interface ActivityEvent {
  id: number;
  tenant_id: number;
  actor_type: ActorType;
  actor_id: number | null;
  actor_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  detail: string | null;
  meta: Record<string, unknown>;
  created_at: number;
  day: string;
}

export interface ActivityFeed {
  activity: ActivityEvent[];
  count: number;
  limit: number;
  by_actor: { actor_type: ActorType; actor_id: number | null; name: string; events: number; last_at: number }[];
  by_action: { action: string; count: number }[];
  actions: string[];
}

// ── Alerts ──────────────────────────────────────────────────────────────
export type AlertKind =
  'overdue_signoffs' | 'overdue_properties' | 'unpaid_invoices' | 'open_clock' | 'daily_digest';

export interface AlertPreviewItem {
  kind: AlertKind;
  severity: 'info' | 'warn' | 'error';
  subject: string;
  body: string;
  count: number;
  would_send: boolean;
  on_cooldown: boolean;
  last_sent_at: number | null;
  recipients: string[];
  cooldown_hours: number;
}

export interface AlertPreview {
  alerts: AlertPreviewItem[];
  kinds: AlertKind[];
  mail_configured: boolean;
  mail_from: string;
  dry_run_default: boolean;
  checked_at: number;
}

export interface AlertLogRow {
  id: number;
  kind: AlertKind;
  severity: string;
  subject: string;
  recipients: string[];
  item_count: number;
  dry_run: boolean;
  status: string;
  error: string | null;
  sent_at: number;
}

export interface AlertRunResult {
  tenant_id: number;
  dry_run: boolean;
  evaluated: number;
  sent: number;
  skipped: number;
  failed: number;
  results: { kind: AlertKind; status: string; reason?: string; recipients?: string[]; error?: string | null }[];
  mail_configured: boolean;
  ran_at: number;
}

// ── Calls ───────────────────────────────────────────────────────────────
export const reportsApi = {
  reports: () => req<ReportsData>('GET', '/api/maxgleam/reports'),

  board: (day?: string) => req<ClockBoard>(
    'GET', `/api/maxgleam/timeclock/board${day ? `?day=${day}` : ''}`),

  history: (day?: string) => req<TimeHistory>(
    'GET', `/api/maxgleam/timeclock/history${day ? `?day=${day}` : ''}`),

  clockIn: (crewId: number, jobId?: number | null, notes?: string) =>
    req<{ log: TimeLog }>('POST', '/api/maxgleam/timeclock/start',
      { crew_id: crewId, job_id: jobId ?? null, notes: notes || '' }),

  clockOut: (crewId: number, notes?: string) =>
    req<{ log: TimeLog }>('POST', '/api/maxgleam/timeclock/stop',
      { crew_id: crewId, notes: notes || '' }),

  activity: (params: { day?: string; actor_type?: string; action?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, String(v)); });
    const qs = q.toString();
    return req<ActivityFeed>('GET', `/api/maxgleam/activity${qs ? `?${qs}` : ''}`);
  },

  alerts: () => req<AlertPreview>('GET', '/api/maxgleam/alerts'),

  alertHistory: (limit = 50) =>
    req<{ alerts: AlertLogRow[]; count: number }>(
      'GET', `/api/maxgleam/alerts/history?limit=${limit}`),

  // dry_run defaults to true server-side; pass false deliberately to send.
  runAlerts: (opts: { dry_run?: boolean; kinds?: AlertKind[]; force?: boolean } = {}) =>
    req<AlertRunResult>('POST', '/api/maxgleam/alerts/run', opts),
};

/**
 * Download a report as CSV. Goes through fetch rather than a plain link so the
 * Authorization header travels with it — an <a href> would arrive unauthenticated
 * and hand the user a JSON error page named .csv.
 */
export async function downloadCsv(report: ReportKind): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/maxgleam/reports/export?report=${report}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    let msg = res.statusText;
    try { msg = JSON.parse(text).error || msg; } catch { /* not JSON — keep statusText */ }
    throw new ReportsApiError(res.status, msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `maxgleam-${report}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


// ── Invoicing + tax ─────────────────────────────────────────────────────
export interface MgInvoiceRow {
  id: number;
  number: string;
  amount_pence: number;
  vat_pence: number;
  net_pence: number;
  status: string;
  /** 'overdue' is derived from an unpaid invoice's age, never stored. */
  display_status: string;
  is_overdue: boolean;
  days_outstanding: number | null;
  method: string | null;
  issued_at: number;
  paid_at: number | null;
  sumup_checkout_url: string | null;
  job_id: number | null;
  customer_id: number | null;
  customer_name: string | null;
  customer_email: string | null;
  scheduled_date: string | null;
  signoff_status: string | null;
  address: string | null;
  postcode: string | null;
}

export interface InvoiceList {
  invoices: MgInvoiceRow[];
  summary: {
    total: number; paid: number; unpaid: number; overdue: number;
    paid_pence: number; unpaid_pence: number; overdue_pence: number;
    overdue_days: number;
  };
  uninvoiced_jobs: number;
  filter: string;
  vat_registered: boolean;
  vat_rate: number;
}

export interface AutoGenerateResult {
  created: { invoice_id: number; number: string; job_id: number;
             amount_pence: number; address: string; customer_email: string }[];
  skipped: { job_id: number; address: string; reason: string }[];
  created_count: number;
  skipped_count: number;
  candidates: number;
  dry_run: boolean;
}

export interface TaxReport {
  from: string;
  to: string;
  vat_registered: boolean;
  vat_rate: number;
  totals: {
    revenue_gross_pence: number;
    revenue_net_pence: number;
    vat_pence: number;
    paid_pence: number;
    unpaid_pence: number;
    invoice_count: number;
    /** What VAT would be at 20% — only meaningful when not registered. */
    notional_vat_at_20_pence: number;
  };
  by_month: { month: string; gross_pence: number; vat_pence: number;
              net_pence: number; paid_pence: number; count: number }[];
  invoices: MgInvoiceRow[];
}

export const invoicesApi = {
  list: (status = '') => req<InvoiceList>(
    'GET', `/api/maxgleam/invoices${status ? `?status=${status}` : ''}`),

  autoGenerate: (send = true) => req<AutoGenerateResult>(
    'POST', '/api/maxgleam/invoices/auto-generate', { send }),

  send: (id: number) => req<{ ok: boolean; status: string; to: string; checkout_url: string }>(
    'POST', `/api/maxgleam/invoices/${id}/send`),

  tax: (from: string, to: string) => req<TaxReport>(
    'GET', `/api/maxgleam/reports/tax?from=${from}&to=${to}`),
};

/** Download the tax report CSV for a month range. */
export async function downloadTaxCsv(from: string, to: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/maxgleam/reports/tax.csv?from=${from}&to=${to}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    let msg = res.statusText;
    try { msg = JSON.parse(text).error || msg; } catch { /* not JSON — keep statusText */ }
    throw new ReportsApiError(res.status, msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `maxgleam-tax-${from}-to-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Helpers ─────────────────────────────────────────────────────────────
export const gbp = (pence: number) =>
  `£${((pence || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Compact money for chart axes and tiles: £1.2k, £340. */
export const gbpShort = (pence: number) => {
  const p = (pence || 0) / 100;
  if (Math.abs(p) >= 1000) return `£${(p / 1000).toFixed(1)}k`;
  return `£${Math.round(p)}`;
};

export const hoursMins = (minutes: number | null | undefined) => {
  if (minutes === null || minutes === undefined) return '—';
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
};

export const clockTime = (epoch: number | null) =>
  epoch ? new Date(epoch * 1000).toLocaleTimeString('en-GB',
    { hour: '2-digit', minute: '2-digit' }) : '—';

/** Download the staff activity feed as CSV, honouring the current filters. */
export async function downloadActivityCsv(
  params: { day?: string; actor_type?: string; action?: string } = {},
): Promise<void> {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v) q.set(k, String(v)); });
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/maxgleam/activity/export?${q.toString()}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    let msg = res.statusText;
    try { msg = JSON.parse(text).error || msg; } catch { /* not JSON — keep statusText */ }
    throw new ReportsApiError(res.status, msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `maxgleam-activity-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** "3m ago", "2h ago", "5d ago" — activity feeds read better relative. */
export const timeAgo = (epoch: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(epoch * 1000).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short' });
};

export const dayLabel = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};
