// Max Gleam quotes — the sales-funnel front end. HQ surface, rides the HQ
// token via the shared `api` helper. Mirrors the server contract in
// server/maxgleam_quotes.py.
import { api } from './api';

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'converted';

export interface Quote {
  id: number;
  customer_id: number | null;
  prospect_name: string;
  prospect_email: string | null;
  prospect_phone: string | null;
  address: string;
  postcode: string | null;
  first_clean_pence: number;
  recurring_pence: number;
  frequency_weeks: number;
  notes: string | null;
  status: QuoteStatus;
  created_at: number;
  sent_at: number | null;
  decided_at: number | null;
  converted_at: number | null;
  converted_property_id: number | null;
}

export interface QuoteSummary {
  total: number;
  draft: number; sent: number; accepted: number; declined: number; converted: number;
  open_first_clean_pence: number;
  open_annual_pence: number;
  won_annual_pence: number;
}

export interface QuoteList {
  quotes: Quote[];
  summary: QuoteSummary;
}

export interface NewQuote {
  prospect_name: string;
  prospect_email?: string;
  prospect_phone?: string;
  address: string;
  postcode?: string;
  first_clean_pence?: number;
  recurring_pence?: number;
  frequency_weeks?: number;
  notes?: string;
  customer_id?: number | null;
  send?: boolean;
}

export const quotesApi = {
  list: () => api.get<QuoteList>('/api/maxgleam/quotes'),
  create: (data: NewQuote) => api.post<{ quote: Quote }>('/api/maxgleam/quotes/create', data),
  update: (id: number, patch: Partial<NewQuote> & { status?: Exclude<QuoteStatus, 'converted'> }) =>
    api.post<{ quote: Quote }>(`/api/maxgleam/quotes/${id}/update`, patch),
  convert: (id: number, firstCleanDate?: string) =>
    api.post<{ quote: Quote; customer_id: number; property_id: number; first_job_id: number | null }>(
      `/api/maxgleam/quotes/${id}/convert`, { first_clean_date: firstCleanDate || '' }),
};
