// Max Gleam self-serve booking — the API behind the public /book page.
//
// Separate from lib/api.ts (HQ), lib/partnerApi.ts, lib/crewApi.ts and
// lib/mgApi.ts: a person booking a clean has no account and no token at all,
// so nothing here sends an Authorization header. The two office calls at the
// bottom do, and take the HQ token.

import { getToken } from './api';

export class BookApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown,
                      auth = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new BookApiError(res.status, data.error || res.statusText);
  return data as T;
}

// ── Types ───────────────────────────────────────────────────────────────
export type ServiceKey = 'standard_clean' | 'deep_clean' | 'window_clean';

export interface BookService {
  key: ServiceKey;
  label: string;
  blurb: string;
}

export interface BookProperty {
  property_id: number;
  address: string;
  postcode: string | null;
  prices: Record<ServiceKey, number>;
}

export interface BookSlot {
  date: string;
  weekday: string;
  label: string;
  available: boolean;
  remaining: number;
  reason: string | null;
}

export interface BookLookup {
  found: boolean;
  postcode: string;
  matched_on?: 'postcode' | 'district';
  properties: BookProperty[];
  slots: BookSlot[];
  services: BookService[];
  message?: string;
}

export interface BookResult {
  ok: boolean;
  job_id: number;
  ref: string;
  status: string;
  date: string;
  service: ServiceKey;
  service_label: string;
  address: string;
  postcode: string | null;
  price_pence: number;
  work_request_id: number | null;
  sms_status: string;
  confirmation: string;
}

export interface BookingDetails {
  property_id: number;
  service: ServiceKey;
  date: string;
  name: string;
  email: string;
  phone: string;
  notes?: string;
}

/** A booking the office has not yet confirmed. */
export interface PendingBooking {
  job_id: number;
  ref: string;
  scheduled_date: string;
  price_pence: number;
  notes: string | null;
  created_at: number;
  address: string;
  postcode: string | null;
  service: ServiceKey | null;
  service_label: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  booking_notes: string | null;
}

// ── Calls ───────────────────────────────────────────────────────────────
export const bookApi = {
  // Public — no token.
  lookup: (postcode: string) =>
    req<BookLookup>('GET',
      `/api/maxgleam/book/available-slots?postcode=${encodeURIComponent(postcode)}`),

  book: (details: BookingDetails) =>
    req<BookResult>('POST', '/api/maxgleam/book', details),

  // Office — HQ token.
  requests: () =>
    req<{ requests: PendingBooking[]; count: number }>(
      'GET', '/api/maxgleam/book/requests', undefined, true),

  confirm: (jobId: number, subcontractorId?: number) =>
    req<{ ok: boolean; job_id: number; status: string }>(
      'POST', '/api/maxgleam/book/confirm',
      { job_id: jobId, subcontractor_id: subcontractorId }, true),

  decline: (jobId: number, reason?: string) =>
    req<{ ok: boolean; job_id: number; status: string }>(
      'POST', '/api/maxgleam/book/decline', { job_id: jobId, reason }, true),
};
