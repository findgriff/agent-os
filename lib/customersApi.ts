// Max Gleam customers — office-side CRM. HQ surface on the HQ token via the
// shared `api` helper. Mirrors server/maxgleam_customers.py.
import { api } from './api';

export interface CustomerRow {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  tags: string[];
  archived: boolean;
  created_at: number;
  property_count: number;
  active_properties: number;
  outstanding_pence: number;
  ltv_pence: number;
  jobs_done: number;
  next_job: string | null;
  last_clean: string | null;
}

export interface CustomerSummary {
  total: number;
  with_balance: number;
  outstanding_pence: number;
  ltv_pence: number;
}

export interface CustomerListResp {
  customers: CustomerRow[];
  summary: CustomerSummary;
}

export interface Property {
  id: number; address: string; postcode: string | null;
  price_pence: number; frequency_weeks: number; active: number;
  round_name: string | null;
}
export interface CustomerJob {
  id: number; scheduled_date: string; status: string;
  price_pence: number; rating: number | null; completed_at: number | null; address: string;
}
export interface CustomerInvoice {
  id: number; number: string; amount_pence: number; status: string;
  method: string | null; issued_at: number; paid_at: number | null;
}
export interface CommEntry {
  id: number; kind: string; content: string; created_at: number;
}
export interface CustomerStats {
  ltv_pence: number; outstanding_pence: number; jobs_done: number;
  avg_rating: number | null; active_properties: number; recurring_pence: number;
  next_job: string | null; last_clean: string | null;
}
export interface CustomerCore {
  id: number; name: string; email: string | null; phone: string | null;
  notes: string | null; tags: string[]; archived: boolean; created_at: number;
}
export interface CustomerDetail {
  customer: CustomerCore;
  properties: Property[];
  jobs: CustomerJob[];
  invoices: CustomerInvoice[];
  comms: CommEntry[];
  stats: CustomerStats;
}

export interface CustomerPatch {
  name?: string; email?: string; phone?: string; notes?: string;
  tags?: string[]; archived?: boolean;
}

export const customersApi = {
  list: (q = '') =>
    api.get<CustomerListResp>('/api/maxgleam/customers' + (q ? `?q=${encodeURIComponent(q)}` : '')),
  get: (id: number) => api.get<CustomerDetail>(`/api/maxgleam/customers/${id}`),
  update: (id: number, patch: CustomerPatch) =>
    api.post<{ customer: CustomerCore }>(`/api/maxgleam/customers/${id}/update`, patch),
  addNote: (id: number, content: string) =>
    api.post<{ note: CommEntry }>(`/api/maxgleam/customers/${id}/note`, { content }),
};
