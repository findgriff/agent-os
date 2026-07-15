// Leads — a sales cockpit. Generate + enrich prospects, work them through a
// coloured status pipeline in a data table, and track outreach campaigns with
// funnel charts + an email preview. Talks to /api/leads + /api/campaigns.
import { useState, useEffect, useMemo, type ReactNode } from 'react';
import {
  Icon, Button, Card, Badge, Textarea, Input, Select,
  Modal, Drawer, EmptyState, SkeletonList, useToast, Stat, useCountUp,
} from '../components/ui';
import { Sparkline } from '../components/Sparkline';
import { Avatar } from '../components/Avatar';
import { api, timeAgo } from '../lib/api';
import { useApp } from '../lib/store';
import type { Lead, LeadStatus, Campaign } from '../lib/types';

// ── Static config ───────────────────────────────────────────────────────────
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'violet';

const STATUSES: LeadStatus[] = ['new', 'contacted', 'qualified', 'converted', 'lost'];

const STATUS_META: Record<LeadStatus, { tone: Tone; label: string; icon: string; colour: string }> = {
  new:       { tone: 'info',   label: 'New',       icon: 'fiber_new',         colour: '#38BDF8' },
  contacted: { tone: 'warn',   label: 'Contacted', icon: 'forward_to_inbox',  colour: '#F59E0B' },
  qualified: { tone: 'violet', label: 'Qualified', icon: 'workspace_premium', colour: '#A78BFA' },
  converted: { tone: 'ok',     label: 'Converted', icon: 'verified',          colour: '#22C55E' },
  lost:      { tone: 'danger', label: 'Lost',      icon: 'do_not_disturb_on', colour: '#F43F5E' },
};

const CAMPAIGN_TONE: Record<string, Tone> = {
  active: 'ok', running: 'ok', live: 'ok', draft: 'neutral',
  paused: 'warn', completed: 'info', scheduled: 'info', archived: 'neutral',
};

const PALETTE = ['#38BDF8', '#A78BFA', '#19C3E6', '#22C55E', '#F59E0B', '#F43F5E'];
const colourFor = (n: number) => PALETTE[Math.abs(n) % PALETTE.length];
const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

// Rates may arrive as a fraction (0–1) or a percentage (0–100); normalise both.
const asPct = (n: number | null | undefined) => {
  const v = n ?? 0;
  const p = v > 0 && v <= 1 ? v * 100 : v;
  return Math.round(p * 10) / 10;
};

// ── Small shared bits ───────────────────────────────────────────────────────
function CountStat({ label, value, icon, accent, delay, suffix }:
  { label: string; value: number; icon: string; accent: string; delay: number; suffix?: string }) {
  const n = useCountUp(value);
  return <Stat label={label} value={`${n.toLocaleString()}${suffix || ''}`} icon={icon} accent={accent} delay={delay} />;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">{label}</label>
      {children}
    </div>
  );
}

function Gauge({ value, colour, label }: { value: number; colour: string; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  const r = 30, circ = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative grid place-items-center" style={{ width: 84, height: 84 }}>
        <svg width={84} height={84} className="-rotate-90">
          <circle cx={42} cy={42} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={7} />
          <circle cx={42} cy={42} r={r} fill="none" stroke={colour} strokeWidth={7} strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={circ * (1 - pct / 100)}
            style={{ transition: 'stroke-dashoffset 0.9s cubic-bezier(0.22,1,0.36,1)', filter: `drop-shadow(0 0 6px ${colour}88)` }} />
        </svg>
        <span className="absolute font-display text-base font-bold text-ink">{pct.toFixed(0)}%</span>
      </div>
      <span className="text-[11px] uppercase tracking-wider text-muted">{label}</span>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function Leads() {
  const { selectedTenant } = useApp();
  const toast = useToast();

  const [leads, setLeads] = useState<Lead[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  // Search / generate
  const [industry, setIndustry] = useState('');
  const [keywords, setKeywords] = useState('');
  const [location, setLocation] = useState('');
  const [searchCampaign, setSearchCampaign] = useState('');
  const [count, setCount] = useState(10);
  const [searching, setSearching] = useState(false);

  // Table filters
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterCampaign, setFilterCampaign] = useState('all');

  // Overlays
  const [openLeadId, setOpenLeadId] = useState<number | null>(null);
  const [detailCampaignId, setDetailCampaignId] = useState<number | null>(null);
  const [converting, setConverting] = useState<Record<number, boolean>>({});

  // New-campaign modal
  const [newCampaignOpen, setNewCampaignOpen] = useState(false);
  const [campaignName, setCampaignName] = useState('');
  const [creatingCampaign, setCreatingCampaign] = useState(false);

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadCampaigns = async () => {
    try {
      const res = await api.campaigns(selectedTenant ?? undefined);
      setCampaigns(res.campaigns || []);
    } catch { /* keep existing on failure */ }
  };

  const load = async () => {
    setLoading(true);
    try {
      const [lr, cr] = await Promise.all([
        api.leads({ tenant_id: selectedTenant ?? undefined }),
        api.campaigns(selectedTenant ?? undefined),
      ]);
      setLeads(lr.leads || []);
      setCampaigns(cr.campaigns || []);
    } catch {
      setLeads([]); setCampaigns([]);
      toast('Failed to load leads', 'danger');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [selectedTenant]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const patchLead = (id: number, data: Partial<Lead>) =>
    setLeads(prev => prev.map(l => (l.id === id ? { ...l, ...data } : l)));

  const findLeads = async () => {
    if (!industry.trim() && !keywords.trim() && !location.trim()) {
      toast('Add an industry, keywords or location to search', 'warn');
      return;
    }
    setSearching(true);
    try {
      const res = await api.leadsSearch({
        industry: industry.trim() || undefined,
        keywords: keywords.trim() || undefined,
        location: location.trim() || undefined,
        count,
        campaign_id: searchCampaign ? Number(searchCampaign) : undefined,
        tenant_id: selectedTenant ?? undefined,
      });
      const found = res.leads || [];
      const n = res.count ?? found.length;
      // Prepend fresh leads, de-duping any ids already in the table.
      setLeads(prev => {
        const ids = new Set(found.map(l => l.id));
        return [...found, ...prev.filter(l => !ids.has(l.id))];
      });
      toast(`Found ${n} lead${n === 1 ? '' : 's'}`, 'ok');
      if (searchCampaign) loadCampaigns();
    } catch {
      toast('Lead search failed', 'danger');
    }
    setSearching(false);
  };

  const quickStatus = async (l: Lead, status: LeadStatus) => {
    const prev = l.status;
    patchLead(l.id, { status });
    try {
      const res = await api.updateLead(l.id, { status });
      if (res.lead) patchLead(l.id, res.lead);
      if (status === 'converted') loadCampaigns();
    } catch {
      patchLead(l.id, { status: prev });
      toast('Could not update status', 'danger');
    }
  };

  const convert = async (l: Lead) => {
    setConverting(c => ({ ...c, [l.id]: true }));
    try {
      const res = await api.convertLead(l.id);
      patchLead(l.id, res.lead || { status: 'converted' });
      toast(`${l.company} converted`, 'ok');
      loadCampaigns();
    } catch {
      toast('Convert failed', 'danger');
    }
    setConverting(c => ({ ...c, [l.id]: false }));
  };

  const createCampaign = async () => {
    if (!campaignName.trim()) { toast('Name the campaign first', 'warn'); return; }
    setCreatingCampaign(true);
    try {
      const res = await api.createCampaign({ name: campaignName.trim(), tenant_id: selectedTenant ?? undefined });
      if (res.campaign) setCampaigns(prev => [res.campaign, ...prev]);
      toast('Campaign created', 'ok');
      setCampaignName('');
      setNewCampaignOpen(false);
    } catch {
      toast('Could not create campaign', 'danger');
    }
    setCreatingCampaign(false);
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = leads.length;
    const qualified = leads.filter(l => l.status === 'qualified').length;
    const converted = leads.filter(l => l.status === 'converted').length;
    const convRate = total ? Math.round((converted / total) * 100) : 0;
    return { total, qualified, converted, convRate };
  }, [leads]);

  const filtered = useMemo(() => leads.filter(l => {
    if (filterStatus !== 'all' && l.status !== filterStatus) return false;
    if (filterCampaign !== 'all' && l.campaign_id !== Number(filterCampaign)) return false;
    return true;
  }), [leads, filterStatus, filterCampaign]);

  const campaignLabel = (l: Lead) =>
    l.campaign_name || campaigns.find(c => c.id === l.campaign_id)?.name || '';

  const openLead = leads.find(l => l.id === openLeadId) || null;

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* ── Header + stats ───────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 animate-fadeInUp">
            <div className="grid h-11 w-11 place-items-center rounded-2xl"
              style={{ background: '#38BDF81a', color: '#38BDF8', boxShadow: '0 0 26px -6px #38BDF888' }}>
              <Icon name="person_search" size={24} />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold text-ink">Leads</h1>
              <p className="text-sm text-muted">Prospect, qualify and convert — your sales pipeline.</p>
            </div>
          </div>
          <Button variant="secondary" icon="refresh" onClick={load} loading={loading}>Refresh</Button>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <CountStat label="Total leads" value={stats.total}     icon="groups"             accent="#38BDF8" delay={0} />
          <CountStat label="Qualified"   value={stats.qualified} icon="workspace_premium"  accent="#A78BFA" delay={60} />
          <CountStat label="Converted"   value={stats.converted} icon="verified"           accent="#22C55E" delay={120} />
          <CountStat label="Conversion"  value={stats.convRate}  icon="trending_up"        accent="#19C3E6" delay={180} suffix="%" />
        </div>
      </div>

      {/* ── Search bar ───────────────────────────────────────────────────── */}
      <Card glass className="relative overflow-hidden p-4 animate-fadeInUp md:p-5">
        <div className="aurora-bg pointer-events-none absolute inset-0 opacity-30" />
        <div className="relative">
          <div className="mb-3 flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: '#19C3E61a', color: '#19C3E6' }}>
              <Icon name="travel_explore" size={18} />
            </div>
            <div>
              <h2 className="font-display text-sm font-semibold text-ink">Find new leads</h2>
              <p className="text-[11px] text-muted">Generate + enrich prospects and drop them into the pipeline.</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Industry">
              <Input value={industry} placeholder="e.g. SaaS, fintech"
                onChange={e => setIndustry(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && findLeads()} />
            </Field>
            <Field label="Keywords">
              <Input value={keywords} placeholder="e.g. Series A, remote"
                onChange={e => setKeywords(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && findLeads()} />
            </Field>
            <Field label="Location">
              <Input value={location} placeholder="e.g. London, US"
                onChange={e => setLocation(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && findLeads()} />
            </Field>
            <Field label="Target campaign">
              <Select value={searchCampaign} onChange={e => setSearchCampaign(e.target.value)} className="w-full">
                <option value="">No campaign</option>
                {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">Count</span>
              <Select value={String(count)} onChange={e => setCount(Number(e.target.value))}>
                {[5, 10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
              </Select>
            </div>
            <div className="flex-1" />
            <Button variant="primary" icon="travel_explore" loading={searching} onClick={findLeads}
              className="px-5" style={{ background: '#38BDF8', color: '#04222b', boxShadow: '0 0 22px rgba(56,189,248,0.3)' }}>
              {searching ? 'Searching…' : 'Find leads'}
            </Button>
          </div>
        </div>
      </Card>

      {/* ── Results table ────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">Pipeline</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="all">All statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            </Select>
            <Select value={filterCampaign} onChange={e => setFilterCampaign(e.target.value)}>
              <option value="all">All campaigns</option>
              {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Badge tone="neutral">{filtered.length} of {leads.length}</Badge>
          </div>
        </div>

        {loading ? (
          <SkeletonList count={6} />
        ) : filtered.length === 0 ? (
          leads.length === 0 ? (
            <EmptyState icon="person_search" accent="#38BDF8" large
              title="No leads yet"
              hint="Use the search above to generate your first batch of prospects — they'll land here ready to qualify and convert." />
          ) : (
            <EmptyState icon="filter_alt" title="No matches"
              hint="Try a different status or campaign filter." />
          )
        ) : (
          <Card className="overflow-hidden p-0 animate-fadeInUp">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wider text-muted">
                    <th className="px-4 py-2.5 font-semibold">Company</th>
                    <th className="px-4 py-2.5 font-semibold">Contact</th>
                    <th className="px-4 py-2.5 font-semibold">Source</th>
                    <th className="px-4 py-2.5 font-semibold">Campaign</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                    <th className="px-4 py-2.5 font-semibold">Added</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l, i) => {
                    const cn = campaignLabel(l);
                    return (
                      <tr key={l.id} onClick={() => setOpenLeadId(l.id)}
                        className="group cursor-pointer border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.03] animate-fadeInUp"
                        style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}>
                        {/* Company */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar size={30} colour={colourFor(l.id)} initials={initialsOf(l.company)} />
                            <span className="font-medium text-ink">{l.company}</span>
                          </div>
                        </td>
                        {/* Contact */}
                        <td className="px-4 py-3">
                          {l.contact_name || l.email || l.phone ? (
                            <div className="min-w-0">
                              {l.contact_name && <div className="truncate text-ink">{l.contact_name}</div>}
                              {l.email && (
                                <div className="flex items-center gap-1 truncate text-xs text-muted">
                                  <Icon name="mail" size={12} /> {l.email}
                                </div>
                              )}
                              {!l.email && l.phone && (
                                <div className="flex items-center gap-1 truncate text-xs text-muted">
                                  <Icon name="call" size={12} /> {l.phone}
                                </div>
                              )}
                            </div>
                          ) : <span className="text-muted">—</span>}
                        </td>
                        {/* Source */}
                        <td className="px-4 py-3">
                          {l.source ? <Badge tone="neutral">{l.source}</Badge> : <span className="text-muted">—</span>}
                        </td>
                        {/* Campaign */}
                        <td className="px-4 py-3">
                          {cn ? <span className="text-ink/90">{cn}</span> : <span className="text-muted">—</span>}
                        </td>
                        {/* Status */}
                        <td className="px-4 py-3">
                          <Badge tone={STATUS_META[l.status].tone} dot>{STATUS_META[l.status].label}</Badge>
                        </td>
                        {/* Added */}
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-muted">{timeAgo(l.created_at)}</td>
                        {/* Actions */}
                        <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-2">
                            <Select value={l.status} onChange={e => quickStatus(l, e.target.value as LeadStatus)}
                              className="py-1 text-xs">
                              {STATUSES.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                            </Select>
                            <Button variant="ghost" icon="bolt" className="px-2 py-1 text-xs"
                              disabled={l.status === 'converted'} loading={!!converting[l.id]}
                              onClick={() => convert(l)}>
                              {l.status === 'converted' ? 'Won' : 'Convert'}
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      {/* ── Campaigns ────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">Campaigns</h2>
          <Button variant="secondary" icon="add" onClick={() => setNewCampaignOpen(true)}>New campaign</Button>
        </div>

        {loading ? (
          <SkeletonList count={3} />
        ) : campaigns.length === 0 ? (
          <EmptyState icon="campaign" accent="#A78BFA"
            title="No campaigns yet"
            hint="Group your outreach into campaigns to track replies, leads and conversions."
            action={<Button variant="primary" icon="add" onClick={() => setNewCampaignOpen(true)}>New campaign</Button>} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {campaigns.map((c, i) => (
              <Card key={c.id} hover role="button" tabIndex={0}
                onClick={() => setDetailCampaignId(c.id)}
                onKeyDown={e => { if (e.key === 'Enter') setDetailCampaignId(c.id); }}
                className="cursor-pointer p-4 animate-fadeInUp"
                style={{ animationDelay: `${i * 60}ms` }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-display font-semibold text-ink">{c.name}</div>
                    <div className="text-[11px] text-muted">{timeAgo(c.created_at)}</div>
                  </div>
                  <Badge tone={CAMPAIGN_TONE[c.status] || 'neutral'} dot>{c.status || 'draft'}</Badge>
                </div>

                <div className="mt-3 flex items-end justify-between gap-3">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                    <Metric icon="send"     label="Sent"    value={c.sent_count} />
                    <Metric icon="reply"    label="Replies" value={c.reply_count} />
                    <Metric icon="groups"   label="Leads"   value={c.lead_count} />
                    <Metric icon="verified" label="Won"     value={c.converted_count} />
                  </div>
                  <Sparkline data={[c.sent_count, c.reply_count, c.lead_count, c.converted_count]}
                    colour={colourFor(c.id)} width={104} height={44} />
                </div>

                <div className="mt-3 flex items-center gap-1.5 border-t border-white/5 pt-3">
                  <Badge tone="violet">{asPct(c.reply_rate)}% reply</Badge>
                  <Badge tone="ok">{asPct(c.conversion_rate)}% conv</Badge>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ── Lead detail drawer ───────────────────────────────────────────── */}
      <Drawer open={openLeadId !== null} onClose={() => setOpenLeadId(null)} width="max-w-md">
        {openLead && (
          <LeadDrawer key={openLead.id} lead={openLead} campaigns={campaigns}
            onPatch={l => patchLead(l.id, l)} onReloadCampaigns={loadCampaigns}
            onClose={() => setOpenLeadId(null)} />
        )}
      </Drawer>

      {/* ── Campaign detail drawer ───────────────────────────────────────── */}
      <Drawer open={detailCampaignId !== null} onClose={() => setDetailCampaignId(null)} width="max-w-2xl">
        {detailCampaignId !== null && (
          <CampaignDetail key={detailCampaignId} id={detailCampaignId}
            onClose={() => setDetailCampaignId(null)} />
        )}
      </Drawer>

      {/* ── New campaign modal ───────────────────────────────────────────── */}
      <Modal open={newCampaignOpen} onClose={() => setNewCampaignOpen(false)} title="New campaign">
        <div className="space-y-3">
          <Field label="Campaign name">
            <Input autoFocus value={campaignName} placeholder="e.g. Q3 outbound — fintech"
              onChange={e => setCampaignName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createCampaign()} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewCampaignOpen(false)}>Cancel</Button>
            <Button variant="primary" icon="add" loading={creatingCampaign} onClick={createCampaign}>Create</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Campaign card metric ────────────────────────────────────────────────────
function Metric({ icon, label, value }: { icon: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Icon name={icon} size={14} className="text-muted" />
      <span className="font-mono font-semibold text-ink">{value.toLocaleString()}</span>
      <span className="text-muted">{label}</span>
    </div>
  );
}

// ── Lead detail drawer body ─────────────────────────────────────────────────
type LeadForm = {
  company: string; contact_name: string; email: string; phone: string;
  source: string; status: LeadStatus; notes: string; campaign_id: number | null;
};

function LeadDrawer({ lead, campaigns, onPatch, onReloadCampaigns, onClose }:
  { lead: Lead; campaigns: Campaign[]; onPatch: (l: Lead) => void; onReloadCampaigns: () => void; onClose: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<LeadForm>({
    company: lead.company,
    contact_name: lead.contact_name || '',
    email: lead.email || '',
    phone: lead.phone || '',
    source: lead.source || '',
    status: lead.status,
    notes: lead.notes || '',
    campaign_id: lead.campaign_id,
  });
  const [saving, setSaving] = useState(false);
  const [converting, setConverting] = useState(false);

  const set = <K extends keyof LeadForm>(k: K, v: LeadForm[K]) => setForm(f => ({ ...f, [k]: v }));
  const meta = STATUS_META[form.status];

  const save = async () => {
    if (!form.company.trim()) { toast('Company is required', 'warn'); return; }
    setSaving(true);
    try {
      const res = await api.updateLead(lead.id, {
        company: form.company.trim(),
        contact_name: form.contact_name.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        source: form.source.trim() || null,
        status: form.status,
        notes: form.notes.trim() || null,
        campaign_id: form.campaign_id,
      });
      if (res.lead) onPatch(res.lead);
      if (form.status === 'converted') onReloadCampaigns();
      toast('Lead saved', 'ok');
    } catch {
      toast('Could not save lead', 'danger');
    }
    setSaving(false);
  };

  const convert = async () => {
    setConverting(true);
    try {
      const res = await api.convertLead(lead.id);
      const status = res.lead?.status || 'converted';
      set('status', status);
      if (res.lead) onPatch(res.lead);
      onReloadCampaigns();
      toast(`${form.company} converted`, 'ok');
    } catch {
      toast('Convert failed', 'danger');
    }
    setConverting(false);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-white/10 p-5">
        <Avatar size={48} colour={colourFor(lead.id)} initials={initialsOf(form.company || lead.company)} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-lg font-bold text-ink">{form.company || lead.company}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={meta.tone} dot>{meta.label}</Badge>
            <span className="inline-flex items-center gap-1 text-[11px] text-muted">
              <Icon name="schedule" size={13} /> Added {timeAgo(lead.created_at)}
            </span>
          </div>
        </div>
        <button onClick={onClose} className="text-muted hover:text-ink"><Icon name="close" /></button>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        <Field label="Company">
          <Input value={form.company} onChange={e => set('company', e.target.value)} />
        </Field>
        <Field label="Contact name">
          <Input value={form.contact_name} placeholder="Full name" onChange={e => set('contact_name', e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Email">
            <Input type="email" value={form.email} placeholder="name@company.com" onChange={e => set('email', e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} placeholder="+44…" onChange={e => set('phone', e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Source">
            <Input value={form.source} placeholder="e.g. LinkedIn" onChange={e => set('source', e.target.value)} />
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={e => set('status', e.target.value as LeadStatus)} className="w-full">
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Campaign">
          <Select value={form.campaign_id ?? ''} className="w-full"
            onChange={e => set('campaign_id', e.target.value ? Number(e.target.value) : null)}>
            <option value="">No campaign</option>
            {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Notes">
          <Textarea value={form.notes} rows={5} placeholder="Add context, next steps, call notes…"
            onChange={e => set('notes', e.target.value)} className="resize-none" />
        </Field>
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t border-white/10 p-4">
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <div className="flex-1" />
        <Button variant="secondary" icon="bolt" loading={converting}
          disabled={form.status === 'converted'} onClick={convert}>
          {form.status === 'converted' ? 'Converted' : 'Convert'}
        </Button>
        <Button variant="primary" icon="save" loading={saving} onClick={save}>Save</Button>
      </div>
    </div>
  );
}

// ── Campaign detail drawer body ─────────────────────────────────────────────
function CampaignDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const toast = useToast();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.campaign(id)
      .then(r => { if (alive) setCampaign(r.campaign); })
      .catch(() => { if (alive) { setCampaign(null); toast('Could not load campaign', 'danger'); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    /* eslint-disable-next-line */
  }, [id]);

  const funnel = campaign ? [
    { label: 'Sent',      value: campaign.sent_count,      colour: '#38BDF8' },
    { label: 'Replies',   value: campaign.reply_count,     colour: '#A78BFA' },
    { label: 'Leads',     value: campaign.lead_count,      colour: '#19C3E6' },
    { label: 'Converted', value: campaign.converted_count, colour: '#22C55E' },
  ] : [];
  const fmax = Math.max(1, ...funnel.map(f => f.value));

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-white/10 p-5">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
          style={{ background: `${colourFor(id)}1a`, color: colourFor(id) }}>
          <Icon name="campaign" size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-lg font-bold text-ink">{campaign?.name || 'Campaign'}</div>
          {campaign && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge tone={CAMPAIGN_TONE[campaign.status] || 'neutral'} dot>{campaign.status || 'draft'}</Badge>
              <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                <Icon name="schedule" size={13} /> {timeAgo(campaign.created_at)}
              </span>
            </div>
          )}
        </div>
        <button onClick={onClose} className="text-muted hover:text-ink"><Icon name="close" /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <SkeletonList count={5} />
        ) : !campaign ? (
          <EmptyState icon="error" title="Campaign unavailable" hint="This campaign could not be loaded." />
        ) : (
          <div className="space-y-6">
            {/* Metric row */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Sent',      value: campaign.sent_count,      icon: 'send',     accent: '#38BDF8' },
                { label: 'Replies',   value: campaign.reply_count,     icon: 'reply',    accent: '#A78BFA' },
                { label: 'Leads',     value: campaign.lead_count,      icon: 'groups',   accent: '#19C3E6' },
                { label: 'Converted', value: campaign.converted_count, icon: 'verified', accent: '#22C55E' },
              ].map(m => (
                <div key={m.label} className="rounded-xl border border-white/8 bg-black/20 p-3">
                  <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted">
                    <Icon name={m.icon} size={13} style={{ color: m.accent }} /> {m.label}
                  </div>
                  <div className="mt-1 font-display text-xl font-bold text-ink">{m.value.toLocaleString()}</div>
                </div>
              ))}
            </div>

            {/* Charts: gauges + funnel */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Card glass className="flex items-center justify-around gap-2 p-4">
                <Gauge value={asPct(campaign.reply_rate)} colour="#A78BFA" label="Reply rate" />
                <Gauge value={asPct(campaign.conversion_rate)} colour="#22C55E" label="Conversion" />
              </Card>
              <Card glass className="space-y-3 p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Funnel</div>
                {funnel.map(f => (
                  <div key={f.label}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-muted">{f.label}</span>
                      <span className="font-mono text-ink">{f.value.toLocaleString()}</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-white/5">
                      <div className="h-full rounded-full transition-all duration-700"
                        style={{ width: `${(f.value / fmax) * 100}%`, background: f.colour, boxShadow: `0 0 12px ${f.colour}66` }} />
                    </div>
                  </div>
                ))}
              </Card>
            </div>

            {/* Email preview */}
            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Email preview</div>
              {campaign.email_preview ? (
                <div className="overflow-hidden rounded-xl border border-white/10 bg-black/30">
                  <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-muted">
                    <Icon name="mail" size={15} /> Outreach template
                  </div>
                  <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-ink/90">
                    {campaign.email_preview}
                  </pre>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-muted">
                  No email preview generated yet.
                </div>
              )}
            </div>

            {/* Leads */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Leads</div>
                <Badge tone="neutral">{campaign.leads?.length || 0}</Badge>
              </div>
              {campaign.leads && campaign.leads.length > 0 ? (
                <div className="space-y-2">
                  {campaign.leads.map(l => (
                    <div key={l.id} className="flex items-center gap-2.5 rounded-lg border border-white/8 bg-black/20 px-3 py-2">
                      <Avatar size={28} colour={colourFor(l.id)} initials={initialsOf(l.company)} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-ink">{l.company}</div>
                        {(l.contact_name || l.email) && (
                          <div className="truncate text-[11px] text-muted">{l.contact_name || l.email}</div>
                        )}
                      </div>
                      <Badge tone={STATUS_META[l.status].tone}>{STATUS_META[l.status].label}</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-muted">
                  No leads attached to this campaign yet.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
