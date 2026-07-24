// Max Gleam GPS crew tracking — the office half of the API.
//
// Writes live in lib/crewApi.ts, because they carry the crew's own token and
// are only ever sent by a phone that is stood on a job. Everything here reads,
// and takes the HQ token like the rest of the command centre.

import { getToken } from './api';

export class GpsApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new GpsApiError(res.status, data.error || res.statusText);
  return data as T;
}

// ── Types ───────────────────────────────────────────────────────────────
export interface GpsPoint {
  lat: number;
  lng: number;
  timestamp: number;
  job_id: number | null;
}

/** The job a crew is stood on right now, if any. */
export interface GpsJob {
  job_id: number;
  scheduled_date: string;
  started_at: number | null;
  status: string;
  address: string;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface GpsCrew {
  crew_id: number;
  name: string;
  phone: string | null;
  company_name: string | null;
  position: GpsPoint;
  age_seconds: number;
  live: boolean;
  job: GpsJob | null;
}

/** Today's stops, drawn on the map whether or not anyone is tracking. */
export interface GpsStop {
  job_id: number;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  subcontractor_id: number | null;
  address: string;
  postcode: string | null;
  latitude: number;
  longitude: number;
  crew_name: string | null;
}

export interface GpsActive {
  date: string;
  crews: GpsCrew[];
  jobs: GpsStop[];
  summary: {
    tracking: number;
    seen_today: number;
    jobs_today: number;
    active_window_minutes: number;
  };
  now: number;
}

export interface GpsPosition {
  crew: { id: number; name: string; phone: string | null; company_name: string | null };
  position: GpsPoint | null;
  age_seconds: number | null;
  live: boolean;
  job: GpsJob | null;
}

export interface GpsHistory {
  crew: { id: number; name: string };
  date: string;
  points: GpsPoint[];
  summary: {
    count: number;
    distance_m: number;
    distance_miles: number;
    first_seen: number | null;
    last_seen: number | null;
    jobs: number[];
  };
}

// ── Calls ───────────────────────────────────────────────────────────────
export const gpsApi = {
  active: () => req<GpsActive>('/api/maxgleam/gps/active'),
  crew: (crewId: number) => req<GpsPosition>(`/api/maxgleam/gps/crew/${crewId}`),
  history: (crewId: number, date?: string) =>
    req<GpsHistory>(`/api/maxgleam/gps/history/${crewId}${date ? `?date=${date}` : ''}`),
};

// ── Helpers ─────────────────────────────────────────────────────────────
/** "just now" / "4m ago" — how stale a pin is, in the words a dispatcher uses. */
export function agoLabel(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return 'never';
  if (seconds < 45) return 'just now';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

export const clockTime = (epoch: number | null) =>
  epoch ? new Date(epoch * 1000).toLocaleTimeString('en-GB',
    { hour: '2-digit', minute: '2-digit' }) : '—';
