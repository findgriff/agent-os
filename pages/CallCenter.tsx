// Call Center — AI-powered outbound calling dashboard
import { useEffect, useRef, useState, useCallback } from 'react';
import { apiReq } from '../lib/api';
import { Icon } from '../components/ui';

const ORANGE = '#FF6B00';

interface CallScript {
  name: string; business_type: string; opening: string;
  questions: string[]; max_duration_minutes: number;
  working_hours: { start: number; end: number };
}

interface CallLog {
  business: string; phone: string; timestamp: number; result: string; call_sid: string;
}

interface CampaignStats {
  calls: number; answered: number; conversions: number; blocked: number;
  answer_rate: number; conversion_rate: number; cost_pence: number;
}

interface Campaign {
  id: string; name: string; business: string; lead_source: string;
  start_date: string; end_date: string; status: string; created_at: number;
  stats: CampaignStats;
}

interface DayBucket {
  date: string; label: string; calls: number; answered: number;
  converted: number; blocked: number;
}

interface Analytics {
  total_logged: number; calls_placed: number; dry_runs: number; blocked: number; errors: number;
  answered: number; answer_rate: number; converted: number; conversion_rate: number;
  avg_duration_seconds: number; duration_sample: number; avg_score: number | null;
  cost_per_call_pence: number; total_cost_pence: number;
  cost_per_conversion_pence: number | null; daily: DayBucket[];
}

interface DndEntry {
  phone: string; timestamp: number | null; source: string;
  business: string; call_sid: string;
}
interface BlockedEntry {
  phone: string; business: string; timestamp: number; reason: string; result: string;
}
interface NoticeEntry {
  phone: string; business: string; timestamp: number; call_sid: string;
}
interface Compliance {
  dnd: DndEntry[]; dnd_total: number;
  blocked: BlockedEntry[]; blocked_total: number;
  blocked_dnd: number; blocked_max_attempts: number;
  recording_notices: NoticeEntry[]; recording_notices_total: number;
  recording_notices_unverified: number; opt_outs_this_call: number;
}

const CARD = 'bg-[#14141F]/80 backdrop-blur-xl border border-white/5 rounded-2xl';
// Hover lift + orange glow for cards, hover highlight for list rows.
const LIFT = 'transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-white/10 hover:shadow-[0_10px_32px_-10px_rgba(255,107,0,0.25)]';
const ROW = 'transition-colors duration-200 hover:bg-white/[0.07]';
const FIELD = 'w-full bg-[#0A0A0F] border border-white/10 rounded-xl px-3 py-2 text-white text-sm placeholder-white/30 outline-none focus:border-[#FF6B00]/40 transition-colors';

type CallPhase = 'idle' | 'ringing' | 'connected' | 'ended';

const money = (pence: number) =>
  pence >= 100 ? `£${(pence / 100).toFixed(2)}` : `${pence}p`;

const duration = (secs: number) => {
  if (!secs) return '—';
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
};

const when = (ts: number | null) =>
  ts ? new Date(ts * 1000).toLocaleString() : 'unknown';

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function CallCenter() {
  const [scripts, setScripts] = useState<Record<string, CallScript>>({});
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [selectedBusiness, setSelectedBusiness] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [calling, setCalling] = useState(false);
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(true);
  // Timers driving the ringing → connected → ended button phases.
  const phaseTimers = useRef<number[]>([]);
  const clearPhaseTimers = () => {
    phaseTimers.current.forEach(t => window.clearTimeout(t));
    phaseTimers.current = [];
  };
  useEffect(() => clearPhaseTimers, []);
  const [leads, setLeads] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({});
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [compliance, setCompliance] = useState<Compliance | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [form, setForm] = useState({
    name: '', business: '', lead_source: '',
    start_date: todayISO(), end_date: '',
  });
  const [tab, setTab] = useState<'dnd' | 'blocked' | 'notices'>('dnd');

  const load = useCallback(async () => {
    try {
      const res = await apiReq<{ scripts: Record<string, CallScript> }>('GET', '/api/call-center/scripts');
      setScripts(res.scripts);
      const keys = Object.keys(res.scripts);
      if (keys.length > 0) {
        setSelectedBusiness(b => b || keys[0]);
        setForm(f => (f.business ? f : { ...f, business: keys[0] }));
      }
    } catch {}
    try {
      const res = await apiReq<{ calls: CallLog[] }>('GET', '/api/call-center/history');
      setCalls(res.calls || []);
    } catch {}
    try {
      const res = await apiReq<{ leads: any[] }>('GET', '/api/leads?status=new&limit=10');
      setLeads(res.leads || []);
    } catch {}
    try {
      const res = await apiReq<any>('GET', '/api/call-center/stats');
      setStats(res || {});
    } catch {}
    try {
      const res = await apiReq<{ campaigns: Campaign[] }>('GET', '/api/call-center/campaigns');
      setCampaigns(res.campaigns || []);
    } catch {}
    try {
      setAnalytics(await apiReq<Analytics>('GET', '/api/call-center/analytics'));
    } catch {}
    try {
      setCompliance(await apiReq<Compliance>('GET', '/api/call-center/compliance'));
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCall = async () => {
    if (!selectedBusiness || !phoneNumber) return;
    setCalling(true);
    setResult('');
    clearPhaseTimers();
    setPhase('ringing');
    try {
      const res = await apiReq<any>('POST', '/api/call-center/call', {
        business: selectedBusiness, phone: phoneNumber,
      });
      setResult(res.status || res.error || 'Call initiated');
      if (res.error) {
        setPhase('idle');
      } else {
        // The call runs server-side; walk the button through its phases.
        setPhase('connected');
        phaseTimers.current.push(
          window.setTimeout(() => setPhase('ended'), 10000),
          window.setTimeout(() => setPhase('idle'), 13000),
        );
      }
      load();
    } catch (e: any) {
      setResult(e.message || 'Call failed');
      setPhase('idle');
    }
    setCalling(false);
  };

  const handleQueue = async () => {
    if (!selectedBusiness) return;
    setCalling(true);
    setResult('Processing queue...');
    try {
      const res = await apiReq<any>('POST', '/api/call-center/queue', { business: selectedBusiness });
      setResult(res.message || 'Queue processed');
      load();
    } catch (e: any) {
      setResult(e.message || 'Queue failed');
    }
    setCalling(false);
  };

  const handleCreateCampaign = async () => {
    setSaving(true);
    setFormError('');
    try {
      await apiReq<{ campaign: Campaign }>('POST', '/api/call-center/campaigns', form);
      setForm({ name: '', business: form.business, lead_source: '', start_date: todayISO(), end_date: '' });
      setShowForm(false);
      load();
    } catch (e: any) {
      setFormError(e.message || 'Could not create campaign');
    }
    setSaving(false);
  };

  const handleDeleteCampaign = async (id: string) => {
    try {
      await apiReq('DELETE', `/api/call-center/campaigns/${id}`);
      load();
    } catch {}
  };

  const peakDay = Math.max(1, ...(analytics?.daily || []).map(d => d.calls + d.blocked));

  return (
    <div className="relative p-6 max-w-7xl mx-auto space-y-6">
      {/* Ambient wash — warm call-center orange bleeding in from the top */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[440px]
        bg-[radial-gradient(ellipse_70%_60%_at_50%_-12%,rgba(255,107,0,0.10),transparent_65%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[440px]
        bg-[radial-gradient(ellipse_45%_45%_at_88%_-10%,rgba(25,195,230,0.06),transparent_60%)]" />

      {/* Header */}
      <div className="relative flex items-center justify-between animate-fadeInUp">
        <div>
          <h1 className="text-2xl font-bold text-white">Call Center</h1>
          <p className="text-white/40 text-sm mt-1">AI-powered outbound calling — powered by Kimi K3</p>
        </div>
        <button onClick={load}
          className="text-xs text-white/50 hover:text-white/80 transition-all duration-200 ease-out bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-lg hover:shadow-[0_0_18px_-6px_rgba(255,107,0,0.5)]">
          ↻ Refresh
        </button>
      </div>

      {/* Analytics cards — icon + number + label */}
      {loading && !analytics ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="skeleton h-[104px] rounded-2xl" style={{ animationDelay: `${i * 120}ms` }} />
          ))}
        </div>
      ) : analytics && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Answer rate', icon: 'call', accent: ORANGE, value: `${analytics.answer_rate}%`,
              sub: `${analytics.answered} of ${analytics.calls_placed} placed` },
            { label: 'Conversion rate', icon: 'trending_up', accent: '#22C55E', value: `${analytics.conversion_rate}%`,
              sub: `${analytics.converted} hot of ${analytics.answered} answered` },
            { label: 'Avg duration', icon: 'timer', accent: '#19C3E6', value: duration(analytics.avg_duration_seconds),
              sub: analytics.duration_sample ? `over ${analytics.duration_sample} conversations` : 'no conversations yet' },
            { label: 'Cost per call', icon: 'payments', accent: '#A78BFA', value: `${analytics.cost_per_call_pence}p`,
              sub: `${money(analytics.total_cost_pence)} total (estimate)` },
          ].map((c, i) => (
            <div key={c.label} className={`${CARD} ${LIFT} group p-4 animate-fadeInUp`}
              style={{ animationDelay: `${i * 80}ms` }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-white/40 text-xs uppercase tracking-wide">{c.label}</div>
                  <div className="text-2xl font-bold mt-1 tabular-nums" style={{ color: c.accent }}>{c.value}</div>
                  <div className="text-white/30 text-[11px] mt-1 leading-tight">{c.sub}</div>
                </div>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-transform duration-200 group-hover:scale-110 group-hover:-rotate-6"
                  style={{ background: `${c.accent}1a`, color: c.accent, boxShadow: `0 0 20px -10px ${c.accent}88` }}>
                  <Icon name={c.icon} size={19} />
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 7-day activity */}
      {analytics && analytics.daily.length > 0 && (
        <div className={`${CARD} ${LIFT} p-5 animate-fadeInUp`} style={{ animationDelay: '120ms' }}>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-white text-lg font-semibold">📶 Last 7 days</h2>
            <span className="text-white/30 text-xs">
              answered <span style={{ color: ORANGE }}>■</span> · unanswered <span className="text-white/25">■</span> · blocked <span className="text-[#EF4444]">■</span>
            </span>
          </div>
          <div className="flex items-end gap-2 h-28">
            {analytics.daily.map(d => {
              const unanswered = Math.max(0, d.calls - d.answered);
              const h = (n: number) => `${(n / peakDay) * 100}%`;
              return (
                <div key={d.date} className="flex-1 flex flex-col items-center gap-1 h-full justify-end group relative">
                  <div className="w-full flex flex-col justify-end h-full gap-px">
                    {d.blocked > 0 && <div className="w-full rounded-t bg-[#EF4444]/70" style={{ height: h(d.blocked) }} />}
                    {unanswered > 0 && <div className="w-full bg-white/15" style={{ height: h(unanswered) }} />}
                    {d.answered > 0 && <div className="w-full rounded-b" style={{ height: h(d.answered), background: ORANGE }} />}
                    {d.calls + d.blocked === 0 && <div className="w-full h-px bg-white/10" />}
                  </div>
                  <div className="text-white/30 text-[10px]">{d.label}</div>
                  <div className="absolute -top-1 opacity-0 group-hover:opacity-100 transition-opacity bg-[#0A0A0F] border border-white/10 rounded-lg px-2 py-1 text-[10px] text-white/70 whitespace-nowrap pointer-events-none z-10">
                    {d.date}: {d.calls} calls, {d.answered} answered{d.blocked ? `, ${d.blocked} blocked` : ''}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="text-white/25 text-[10px] mt-3 leading-relaxed">
            Answered = the lead spoke (Twilio pickup isn't recorded). Duration is the handled
            conversation span, not billed time. Cost is an estimate at {analytics.cost_per_call_pence}p per placed call.
            {analytics.dry_runs > 0 && ` ${analytics.dry_runs} dry run(s) excluded.`}
            {analytics.errors > 0 && ` ${analytics.errors} call(s) rejected by Twilio before dialling — excluded from rates and cost.`}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Make a call */}
        <div className="lg:col-span-2 space-y-6">
          {/* Quick Call */}
          <div className={`${CARD} ${LIFT} p-5 animate-fadeInUp`} style={{ animationDelay: '160ms' }}>
            <h2 className="text-white text-lg font-semibold mb-4">📞 Quick Call</h2>
            <div className="space-y-3">
              <select value={selectedBusiness} onChange={e => setSelectedBusiness(e.target.value)}
                className="w-full bg-[#0A0A0F] border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-[#FF6B00]/40 transition-colors">
                {Object.entries(scripts).map(([slug, s]) => (
                  <option key={slug} value={slug}>{s.name} ({s.business_type})</option>
                ))}
              </select>
              <input value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)}
                placeholder="Phone number (e.g. +447939554798)"
                className="w-full bg-[#0A0A0F] border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder-white/30 outline-none focus:border-[#19C3E6]/40 transition-colors" />
              <div className="flex gap-2">
                <button onClick={handleCall} disabled={calling || phase === 'ringing' || phase === 'connected' || !phoneNumber}
                  className={`flex-1 text-sm px-4 py-2.5 rounded-xl border transition-all duration-200 ease-out disabled:cursor-not-allowed
                    ${phase === 'ringing'
                      ? 'bg-[#FF6B00]/15 border-[#FF6B00]/50 text-[#FF6B00] animate-pulse shadow-[0_0_28px_-6px_rgba(255,107,0,0.6)]'
                      : phase === 'connected'
                      ? 'bg-[#22C55E]/15 border-[#22C55E]/50 text-[#22C55E] animate-pulse shadow-[0_0_28px_-6px_rgba(34,197,94,0.6)]'
                      : phase === 'ended'
                      ? 'bg-white/5 border-white/15 text-white/60'
                      : 'bg-[#19C3E6]/10 border-[#19C3E6]/30 text-[#19C3E6] hover:bg-[#19C3E6]/20 hover:shadow-[0_0_24px_-6px_rgba(25,195,230,0.6)] disabled:opacity-40'}`}>
                  {phase === 'ringing' ? '🔔 Ringing...'
                    : phase === 'connected' ? '🎙 Connected...'
                    : phase === 'ended' ? '✓ Ended'
                    : calling ? 'Calling...' : '📞 Call Now'}
                </button>
                <button onClick={handleQueue} disabled={calling}
                  className="bg-[#FF6B00]/10 border border-[#FF6B00]/30 text-[#FF6B00] text-sm px-4 py-2.5 rounded-xl hover:bg-[#FF6B00]/20 hover:shadow-[0_0_24px_-6px_rgba(255,107,0,0.6)] transition-all duration-200 ease-out disabled:opacity-40">
                  ▶ Queue
                </button>
              </div>
              {result && (
                <div className="text-sm text-white/70 bg-white/5 rounded-xl px-3 py-2 animate-[fadeInUp_0.25s_ease-out_both]">{result}</div>
              )}
            </div>
          </div>

          {/* Campaigns */}
          <div className={`${CARD} ${LIFT} p-5 animate-fadeInUp`} style={{ animationDelay: '220ms' }}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-white text-lg font-semibold">🎯 Campaigns</h2>
              <button onClick={() => { setShowForm(v => !v); setFormError(''); }}
                className="text-xs px-3 py-1.5 rounded-lg border transition-all duration-200 ease-out hover:shadow-[0_0_18px_-6px_rgba(255,107,0,0.6)] hover:brightness-125"
                style={{ color: ORANGE, borderColor: `${ORANGE}4D`, background: `${ORANGE}1A` }}>
                {showForm ? '× Cancel' : '+ New Campaign'}
              </button>
            </div>

            {showForm && (
              <div className="bg-[#0A0A0F]/60 border border-white/5 rounded-xl p-3 mb-3 space-y-2 animate-[fadeInUp_0.25s_ease-out_both]">
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  placeholder="Campaign name" className={FIELD} />
                <div className="grid grid-cols-2 gap-2">
                  <select value={form.business} onChange={e => setForm({ ...form, business: e.target.value })}
                    className={FIELD}>
                    {Object.entries(scripts).map(([slug, s]) => (
                      <option key={slug} value={slug}>{s.name}</option>
                    ))}
                  </select>
                  <input value={form.lead_source} onChange={e => setForm({ ...form, lead_source: e.target.value })}
                    placeholder="Lead source" className={FIELD} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[11px] text-white/40">Start
                    <input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })}
                      className={`${FIELD} mt-1 [color-scheme:dark]`} />
                  </label>
                  <label className="text-[11px] text-white/40">End
                    <input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })}
                      className={`${FIELD} mt-1 [color-scheme:dark]`} />
                  </label>
                </div>
                {formError && <div className="text-[#EF4444] text-xs">{formError}</div>}
                <button onClick={handleCreateCampaign} disabled={saving || !form.name}
                  className="w-full text-sm px-4 py-2 rounded-xl border transition-all duration-200 ease-out hover:shadow-[0_0_20px_-6px_rgba(255,107,0,0.6)] hover:brightness-125 disabled:opacity-40"
                  style={{ color: ORANGE, borderColor: `${ORANGE}4D`, background: `${ORANGE}1A` }}>
                  {saving ? 'Saving...' : 'Create campaign'}
                </button>
              </div>
            )}

            {campaigns.length === 0 ? (
              <div className="text-white/30 text-sm text-center py-6">
                No campaigns yet — create one to group calls by business and date range.
              </div>
            ) : (
              <div className="space-y-2">
                {campaigns.map(c => (
                  <div key={c.id} className={`bg-[#0A0A0F]/50 rounded-xl px-3 py-2.5 ${ROW}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-white/90 text-sm font-medium truncate">{c.name}</div>
                        <div className="text-white/35 text-[11px] truncate">
                          {scripts[c.business]?.name || c.business}
                          {c.lead_source && ` · ${c.lead_source}`}
                          {c.start_date && ` · ${c.start_date}${c.end_date ? ` → ${c.end_date}` : ' → open'}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] px-2 py-0.5 rounded-full border"
                          style={{ color: ORANGE, borderColor: `${ORANGE}33` }}>{c.status}</span>
                        <button onClick={() => handleDeleteCampaign(c.id)}
                          className="text-white/25 hover:text-[#EF4444] transition-colors text-xs">×</button>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2 mt-2 text-center">
                      {[
                        ['Calls', c.stats.calls, 'text-white/80'],
                        ['Answered', c.stats.answered, 'text-white/80'],
                        ['Conversions', c.stats.conversions, ''],
                        ['Cost', money(c.stats.cost_pence), 'text-white/80'],
                      ].map(([label, value, cls]) => (
                        <div key={label as string} className="bg-white/[0.03] rounded-lg py-1.5">
                          <div className={`text-sm font-semibold ${cls as string}`}
                            style={label === 'Conversions' ? { color: ORANGE } : undefined}>{value}</div>
                          <div className="text-white/30 text-[10px]">{label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="text-white/25 text-[10px] pt-1">
                  Calls are attributed by business + date range.
                </div>
              </div>
            )}
          </div>

          {/* Call Script Preview */}
          {scripts[selectedBusiness] && (
            <div className={`${CARD} ${LIFT} p-5 animate-fadeInUp`} style={{ animationDelay: '280ms' }}>
              <h2 className="text-white text-lg font-semibold mb-3">📋 {scripts[selectedBusiness].name} Script</h2>
              <div className="space-y-2 text-sm">
                <div className="text-white/60"><span className="text-white/80 font-medium">Opening:</span> {scripts[selectedBusiness].opening}</div>
                <div className="text-white/60">
                  <span className="text-white/80 font-medium">Questions:</span>
                  <ul className="list-disc list-inside mt-1 space-y-0.5 text-white/50">
                    {scripts[selectedBusiness].questions.map((q, i) => <li key={i}>{q}</li>)}
                  </ul>
                </div>
                <div className="text-white/50 text-xs">Max duration: {scripts[selectedBusiness].max_duration_minutes} mins | Hours: {scripts[selectedBusiness].working_hours.start}:00 - {scripts[selectedBusiness].working_hours.end}:00</div>
              </div>
            </div>
          )}

          {/* Call History */}
          {calls.length > 0 && (
            <div className={`${CARD} ${LIFT} p-5 animate-fadeInUp`} style={{ animationDelay: '340ms' }}>
              <h2 className="text-white text-lg font-semibold mb-3">📊 Call History</h2>
              <div className="space-y-1.5">
                {[...calls].reverse().slice(0, 15).map((c, i) => {
                  const ts = new Date(c.timestamp * 1000).toLocaleString();
                  const ok = c.result === 'queued' || c.result === 'in-progress';
                  return (
                    <div key={i} className={`flex items-center justify-between bg-[#0A0A0F]/50 rounded-xl px-3 py-2 text-xs ${ROW}`}>
                      <div className="flex items-center gap-3">
                        <span className={ok ? 'text-[#19C3E6]' : 'text-[#EF4444]'}>{ok ? '✅' : '❌'}</span>
                        <span className="text-white/70 font-medium">{c.business}</span>
                        <span className="text-white/40">{c.phone}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-white/40">{ts}</span>
                        <span className={ok ? 'text-[#19C3E6]' : 'text-[#EF4444]'}>{c.result}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Right: Lead Queue */}
        <div className="space-y-6">
          <div className={`${CARD} ${LIFT} p-5 animate-fadeInUp`} style={{ animationDelay: '200ms' }}>
            <h2 className="text-white text-lg font-semibold mb-3">👤 Lead Queue</h2>
            {leads.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <span className="grid h-11 w-11 place-items-center rounded-2xl border border-white/8 bg-white/[0.03] text-white/25">
                  <Icon name="person_search" size={22} />
                </span>
                <div className="text-white/40 text-sm">No new leads to call</div>
                <div className="text-white/25 text-[11px]">Fresh leads land here automatically.</div>
              </div>
            ) : (
              <div className="space-y-2">
                {leads.map((l, i) => (
                  <div key={i} className={`bg-[#0A0A0F]/50 rounded-xl px-3 py-2 text-xs ${ROW}`}>
                    <div className="text-white/80 font-medium">{l.company || l.contact_name || 'Unknown'}</div>
                    <div className="text-white/40">{l.phone || 'No phone'}</div>
                    <div className="text-white/30 mt-0.5">{l.email || ''}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Stats */}
          <div className={`${CARD} ${LIFT} p-5 animate-fadeInUp`} style={{ animationDelay: '260ms' }}>
            <h2 className="text-white text-lg font-semibold mb-3">📈 Stats</h2>
            <div className="space-y-0.5 text-sm">
              {([
                ['Calls made', stats.total || calls.length, 'text-white'],
                ['Successful', stats.successful || 0, 'text-[#19C3E6]'],
                ['DND list', stats.blocked || 0, 'text-[#EF4444]'],
                ['Leads waiting', leads.length, 'text-white'],
                ['Campaigns', campaigns.length, 'text-white'],
                ['Businesses', Object.keys(scripts).length, 'text-white'],
                ['Model', 'Kimi K3', 'text-white'],
              ] as const).map(([label, value, cls]) => (
                <div key={label} className="flex justify-between rounded-lg px-2 -mx-2 py-1 transition-colors duration-200 hover:bg-white/[0.05]">
                  <span className="text-white/40">{label}</span>
                  <span className={`${cls} font-medium tabular-nums`}>{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Compliance summary */}
          {compliance && (
            <div className={`${CARD} ${LIFT} p-5 animate-fadeInUp`} style={{ animationDelay: '320ms' }}>
              <h2 className="text-white text-lg font-semibold mb-3">🛡 Compliance</h2>
              <div className="space-y-0.5 text-sm">
                {([
                  ['On DND list', compliance.dnd_total, { className: 'text-[#EF4444]' }],
                  ['Opted out on a call', compliance.opt_outs_this_call, { className: 'text-white' }],
                  ['Calls blocked', compliance.blocked_total, { style: { color: ORANGE } }],
                  ['Recording notices', compliance.recording_notices_total, { className: 'text-white' }],
                ] as [string, number, any][]).map(([label, value, props]) => (
                  <div key={label} className="flex justify-between rounded-lg px-2 -mx-2 py-1 transition-colors duration-200 hover:bg-white/[0.05]">
                    <span className="text-white/40">{label}</span>
                    <span {...props} className={`font-medium tabular-nums ${props.className || ''}`} >{value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Compliance log */}
      {compliance && (
        <div className={`${CARD} ${LIFT} p-5 animate-fadeInUp`} style={{ animationDelay: '400ms' }}>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-white text-lg font-semibold">🛡 Compliance Log</h2>
            <div className="flex gap-1">
              {([
                ['dnd', `DND opt-outs (${compliance.dnd_total})`],
                ['blocked', `Blocked calls (${compliance.blocked_total})`],
                ['notices', `Recording notices (${compliance.recording_notices_total})`],
              ] as const).map(([key, label]) => (
                <button key={key} onClick={() => setTab(key)}
                  className="text-[11px] px-3 py-1.5 rounded-lg border transition-all duration-200 ease-out hover:brightness-125"
                  style={tab === key
                    ? { color: ORANGE, borderColor: `${ORANGE}4D`, background: `${ORANGE}1A`,
                        boxShadow: `0 0 16px -6px ${ORANGE}99` }
                    : { color: 'rgba(255,255,255,0.4)', borderColor: 'rgba(255,255,255,0.08)' }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div key={tab} className="animate-[fadeInUp_0.25s_ease-out_both]">
          {tab === 'dnd' && (
            compliance.dnd.length === 0
              ? <div className="text-white/30 text-sm text-center py-6">No numbers on the do-not-call list.</div>
              : <div className="space-y-1.5">
                  {compliance.dnd.map((d, i) => (
                    <div key={i} className={`flex items-center justify-between bg-[#0A0A0F]/50 rounded-xl px-3 py-2 text-xs gap-3 ${ROW}`}>
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-[#EF4444]">⛔</span>
                        <span className="text-white/70 font-medium">{d.phone}</span>
                        <span className="text-white/35 truncate">
                          {d.source === 'call_opt_out' ? 'opted out on a call' : d.source}
                          {d.business && ` · ${d.business}`}
                        </span>
                      </div>
                      <span className={d.timestamp ? 'text-white/40 shrink-0' : 'text-white/25 italic shrink-0'}>{when(d.timestamp)}</span>
                    </div>
                  ))}
                </div>
          )}

          {tab === 'blocked' && (
            compliance.blocked.length === 0
              ? <div className="text-white/30 text-sm text-center py-6">No calls have been blocked.</div>
              : <>
                  <div className="text-white/35 text-[11px] mb-2">
                    {compliance.blocked_dnd} blocked by the do-not-call list · {compliance.blocked_max_attempts} by the 3-attempt limit
                  </div>
                  <div className="space-y-1.5">
                    {compliance.blocked.map((b, i) => (
                      <div key={i} className={`flex items-center justify-between bg-[#0A0A0F]/50 rounded-xl px-3 py-2 text-xs gap-3 ${ROW}`}>
                        <div className="flex items-center gap-3 min-w-0">
                          <span style={{ color: ORANGE }}>🚫</span>
                          <span className="text-white/70 font-medium">{b.phone}</span>
                          <span className="text-white/35 truncate">{b.business}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-white/40">{when(b.timestamp)}</span>
                          <span style={{ color: ORANGE }}>
                            {b.reason === 'max_attempts' ? '3-attempt limit' : b.reason === 'dnd' ? 'do-not-call' : b.reason}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
          )}

          {tab === 'notices' && (
            <>
              <div className="text-white/35 text-[11px] mb-2">
                "This call may be recorded for training purposes" — played at the start of every placed call.
                {compliance.recording_notices_unverified > 0 &&
                  ` ${compliance.recording_notices_unverified} earlier call(s) predate notice logging and can't be verified here.`}
              </div>
              {compliance.recording_notices.length === 0
                ? <div className="text-white/30 text-sm text-center py-6">No notices logged yet.</div>
                : <div className="space-y-1.5">
                    {compliance.recording_notices.map((n, i) => (
                      <div key={i} className={`flex items-center justify-between bg-[#0A0A0F]/50 rounded-xl px-3 py-2 text-xs gap-3 ${ROW}`}>
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-[#19C3E6]">🎙</span>
                          <span className="text-white/70 font-medium">{n.phone}</span>
                          <span className="text-white/35 truncate">{n.business}</span>
                        </div>
                        <span className="text-white/40 shrink-0">{when(n.timestamp)}</span>
                      </div>
                    ))}
                  </div>}
            </>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
