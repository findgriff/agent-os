// Max Gleam customer-facing API — digital sign-off + customer portal.
//
// Separate from lib/api.ts (HQ) and lib/partnerApi.ts (partner companies):
// customers hold a signed capability token, not an account password, and the
// sign-off page is opened straight from an SMS with no login at all.

const CUSTOMER_KEY = 'maxgleam_customer_token';

export const getCustomerToken = () => localStorage.getItem(CUSTOMER_KEY) || '';
export const setCustomerToken = (t: string) => localStorage.setItem(CUSTOMER_KEY, t);
export const clearCustomerToken = () => localStorage.removeItem(CUSTOMER_KEY);

export class MgApiError extends Error {
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
  if (!res.ok) throw new MgApiError(res.status, data.error || res.statusText);
  return data as T;
}

// ── Types ───────────────────────────────────────────────────────────────
export interface MgPhoto { id: number; kind: string; caption: string | null }

export interface MgJob {
  job_id: number;
  ref: string;
  address: string;
  postcode: string | null;
  scheduled_date: string;
  completed_at: number | null;
  status: string;
  signoff_status: string | null;
  signoff_at: number | null;
  signoff_note: string;
  rating: number | null;
  price_pence: number;
  crew_name: string | null;
  customer_name: string | null;
  company_name: string;
  company_phone?: string | null;
  company_email?: string | null;
  photos: MgPhoto[];
  can_sign_off?: boolean;
  signoff_url?: string;
}

export interface MgSignoffView {
  job: MgJob;
  already_signed: boolean;
  auto_approve_hours: number;
}

export interface MgInvoice {
  id: number;
  number: string;
  amount_pence: number;
  vat_pence: number;
  status: string;
  method: string | null;
  issued_at: number;
  paid_at: number | null;
  sumup_checkout_url: string | null;
  scheduled_date: string | null;
  address: string | null;
  // Balance-aware view from the customer portal (part-payments included).
  paid_pence?: number;
  outstanding_pence?: number;
}

/** A booked clean that has not been invoiced yet. */
export interface MgUpcomingClean {
  job_id: number;
  scheduled_date: string;
  price_pence: number;
  address: string;
  postcode: string | null;
}

export interface MgPayments {
  invoices: MgInvoice[];          // everything, newest first (legacy shape)
  due: MgInvoice[];               // unpaid — what the Pay Now button acts on
  history: MgInvoice[];           // settled
  upcoming: MgUpcomingClean[];
  summary: {
    paid_pence: number; unpaid_pence: number; upcoming_pence: number;
    count: number; newly_paid: string[];
  };
  can_pay_online: boolean;
  currency: string;
}

export interface MgCustomer { id?: number; name: string; email: string | null; phone: string | null }

export interface MgCompany {
  name: string; contact_name: string | null;
  contact_email: string | null; contact_phone: string | null;
}

export interface MgSignoffStatus {
  pending: MgJob[];
  overdue: MgJob[];
  signed: MgJob[];
  auto_approved: MgJob[];
  summary: {
    pending: number; overdue: number; signed: number; auto_approved: number;
    average_rating: number | null; rated: number; auto_approve_hours: number;
  };
}

// ── Calls ───────────────────────────────────────────────────────────────
export const mgApi = {
  // Sign-off (token from the SMS link — no session)
  signoff: (jobId: number, token: string) =>
    req<MgSignoffView>('GET', `/api/maxgleam/signoff/${jobId}?t=${encodeURIComponent(token)}`),

  submitSignoff: (jobId: number, token: string, data: {
    rating?: number | null; note?: string; photo_data_url?: string | null;
  }) => req<{ job: MgJob; photo_error: string | null }>(
    'POST', `/api/maxgleam/signoff/${jobId}`, { ...data, token }),

  // Customer portal
  login: (identifier: string, ref: string) =>
    req<{ token: string; customer: MgCustomer }>(
      'POST', '/api/maxgleam/customer/login', { identifier, ref }),

  jobs: () => req<{ upcoming: MgJob[]; past: MgJob[]; customer: MgCustomer }>(
    'GET', '/api/maxgleam/customer/jobs', undefined, getCustomerToken()),

  payments: () => req<MgPayments>(
    'GET', '/api/maxgleam/customer/payments', undefined, getCustomerToken()),

  // Starts a SumUp hosted checkout and returns the link to send the browser
  // to. Card details are only ever entered on SumUp's own page.
  pay: (invoiceId: number) => req<{
    checkout_url: string;
    invoice: { id: number; number: string; amount_pence: number };
  }>('POST', '/api/maxgleam/customer/pay', { invoice_id: invoiceId }, getCustomerToken()),

  contact: () => req<{ company: MgCompany | null }>(
    'GET', '/api/maxgleam/customer/contact', undefined, getCustomerToken()),

  // The invoice as a PDF (unpaid → to pay against, paid → a receipt). Fetched
  // as a blob with the token in the header — a plain link couldn't carry it,
  // and putting the capability token in the URL would leak it to logs.
  invoicePdf: async (invoiceId: number): Promise<Blob> => {
    const res = await fetch(`/api/maxgleam/customer/invoices/${invoiceId}/pdf`, {
      headers: { Authorization: `Bearer ${getCustomerToken()}` },
    });
    if (!res.ok) {
      let message = res.statusText;
      try { message = (await res.json()).error || message; } catch { /* non-JSON body */ }
      throw new MgApiError(res.status, message);
    }
    return res.blob();
  },
};

export const photoUrl = (id: number) => `/api/maxgleam/photo/${id}`;

// ── Helpers ─────────────────────────────────────────────────────────────
export const gbp = (pence: number) =>
  `£${((pence || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const niceDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};

export const niceStamp = (epoch: number | null) =>
  epoch ? new Date(epoch * 1000).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : '—';

/**
 * Downscale + JPEG-compress a camera photo in the browser.
 * Phone cameras produce 3–8MB files; the API caps uploads at 5MB.
 */
export function compressImage(file: File, maxEdge = 1600, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Could not process that image')); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
