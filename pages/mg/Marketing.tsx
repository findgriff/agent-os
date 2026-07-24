// Max Gleam email marketing — campaign creator, audience picker, preview and
// send, plus the monthly newsletter and the recurring invoice auto-send.
//
// Every send path defaults to a dry run. Going live is a separate, deliberate
// confirm: this mails real customers, and an undo does not exist.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, EmptyState, Field, Icon, Input, Select, SkeletonList, Textarea, useToast,
} from '../../components/ui';
import {
  marketingApi, recurringApi, gbp, timeAgo,
  type AudienceKind, type AudienceSummary, type Campaign, type CampaignPreview,
  type CampaignList, type RecurringStatus,
} from '../../lib/reportsApi';

const ACCENT = '#19C3E6';

type Tab = 'campaigns' | 'compose' | 'newsletter' | 'invoicing';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'campaigns', label: 'Campaigns', icon: 'campaign' },
  { id: 'compose', label: 'Compose', icon: 'edit_note' },
  { id: 'newsletter', label: 'Newsletter', icon: 'newspaper' },
  { id: 'invoicing', label: 'Auto-invoicing', icon: 'receipt_long' },
];

const AUDIENCE_LABEL: Record<AudienceKind, string> = {
  all: 'Every customer',
  cleaned_since: 'Cleaned since a date',
  not_cleaned_since: 'Not cleaned since a date (win-back)',
  never_cleaned: 'Never cleaned yet',
  unpaid_invoices: 'Has unpaid invoices',
};

function StatTile({ label, value, sub, icon, accent = ACCENT, delay = 0 }: {
  label: string; value: string; sub?: string; icon: string; accent?: string; delay?: number;
}) {
  return (
    <Card className="group p-3.5 sm:p-4 animate-fadeInUp transition-all duration-200
        hover:-translate-y-0.5 hover:border-white/12"
      style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
          <div className="mt-1 truncate text-xl font-bold tabular-nums text-ink sm:text-2xl">{value}</div>
          {sub && <div className="mt-0.5 truncate text-[11px] text-muted/70">{sub}</div>}
        </div>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
          style={{ background: `${accent}1a`, color: accent }}>
          <Icon name={icon} size={19} />
        </span>
      </div>
    </Card>
  );
}

function SectionTitle({ children, count, accent = ACCENT, action }: {
  children: React.ReactNode; count?: number; accent?: string; action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="flex items-center gap-2 font-display text-sm font-semibold uppercase tracking-wider text-muted">
        <span className="h-3.5 w-[3px] rounded-full" style={{ background: accent }} />
        {children}
        {count !== undefined && (
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] tabular-nums text-muted">{count}</span>
        )}
      </h2>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

/** Live audience count for the current filter — the number that matters most. */
function AudienceMeter({ summary }: { summary: AudienceSummary | null }) {
  if (!summary) return null;
  const pct = summary.matched ? (summary.emailable / summary.matched) * 100 : 0;
  return (
    <div className="rounded-xl border border-white/6 bg-white/[0.02] p-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-2xl font-bold tabular-nums text-ink">
            {summary.emailable}
            <span className="text-sm font-medium text-muted"> of {summary.matched}</span>
          </div>
          <div className="text-[11px] text-muted">customers reachable by email</div>
        </div>
        {summary.missing_email > 0 && (
          <Badge tone="warn">{summary.missing_email} no email</Badge>
        )}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/6">
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${ACCENT}, #22C55E)` }} />
      </div>
    </div>
  );
}

// ── Compose ─────────────────────────────────────────────────────────────

function Compose({ meta, onCreated }: { meta: CampaignList | null; onCreated: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<AudienceKind>('all');
  const [since, setSince] = useState('');
  const [summary, setSummary] = useState<AudienceSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const needsDate = kind === 'cleaned_since' || kind === 'not_cleaned_since';

  useEffect(() => {
    let live = true;
    marketingApi.audience(kind, since ? { since } : {})
      .then(s => { if (live) setSummary(s); })
      .catch(() => { /* the meter is advisory — a failure must not block composing */ });
    return () => { live = false; };
  }, [kind, since]);

  const create = async () => {
    setBusy(true);
    try {
      await marketingApi.createCampaign({
        name, subject, body,
        audience: { kind, since: needsDate && since ? since : null },
      });
      toast('Campaign saved as a draft', 'ok');
      setName(''); setSubject(''); setBody('');
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save campaign', 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card className="space-y-4 p-4 sm:p-5">
        <Field label={<>Campaign name <span className="text-muted/50">(internal)</span></>}>
          <Input value={name} onChange={e => setName(e.target.value)}
            placeholder="Spring win-back" />
        </Field>
        <Field label="Subject line">
          <Input value={subject} onChange={e => setSubject(e.target.value)}
            placeholder="{first_name}, ready for your next clean?" />
        </Field>
        <Field label={<>Body <span className="text-muted/50">(plain text)</span></>}>
          <Textarea value={body} onChange={e => setBody(e.target.value)} rows={12}
            placeholder={'Hi {first_name},\n\nYour last clean was {last_clean}…'} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon="save" loading={busy}
            disabled={!name.trim() || !subject.trim() || !body.trim()}
            onClick={create}>Save draft</Button>
          <span className="text-[11px] text-muted">
            Drafts are previewed and sent from the Campaigns tab.
          </span>
        </div>
      </Card>

      <div className="space-y-4">
        <Card className="space-y-3 p-4">
          <SectionTitle>Audience</SectionTitle>
          <Select value={kind} onChange={e => setKind(e.target.value as AudienceKind)} className="w-full">
            {(meta?.audiences || Object.keys(AUDIENCE_LABEL) as AudienceKind[]).map(k => (
              <option key={k} value={k}>{AUDIENCE_LABEL[k] || k}</option>
            ))}
          </Select>
          {needsDate && (
            <Field label="Date" labelClassName="mb-1 block text-[11px] text-muted">
              <Input type="date" value={since} onChange={e => setSince(e.target.value)} />
            </Field>
          )}
          <AudienceMeter summary={summary} />
        </Card>

        <Card className="p-4">
          <SectionTitle accent="#A78BFA">Placeholders</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {(meta?.placeholders || []).map(p => (
              <button key={p} type="button"
                onClick={() => setBody(b => `${b}{${p}}`)}
                className="rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1
                  font-mono text-[11px] text-muted transition-colors hover:border-accent/30 hover:text-accent">
                {`{${p}}`}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted/70">
            Click to insert. Each recipient gets their own values at send time.
          </p>
        </Card>
      </div>
    </div>
  );
}

// ── Campaign row with preview + send ────────────────────────────────────

function CampaignCard({ campaign, onChanged }: { campaign: Campaign; onChanged: () => void }) {
  const toast = useToast();
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'dry' | 'live' | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);

  const loadPreview = async () => {
    if (preview) { setOpen(o => !o); return; }
    setBusy('preview');
    try {
      setPreview(await marketingApi.preview(campaign.id));
      setOpen(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not build preview', 'danger');
    } finally {
      setBusy(null);
    }
  };

  const send = async (live: boolean) => {
    setBusy(live ? 'live' : 'dry');
    try {
      const r = await marketingApi.send(campaign.id, !live);
      toast(live
        ? `Sent to ${r.sent} customer${r.sent === 1 ? '' : 's'}${r.failed ? `, ${r.failed} failed` : ''}`
        : `Dry run: would send ${r.sent}, ${r.skipped_no_email} have no email`,
        r.failed ? 'danger' : 'ok');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Send failed', 'danger');
    } finally {
      setBusy(null);
      setConfirmLive(false);
    }
  };

  const sent = campaign.status === 'sent';
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-3 p-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
          style={{ background: sent ? '#22C55E1a' : `${ACCENT}1a`, color: sent ? '#22C55E' : ACCENT }}>
          <Icon name={sent ? 'mark_email_read' : 'drafts'} size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">{campaign.name}</div>
          <div className="truncate text-[11px] text-muted">
            {campaign.subject} · {AUDIENCE_LABEL[campaign.audience.kind || 'all']}
            {campaign.sent_at && ` · sent ${timeAgo(campaign.sent_at)}`}
          </div>
        </div>
        {sent && (
          <div className="flex shrink-0 items-center gap-3 text-[11px] tabular-nums text-muted">
            <span title="delivered"><Icon name="send" size={13} /> {campaign.stats.sent}</span>
            <span title="opened" className="text-emerald">
              <Icon name="drafts" size={13} /> {campaign.stats.open_rate}%
            </span>
            <span title="clicked" className="text-accent">
              <Icon name="ads_click" size={13} /> {campaign.stats.click_rate}%
            </span>
          </div>
        )}
        <Badge tone={sent ? 'ok' : 'neutral'}>{campaign.status}</Badge>
        <Button variant="ghost" icon="visibility" loading={busy === 'preview'}
          className="!px-2.5 !py-1.5 !text-[12px] min-h-[38px]" onClick={loadPreview}>Preview</Button>
      </div>

      {open && preview && (
        <div className="border-t border-white/6 bg-black/20 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            <Badge tone="info">{preview.audience.matched} matched</Badge>
            <Badge tone={preview.audience.emailable ? 'ok' : 'danger'}>
              {preview.audience.emailable} emailable
            </Badge>
            {preview.audience.missing_email > 0 && (
              <Badge tone="warn">{preview.audience.missing_email} without an email</Badge>
            )}
            {preview.unknown_placeholders.length > 0 && (
              <Badge tone="danger">
                unknown: {preview.unknown_placeholders.join(', ')}
              </Badge>
            )}
          </div>
          {preview.samples.map(s => (
            <div key={s.customer_id} className="mb-3 rounded-xl border border-white/6 bg-white/[0.02] p-3">
              <div className="text-[11px] text-muted">
                To {s.name} &lt;{s.email || 'no email'}&gt;
              </div>
              <div className="mt-1 text-sm font-semibold text-ink">{s.subject}</div>
              <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted">
{s.body}
              </pre>
            </div>
          ))}
          {!sent && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" icon="science" loading={busy === 'dry'}
                onClick={() => send(false)}>Dry run</Button>
              {confirmLive ? (
                <>
                  <Button variant="ghost" onClick={() => setConfirmLive(false)}>Cancel</Button>
                  <Button variant="danger" icon="send" loading={busy === 'live'}
                    onClick={() => send(true)}>
                    Yes — email {preview.audience.emailable} customer
                    {preview.audience.emailable === 1 ? '' : 's'}
                  </Button>
                </>
              ) : (
                <Button variant="primary" icon="send"
                  disabled={!preview.mail_configured || !preview.audience.emailable}
                  onClick={() => setConfirmLive(true)}>Send live</Button>
              )}
              <span className="text-[11px] text-muted/70">
                A campaign can only be sent once.
              </span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Newsletter ──────────────────────────────────────────────────────────

function Newsletter({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState<'draft' | 'dry' | null>(null);
  const [result, setResult] = useState<{ month_label: string; created: boolean } | null>(null);

  const run = async (send: boolean) => {
    setBusy(send ? 'dry' : 'draft');
    try {
      const r = await marketingApi.newsletter({
        month: month || undefined, send, dry_run: true,
      });
      setResult(r);
      toast(send
        ? `Dry run for ${r.month_label}: ${r.send?.sent ?? 0} would send`
        : `Draft ready for ${r.month_label}`, 'ok');
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Newsletter failed', 'danger');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4 sm:p-5">
        <div>
          <h2 className="font-display text-base font-semibold text-ink">
            Monthly newsletter
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            Builds &ldquo;Your cleaning summary for [month]&rdquo; — one campaign, personalised
            per customer with their clean count, last and next visit, and balance.
            It is idempotent per month, so re-running never creates a second copy.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={<>Month <span className="text-muted/50">(blank = last month)</span></>}>
            <Input type="month" value={month} onChange={e => setMonth(e.target.value)} />
          </Field>
          <Button variant="secondary" icon="drafts" loading={busy === 'draft'}
            onClick={() => run(false)}>Create draft</Button>
          <Button variant="secondary" icon="science" loading={busy === 'dry'}
            onClick={() => run(true)}>Draft + dry run</Button>
        </div>
        {result && (
          <div className="rounded-xl border border-white/6 bg-white/[0.02] p-3 text-[12px] text-muted">
            {result.created ? 'Created' : 'Reused existing'} newsletter for{' '}
            <span className="font-semibold text-ink">{result.month_label}</span>.
            Send it from the Campaigns tab when you&rsquo;re happy with the preview.
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Recurring invoicing ─────────────────────────────────────────────────

function Invoicing() {
  const toast = useToast();
  const [status, setStatus] = useState<RecurringStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'dry' | 'live' | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus(await recurringApi.status());
      setError('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load invoicing status';
      setError(msg);
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const run = async (live: boolean) => {
    setBusy(live ? 'live' : 'dry');
    try {
      const r = await recurringApi.autoSend(!live);
      toast(live
        ? `${r.created_count} invoice${r.created_count === 1 ? '' : 's'} raised, ${r.emailed_count} emailed`
        : `Dry run: ${r.candidates} job${r.candidates === 1 ? '' : 's'} would be invoiced`,
        'ok');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Auto-send failed', 'danger');
    } finally {
      setBusy(null);
      setConfirmLive(false);
    }
  };

  if (loading) return <SkeletonList count={4} />;
  if (error && !status) return (
    <EmptyState icon="error" accent="#F43F5E" title="Couldn't load invoicing status"
      hint={error} action={<Button icon="refresh" onClick={load}>Try again</Button>} />
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Ready to invoice" value={String(status?.pending_count ?? 0)}
          sub={gbp(status?.pending_pence ?? 0)} icon="receipt_long"
          accent={status?.pending_count ? '#F59E0B' : '#22C55E'} delay={0} />
        <StatTile label="Awaiting sign-off" value={String(status?.awaiting_signoff_count ?? 0)}
          sub="completed, not yet accepted" icon="hourglass_top" accent="#A78BFA" delay={60} />
        <StatTile label="Next number" value={status?.next_number || '—'}
          sub={`prefix ${status?.number_prefix || 'INV'}`} icon="tag" accent={ACCENT} delay={120} />
        <StatTile label="Last run"
          value={status?.last_run_at ? timeAgo(status.last_run_at) : 'never'}
          sub={status?.last_run
            ? `${status.last_run.created_count} raised, ${status.last_run.emailed_count} emailed`
            : 'no run recorded'}
          icon="history" accent="#22C55E" delay={180} />
      </div>

      <Card className="flex flex-wrap items-center gap-3 p-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">Auto-send invoices</div>
          <div className="text-[12px] text-muted">
            Raises and emails an invoice for every job that is completed <em>and</em> signed off
            but not yet invoiced. A job that already has an invoice is never billed twice.
          </div>
        </div>
        <Button variant="secondary" icon="science" loading={busy === 'dry'}
          onClick={() => run(false)}>Dry run</Button>
        {confirmLive ? (
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setConfirmLive(false)}>Cancel</Button>
            <Button variant="danger" icon="send" loading={busy === 'live'}
              onClick={() => run(true)}>
              Yes, invoice {status?.pending_count ?? 0}
            </Button>
          </div>
        ) : (
          <Button variant="primary" icon="send" disabled={!status?.pending_count}
            onClick={() => setConfirmLive(true)}>Run live</Button>
        )}
      </Card>

      <div>
        <SectionTitle count={status?.pending_count} accent="#F59E0B">Queued for invoicing</SectionTitle>
        <Card className="p-2">
          {!status?.pending.length ? (
            <EmptyState icon="verified" accent="#22C55E" title="Nothing waiting"
              hint="Every signed-off job has already been invoiced." />
          ) : (
            <div className="space-y-2 p-1">
              {status.pending.map(j => (
                <div key={j.job_id}
                  className="flex items-center gap-3 rounded-xl border border-white/6 bg-white/[0.02] p-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink">{j.address}</div>
                    <div className="truncate text-[11px] text-muted">
                      {j.customer_email || 'no email on file'}
                    </div>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-ink">
                    {gbp(j.amount_pence)}
                  </span>
                  {!j.customer_email && <Badge tone="warn">no email</Badge>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div>
        <SectionTitle count={status?.recent_invoices.length} accent="#A78BFA">Recent invoices</SectionTitle>
        <Card className="p-2">
          {!status?.recent_invoices.length ? (
            <EmptyState icon="receipt" title="No invoices yet" />
          ) : (
            <div className="space-y-2 p-1">
              {status.recent_invoices.map(i => (
                <div key={i.id}
                  className="flex items-center gap-3 rounded-xl border border-white/6 bg-white/[0.02] p-2.5">
                  <span className="font-mono text-[12px] text-muted">{i.number}</span>
                  <div className="min-w-0 flex-1 text-[11px] text-muted">
                    issued {timeAgo(i.issued_at)}
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-ink">
                    {gbp(i.amount_pence)}
                  </span>
                  <Badge tone={i.status === 'paid' ? 'ok' : i.status === 'void' ? 'neutral' : 'warn'}>
                    {i.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────

export default function Marketing() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('campaigns');
  const [list, setList] = useState<CampaignList | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setList(await marketingApi.campaigns());
      setError('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load campaigns';
      setError(msg);
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const sentCount = useMemo(
    () => (list?.campaigns || []).filter(c => c.status === 'sent').length, [list]);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-accent/10 text-accent"
          style={{ boxShadow: `0 0 28px -8px ${ACCENT}88` }}>
          <Icon name="campaign" size={24} />
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold text-ink sm:text-2xl">Max Gleam marketing</h1>
          <p className="text-[12px] text-muted">
            {list ? `${list.count} campaign${list.count === 1 ? '' : 's'} · ${sentCount} sent` : 'Loading…'}
            {list && !list.mail_configured && ' · email not configured'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {list?.dry_run_default && (
            <Badge tone="warn" dot>dry-run default</Badge>
          )}
          <Button variant="secondary" icon="refresh" loading={refreshing}
            onClick={async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }}>
            Refresh
          </Button>
        </div>
      </header>

      <div className="flex gap-1 overflow-x-auto rounded-2xl border border-white/6 bg-white/[0.02] p-1">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition-all
              ${tab === t.id ? 'bg-accent/15 text-accent'
                             : 'text-muted hover:bg-white/5 hover:text-ink'}`}>
            <Icon name={t.icon} size={17} />{t.label}
          </button>
        ))}
      </div>

      {tab === 'compose' ? <Compose meta={list} onCreated={() => { load(); setTab('campaigns'); }} />
        : tab === 'newsletter' ? <Newsletter onChanged={load} />
        : tab === 'invoicing' ? <Invoicing />
        : loading ? <SkeletonList count={4} />
        : error && !list ? (
          <EmptyState icon="error" accent="#F43F5E" title="Couldn't load campaigns"
            hint={error} action={<Button icon="refresh" onClick={load}>Try again</Button>} />
        ) : !list?.campaigns.length ? (
          <EmptyState icon="campaign" title="No campaigns yet"
            hint="Write a subject line and a plain-text body, pick who gets it, preview, then send."
            action={<Button icon="edit_note" onClick={() => setTab('compose')}>Compose one</Button>} />
        ) : (
          <div className="space-y-2">
            {list.campaigns.map(c => (
              <CampaignCard key={c.id} campaign={c} onChanged={load} />
            ))}
          </div>
        )}
    </div>
  );
}
