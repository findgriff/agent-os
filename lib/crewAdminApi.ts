// Max Gleam crew management — the office roster. HQ surface on the HQ token.
// Mirrors server/maxgleam_crew_admin.py.
import { api } from './api';

export interface CrewRow {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  company_name: string | null;
  rate_per_clean_pence: number;
  active: boolean;
  notes: string | null;
  created_at: number;
  jobs_done: number;
  upcoming: number;
  total_paid_pence: number;
  last_paid_at: number | null;
  on_leave: boolean;
}

export interface CrewSummary {
  total: number;
  active: number;
  on_leave: number;
  upcoming_jobs: number;
  paid_total_pence: number;
}

export interface CrewListResp {
  crews: CrewRow[];
  summary: CrewSummary;
}

export interface CrewCore {
  id: number; name: string; phone: string | null; email: string | null;
  company_name: string | null; rate_per_clean_pence: number;
  active: boolean; notes: string | null; created_at: number;
}
export interface CrewJob {
  id: number; scheduled_date: string; status: string; price_pence: number; address: string;
}
export interface Leave {
  id: number; kind: string; date_from: string; date_to: string; notes: string | null;
}
export interface Payment {
  id: number; date_from: string; date_to: string; jobs_done: number;
  amount_pence: number; paid_at: number;
}
export interface CrewDetail {
  crew: CrewCore;
  jobs: CrewJob[];
  leave: Leave[];
  payroll: Payment[];
  stats: { jobs_done: number; upcoming: number; total_paid_pence: number; on_leave: boolean };
}

export interface NewCrew {
  name: string; phone?: string; email?: string; company_name?: string;
  rate_per_clean_pence?: number; notes?: string;
}
export type CrewPatch = Partial<NewCrew> & { active?: boolean };

export const crewAdminApi = {
  list: () => api.get<CrewListResp>('/api/maxgleam/crew-admin'),
  get: (id: number) => api.get<CrewDetail>(`/api/maxgleam/crew-admin/${id}`),
  create: (data: NewCrew) => api.post<CrewDetail>('/api/maxgleam/crew-admin/create', data),
  update: (id: number, patch: CrewPatch) =>
    api.post<CrewDetail>(`/api/maxgleam/crew-admin/${id}/update`, patch),
  addLeave: (id: number, data: { kind: string; date_from: string; date_to: string; notes?: string }) =>
    api.post<{ leave: Leave }>(`/api/maxgleam/crew-admin/${id}/availability`, data),
  deleteLeave: (leaveId: number) =>
    api.post<{ ok: boolean }>(`/api/maxgleam/crew-admin/availability/${leaveId}/delete`, {}),
  recordPay: (id: number, data: { date_from: string; date_to: string; jobs_done?: number; amount_pence: number }) =>
    api.post<{ payment: Payment }>(`/api/maxgleam/crew-admin/${id}/pay`, data),
};
