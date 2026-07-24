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

export interface DateRange { from: string; to: string }

export interface ReportsData {
  generated_at: number;
  tenant_id: number;
  window_days: number;
  range: {
    start: string;
    end: string;
    days: number;
    // true when the caller passed no explicit range (the default window).
    is_default: boolean;
  };
  previous: {
    start: string;
    end: string;
    revenue_pence: number;
    jobs: number;
    avg_value_pence: number;
    avg_rating: number | null;
  };
  // Percentage change vs the equal-length prior window; null when the prior
  // window had nothing to compare against. rating_delta is a raw point change.
  deltas: {
    revenue_pct: number | null;
    jobs_pct: number | null;
    avg_value_pct: number | null;
    rating_delta: number | null;
  };
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

// ── Email marketing ─────────────────────────────────────────────────────
export type AudienceKind =
  'all' | 'cleaned_since' | 'not_cleaned_since' | 'unpaid_invoices' | 'never_cleaned';

export interface AudienceSummary {
  kind: AudienceKind;
  since: string | null;
  days: number | null;
  matched: number;
  emailable: number;
  missing_email: number;
  sample: { id: number; name: string; email: string | null; last_clean: string | null; emailable: boolean }[];
}

export interface CampaignStats {
  recipients: number; sent: number; opened: number; clicked: number;
  failed: number; open_rate: number; click_rate: number;
}

export interface Campaign {
  id: number;
  name: string;
  subject: string;
  body: string;
  status: 'draft' | 'sent';
  sent_at: number | null;
  created_at: number;
  dry_run: boolean;
  audience: { kind?: AudienceKind; since?: string | null; days?: number | null };
  stats: CampaignStats;
}

export interface CampaignList {
  campaigns: Campaign[];
  count: number;
  dry_run_default: boolean;
  mail_configured: boolean;
  mail_from: string;
  audiences: AudienceKind[];
  placeholders: string[];
}

export interface CampaignPreview {
  campaign: Campaign;
  audience: { kind: AudienceKind; matched: number; emailable: number; missing_email: number };
  samples: { customer_id: number; name: string; email: string | null; subject: string; body: string }[];
  unknown_placeholders: string[];
  mail_configured: boolean;
  dry_run_default: boolean;
}

export interface CampaignSendResult {
  campaign_id: number;
  dry_run: boolean;
  audience_matched: number;
  targeted: number;
  sent: number;
  failed: number;
  skipped_no_email: number;
  results: { customer_id: number; name: string; email: string; error: string | null }[];
}

// ── Reviews ─────────────────────────────────────────────────────────────
export interface Review {
  job_id: number;
  rating: number | null;
  comment: string;
  customer_name: string | null;
  address: string;
  postcode: string | null;
  crew_name: string | null;
  crew_id: number | null;
  signoff_status: string | null;
  signed_at: number | null;
  scheduled_date: string;
  price_pence: number;
  is_testimonial: boolean;
}

export interface ReviewList {
  reviews: Review[];
  count: number;
  average: number | null;
  rated: number;
  distribution: Record<string, number>;
  testimonials: Review[];
  testimonial_min: number;
}

export interface ReviewAverage {
  average: number | null;
  rated: number;
  completed_jobs: number;
  response_rate_pct: number;
  distribution: Record<string, number>;
  by_crew: { crew_id: number; name: string; rated: number; average: number }[];
  window_days: number | null;
}

// ── Recurring invoicing ─────────────────────────────────────────────────
export interface RecurringStatus {
  last_run: {
    id: number; created_count: number; emailed_count: number;
    skipped_count: number; candidates: number; dry_run: boolean; ran_at: number;
  } | null;
  last_run_at: number | null;
  pending_count: number;
  pending_pence: number;
  pending: { job_id: number; address: string; amount_pence: number; customer_email: string | null; completed_at: number | null }[];
  awaiting_signoff_count: number;
  recent_invoices: { id: number; number: string; amount_pence: number; status: string; issued_at: number; job_id: number | null }[];
  number_prefix: string;
  next_number: string;
  dry_run: boolean;
  mail_configured: boolean;
}

export interface AutoSendResult {
  created: { invoice_id: number; number: string; job_id: number; amount_pence: number; address: string; customer_email: string | null; emailed: boolean }[];
  skipped: { job_id: number; address: string; reason: string }[];
  created_count: number;
  emailed_count: number;
  skipped_count: number;
  candidates: number;
  require_signoff: boolean;
  dry_run: boolean;
  ran_at: number;
}

// ── Calls ───────────────────────────────────────────────────────────────
export const reportsApi = {
  reports: (range?: DateRange) => {
    const qs = range ? `?from=${range.from}&to=${range.to}` : '';
    return req<ReportsData>('GET', `/api/maxgleam/reports${qs}`);
  },

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
export async function downloadCsv(report: ReportKind, range?: DateRange): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const q = range ? `&from=${range.from}&to=${range.to}` : '';
  const res = await fetch(`/api/maxgleam/reports/export?report=${report}${q}`, { headers });
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

/**
 * Download a single invoice as a PDF. Fetch-not-<a href>, same reasoning as
 * downloadCsv: the Authorization header has to travel with the request, and a
 * bare link would arrive unauthenticated and save the JSON error as a .pdf.
 */
export async function downloadInvoicePdf(id: number, number: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api/maxgleam/invoices/${id}/pdf`, { headers });
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
  a.download = `${number || 'invoice'}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

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

// ── Accounting exports ──────────────────────────────────────────────────
export interface TaxSummary {
  from: string;
  to: string;
  generated_at: number;
  overdue_days: number;
  vat_registered: boolean;
  vat_rate: number;
  totals: {
    revenue_gross_pence: number;
    revenue_net_pence: number;
    vat_collected_pence: number;
    paid_pence: number;
    unpaid_pence: number;
    overdue_pence: number;
    invoice_count: number;
    paid_count: number;
    unpaid_count: number;
    overdue_count: number;
    /** What VAT would be at 20% — only meaningful when not registered. */
    notional_vat_at_20_pence: number;
  };
  by_month: { month: string; invoices: number; gross_pence: number;
              net_pence: number; vat_pence: number; paid_pence: number }[];
  by_method: { method: string; label: string; count: number; amount_pence: number }[];
}

export type ExportKind = 'invoices' | 'payments';

export const exportsApi = {
  taxSummary: (from = '', to = '') => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return req<TaxSummary>('GET', `/api/maxgleam/exports/tax-summary${qs ? `?${qs}` : ''}`);
  },
};

/**
 * Download an accounting export. Same fetch-not-<a href> reasoning as
 * downloadCsv: the Authorization header has to travel with the request.
 */
export async function downloadExport(
  kind: ExportKind, from = '', to = '', isoDates = false,
): Promise<void> {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (isoDates) q.set('dates', 'iso');
  const qs = q.toString();
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `/api/maxgleam/exports/${kind}-csv${qs ? `?${qs}` : ''}`, { headers });
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
  const range = from || to ? `-${from || 'start'}-to-${to || 'today'}` : '';
  a.download = `maxgleam-${kind}${range}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Commissions ─────────────────────────────────────────────────────────
export interface CommissionRow {
  id: number;
  job_id: number;
  subcontractor_id: number;
  amount_pence: number;
  status: 'pending' | 'paid';
  paid_at: number | null;
  notes: string | null;
  created_at: number;
  crew_name: string;
  crew_company: string | null;
  rate_per_clean: number;
  scheduled_date: string | null;
  job_price_pence: number | null;
  signoff_at: number | null;
  address: string | null;
  postcode: string | null;
  customer_name: string | null;
  /** Job price less the commission. Negative is a real, deliberate answer. */
  margin_pence: number;
  margin_pct: number | null;
}

export interface CommissionCrew {
  crew_id: number;
  name: string;
  company_name: string | null;
  rate_per_clean: number;
  jobs: number;
  pending_pence: number;
  paid_pence: number;
  total_pence: number;
}

export interface CommissionList {
  commissions: CommissionRow[];
  summary: {
    count: number; pending_count: number; paid_count: number;
    pending_pence: number; paid_pence: number; total_pence: number;
    job_value_pence: number;
  };
  by_crew: CommissionCrew[];
  crews: { id: number; name: string; company_name: string | null; rate_per_clean: number }[];
  filter: { crew_id: number | null; status: string; from: string; to: string };
  /** auto | percent | flat — how rate_per_clean is being interpreted. */
  basis_mode: string;
}

export interface CommissionSummary {
  generated_at: number;
  month_start: string;
  pending_count: number;
  pending_pence: number;
  paid_this_month_count: number;
  paid_this_month_pence: number;
  paid_all_time_pence: number;
  oldest_pending_at: number | null;
  oldest_pending_days: number | null;
  pending_by_crew: { crew_id: number; name: string; jobs: number; pending_pence: number }[];
  basis_mode: string;
}

export const commissionsApi = {
  list: (params: { crew_id?: number | null; status?: string;
                   from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
    });
    const qs = q.toString();
    return req<CommissionList>('GET', `/api/maxgleam/commissions${qs ? `?${qs}` : ''}`);
  },

  summary: () => req<CommissionSummary>('GET', '/api/maxgleam/commissions/summary'),

  pay: (id: number, notes = '') =>
    req<{ commission: CommissionRow; status: string }>(
      'POST', `/api/maxgleam/commissions/${id}/pay`, { notes }),

  accrue: () => req<{ created_count: number; skipped_count: number }>(
    'POST', '/api/maxgleam/commissions/accrue', {}),
};

// ── Late payment reminders ──────────────────────────────────────────────
export interface OverdueInvoice extends MgInvoiceRow {
  days_overdue: number;
  reminders_sent: number[];
  stage_due: number | null;
  reminder_due: boolean;
  customer_phone: string;
  can_text: boolean;
}

export interface OverdueList {
  invoices: OverdueInvoice[];
  summary: {
    count: number; total_pence: number; due_now: number; due_now_pence: number;
    at_30: number; at_60: number; no_phone: number;
  };
  stages: number[];
  overdue_days: number;
  dry_run: boolean;
  dry_run_note: string;
  checked_at: number;
}

export interface ReminderRun {
  processed: number;
  by_status: Record<string, number>;
  sent: number;
  failed: number;
  results: { invoice_id: number; number: string; customer_name?: string;
             stage: number; status: string; to?: string; body?: string;
             error?: string | null }[];
  candidates: number;
  dry_run: boolean;
  ran_at: number;
}

export const remindersApi = {
  overdue: () => req<OverdueList>('GET', '/api/maxgleam/invoices/overdue'),

  send: (invoiceId?: number) => req<ReminderRun>(
    'POST', '/api/maxgleam/invoices/send-reminders',
    invoiceId ? { invoice_id: invoiceId } : {}),
};

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

// ── Marketing / reviews / recurring invoicing ───────────────────────────
export const marketingApi = {
  audience: (kind: AudienceKind = 'all', opts: { since?: string; days?: number } = {}) => {
    const q = new URLSearchParams({ kind });
    if (opts.since) q.set('since', opts.since);
    if (opts.days) q.set('days', String(opts.days));
    return req<AudienceSummary>('GET', `/api/maxgleam/email/audience?${q}`);
  },

  campaigns: () => req<CampaignList>('GET', '/api/maxgleam/email/campaigns'),

  createCampaign: (data: {
    name: string; subject: string; body: string;
    audience: { kind: AudienceKind; since?: string | null; days?: number | null };
  }) => req<{ campaign: Campaign }>('POST', '/api/maxgleam/email/campaigns', data),

  preview: (id: number) =>
    req<CampaignPreview>('GET', `/api/maxgleam/email/campaigns/${id}/preview`),

  // dry_run defaults to true server-side; pass false deliberately to send.
  send: (id: number, dryRun: boolean) =>
    req<CampaignSendResult>('POST', `/api/maxgleam/email/campaigns/${id}/send`,
      { dry_run: dryRun }),

  newsletter: (opts: { month?: string; dry_run?: boolean; send?: boolean } = {}) =>
    req<{ month_label: string; created: boolean; campaign: Campaign; send?: CampaignSendResult }>(
      'POST', '/api/maxgleam/email/newsletter', opts),
};

export const reviewsApi = {
  list: (opts: { min_rating?: number; crew_id?: number; with_comment?: boolean; limit?: number } = {}) => {
    const q = new URLSearchParams();
    Object.entries(opts).forEach(([k, v]) => { if (v) q.set(k, String(v)); });
    const qs = q.toString();
    return req<ReviewList>('GET', `/api/maxgleam/reviews${qs ? `?${qs}` : ''}`);
  },
  average: (days?: number) =>
    req<ReviewAverage>('GET', `/api/maxgleam/reviews/average${days ? `?days=${days}` : ''}`),
};

export const recurringApi = {
  status: () => req<RecurringStatus>('GET', '/api/maxgleam/invoices/recurring-status'),
  autoSend: (dryRun: boolean) =>
    req<AutoSendResult>('POST', '/api/maxgleam/invoices/auto-send', { dry_run: dryRun }),
};
