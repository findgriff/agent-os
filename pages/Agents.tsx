// Agents — roster grid with a per-agent detail drawer (certificate, soul,
// log, memory, inbox). Reads from api.agents(selectedTenant).
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Button, Badge, Toggle, Input, Select, Textarea, Drawer,
  EmptyState, SkeletonList, useToast, STATUS_TONE, TEAM_COLOUR, Icon,
} from '../components/ui';
import { Avatar } from '../components/Avatar';
import { useApp } from '../lib/store';
import { api, timeAgo } from '../lib/api';
import type { Agent, LogEntry, Memory, InboxMessage, Team, ModelName } from '../lib/types';

const TEAMS: Array<{ key: 'all' | Team; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'sales', label: 'Sales' },
  { key: 'technical', label: 'Technical' },
  { key: 'platform', label: 'Platform' },
];

const MODELS: ModelName[] = ['deepseek', 'claude', 'kimi'];

type Tab = 'certificate' | 'soul' | 'log' | 'memory' | 'inbox';
const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'certificate', label: 'Certificate', icon: 'verified' },
  { key: 'soul', label: 'Soul', icon: 'psychology' },
  { key: 'log', label: 'Log', icon: 'receipt_long' },
  { key: 'memory', label: 'Memory', icon: 'auto_awesome' },
  { key: 'inbox', label: 'Inbox', icon: 'mail' },
];

const isOn = (a: Agent) => !!a.enabled;

export default function Agents() {
  const { selectedTenant } = useApp();
  const navigate = useNavigate();
  const toast = useToast();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [team, setTeam] = useState<'all' | Team>('all');
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState<Record<number, boolean>>({});
  const [openId, setOpenId] = useState<number | null>(null);
  const [openTab, setOpenTab] = useState<Tab>('certificate');

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.agents(selectedTenant ?? undefined);
      setAgents(res.agents || []);
    } catch {
      setAgents([]);
      toast('Failed to load agents', 'danger');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [selectedTenant]);

  // Patch a single agent in local state.
  const patchAgent = (id: number, data: Partial<Agent>) =>
    setAgents(prev => prev.map(a => (a.id === id ? { ...a, ...data } : a)));

  const refreshOne = async (id: number) => {
    try {
      const res = await api.agent(id);
      if (res.agent) patchAgent(id, res.agent);
    } catch { /* ignore */ }
  };

  const runAgent = async (a: Agent) => {
    setRunning(r => ({ ...r, [a.id]: true }));
    try {
      const res = await api.runAgent(a.id);
      const summary = res?.result?.summary || res?.result?.message || 'Run complete';
      toast(String(summary), 'ok');
      await refreshOne(a.id);
    } catch {
      toast('Run failed', 'danger');
    }
    setRunning(r => ({ ...r, [a.id]: false }));
  };

  const toggle = async (a: Agent) => {
    try {
      const res = await api.toggleAgent(a.id);
      patchAgent(a.id, { enabled: res.enabled });
    } catch {
      toast('Could not toggle agent', 'danger');
    }
  };

  const changeModel = async (a: Agent, model: ModelName) => {
    patchAgent(a.id, { default_model: model });
    try {
      await api.updateAgent(a.id, { default_model: model });
      toast(`Model set to ${model}`, 'ok');
    } catch {
      toast('Could not update model', 'danger');
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter(a => {
      if (team !== 'all' && a.team !== team) return false;
      if (!q) return true;
      return [a.real_name, a.name, a.role].some(s => (s || '').toLowerCase().includes(q));
    });
  }, [agents, team, query]);

  const openAgent = agents.find(a => a.id === openId) || null;

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header + filter bar ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold text-ink">Agents</h1>
            <p className="text-sm text-muted">Your roster — souls, certificates and live status.</p>
          </div>
          <Button variant="secondary" icon="refresh" onClick={load} loading={loading}>Refresh</Button>
        </div>

        <Card glass className="flex flex-col gap-3 p-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {TEAMS.map(t => {
              const active = team === t.key;
              const colour = t.key !== 'all' ? TEAM_COLOUR[t.key] : undefined;
              return (
                <button key={t.key} onClick={() => setTeam(t.key)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-all
                    ${active ? 'border-white/20 bg-white/10 text-ink' : 'border-white/10 text-muted hover:text-ink hover:bg-white/5'}`}>
                  {colour && <span className="h-2 w-2 rounded-full" style={{ background: colour }} />}
                  {t.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 lg:w-64">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
                <Icon name="search" size={18} />
              </span>
              <Input value={query} onChange={e => setQuery(e.target.value)}
                placeholder="Search name or role…" className="pl-8" />
            </div>
            <Badge tone="neutral">{filtered.length} {filtered.length === 1 ? 'agent' : 'agents'}</Badge>
          </div>
        </Card>
      </div>

      {/* Grid ────────────────────────────────────────────────────────── */}
      {loading ? (
        <SkeletonList count={6} />
      ) : filtered.length === 0 ? (
        agents.length === 0 ? (
          <EmptyState icon="smart_toy" accent="#38BDF8" large
            title="Deploy your first agent"
            hint="Provision an agent to work inside a connected project — each agent gets a soul, certificate, memory, and inbox.">
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <Button variant="primary" icon="add" onClick={() => toast('Agent creation ready — connect a platform first', 'info')}>
                Deploy agent
              </Button>
              <Button variant="glass" icon="hub" onClick={() => navigate('/integrations')}>
                Connect platform
              </Button>
            </div>
          </EmptyState>
        ) : (
          <EmptyState icon="search" title="No matches"
            hint="Try a different team filter or search term." />
        )
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((a, i) => {
            const teamColour = a.team ? TEAM_COLOUR[a.team] : '#7B8DA8';
            return (
              <Card key={a.id} hover
                className="group cursor-pointer p-4 animate-fadeInUp transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_8px_32px_-8px_rgba(56,189,248,0.15)]"
                style={{ animationDelay: `${i * 50}ms` }}
                onClick={() => setOpenId(a.id)}>
                {/* Head */}
                <div className="flex items-start gap-3">
                  <Avatar size={42} colour={a.avatar_colour} initials={a.avatar_initials}
                    status={a.last_status} glow={a.last_status !== 'idle'} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-display font-semibold text-ink">{a.real_name || a.name}</div>
                    <div className="truncate text-xs text-muted">{a.role || a.slug}</div>
                  </div>
                  <Badge tone={STATUS_TONE[a.last_status]} dot>{a.last_status}</Badge>
                </div>

                {/* Meta badges */}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {a.tenant_name && <Badge tone="info">{a.tenant_name}</Badge>}
                  {a.team && (
                    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                      style={{ color: teamColour, borderColor: `${teamColour}44`, background: `${teamColour}1a` }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: teamColour }} />
                      {a.team}
                    </span>
                  )}
                </div>

                {/* Summary */}
                <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-sm text-muted">
                  {a.last_summary || 'No activity yet.'}
                </p>
                <div className="mt-1 flex items-center gap-1 text-[11px] text-muted/70">
                  <Icon name="schedule" size={13} /> {timeAgo(a.last_run_at)}
                </div>

                {/* Actions row (stop propagation so drawer doesn't open) */}
                <div className="mt-3 flex flex-wrap gap-1" onClick={e => e.stopPropagation()}>
                  <Button variant="ghost" icon="verified" className="px-2 py-1 text-xs"
                    onClick={() => { setOpenTab('certificate'); setOpenId(a.id); }}>Cert</Button>
                  <Button variant="ghost" icon="psychology" className="px-2 py-1 text-xs"
                    onClick={() => { setOpenTab('soul'); setOpenId(a.id); }}>Soul</Button>
                  <Button variant="ghost" icon="receipt_long" className="px-2 py-1 text-xs"
                    onClick={() => { setOpenTab('log'); setOpenId(a.id); }}>Log</Button>
                  <Button variant="ghost" icon="mail" className="px-2 py-1 text-xs"
                    onClick={() => { setOpenTab('inbox'); setOpenId(a.id); }}>Message</Button>
                  <Button variant="ghost" icon="play_arrow" className="px-2 py-1 text-xs"
                    loading={!!running[a.id]} onClick={() => runAgent(a)}>Run</Button>
                </div>

                {/* Footer controls */}
                <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-3"
                  onClick={e => e.stopPropagation()}>
                  {a.generates ? (
                    <Select value={a.default_model}
                      onChange={e => changeModel(a, e.target.value as ModelName)}>
                      {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                    </Select>
                  ) : <span className="text-[11px] text-muted/60">No generation</span>}
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted">{isOn(a) ? 'Enabled' : 'Disabled'}</span>
                    <Toggle checked={isOn(a)} onChange={() => toggle(a)} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Detail drawer ───────────────────────────────────────────────── */}
      <Drawer open={openId !== null} onClose={() => setOpenId(null)} width="max-w-lg">
        {openAgent && (
          <AgentDrawer key={openAgent.id} agent={openAgent} initialTab={openTab} onClose={() => setOpenId(null)} />
        )}
      </Drawer>
    </div>
  );
}

// ── Drawer body ───────────────────────────────────────────────────────
function AgentDrawer({ agent, onClose, initialTab = 'certificate' }: { agent: Agent; onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const teamColour = agent.team ? TEAM_COLOUR[agent.team] : '#7B8DA8';

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-white/10 p-5">
        <Avatar size={56} colour={agent.avatar_colour} initials={agent.avatar_initials}
          status={agent.last_status} glow={agent.last_status !== 'idle'} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-lg font-bold text-ink">{agent.real_name || agent.name}</div>
          <div className="truncate text-sm text-muted">{agent.role || agent.slug}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {agent.tenant_name && <Badge tone="info">{agent.tenant_name}</Badge>}
            {agent.team && (
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
                style={{ color: teamColour, borderColor: `${teamColour}44`, background: `${teamColour}1a` }}>
                {agent.team}
              </span>
            )}
            <Badge tone={STATUS_TONE[agent.last_status]} dot>{agent.last_status}</Badge>
          </div>
        </div>
        <button onClick={onClose} className="text-muted hover:text-ink"><Icon name="close" /></button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-white/10 px-3">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors
              ${tab === t.key ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}>
            <Icon name={t.icon} size={16} /> {t.label}
          </button>
        ))}
      </div>

      {/* Panels */}
      <div className="flex-1 overflow-y-auto p-5">
        {tab === 'certificate' && <CertificatePanel agent={agent} />}
        {tab === 'soul' && <SoulPanel agent={agent} />}
        {tab === 'log' && <LogPanel agent={agent} />}
        {tab === 'memory' && <MemoryPanel agent={agent} />}
        {tab === 'inbox' && <InboxPanel agent={agent} />}
      </div>
    </div>
  );
}

// ── Certificate ───────────────────────────────────────────────────────
function CertificatePanel({ agent }: { agent: Agent }) {
  const cert = agent.certificate || {};
  const keys = Object.keys(cert);
  if (keys.length === 0) {
    return <EmptyState icon="verified" title="No certificate" hint="This agent has no certificate defined." />;
  }
  const renderVal = (v: any) => {
    if (Array.isArray(v)) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {v.map((x, i) => <Badge key={i} tone="violet">{String(typeof x === 'object' ? JSON.stringify(x) : x)}</Badge>)}
        </div>
      );
    }
    if (v && typeof v === 'object') {
      return <pre className="whitespace-pre-wrap break-words font-mono text-xs text-ink/90">{JSON.stringify(v, null, 2)}</pre>;
    }
    return <span className="text-sm text-ink">{String(v)}</span>;
  };
  return (
    <div className="space-y-4">
      {keys.map(k => (
        <div key={k}>
          <div className="mb-1.5 font-display text-xs font-semibold uppercase tracking-wider text-muted">
            {k.replace(/_/g, ' ')}
          </div>
          {renderVal((cert as any)[k])}
        </div>
      ))}
      <details className="rounded-xl border border-white/10 bg-black/30 p-3">
        <summary className="cursor-pointer text-xs font-semibold text-muted">Raw JSON</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-ink/80">
          {JSON.stringify(cert, null, 2)}
        </pre>
      </details>
    </div>
  );
}

// ── Soul ──────────────────────────────────────────────────────────────
function SoulPanel({ agent }: { agent: Agent }) {
  const toast = useToast();
  const [text, setText] = useState(agent.soul_text || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateAgent(agent.id, { soul_text: text });
      toast('Soul saved', 'ok');
    } catch {
      toast('Could not save soul', 'danger');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">The agent's persona and guiding voice.</p>
      <Textarea value={text} onChange={e => setText(e.target.value)} rows={14}
        placeholder="Describe this agent's soul…" className="font-mono" />
      <div className="flex justify-end">
        <Button variant="primary" icon="save" loading={saving} onClick={save}>Save soul</Button>
      </div>
    </div>
  );
}

// ── Log ───────────────────────────────────────────────────────────────
function LogPanel({ agent }: { agent: Agent }) {
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try { const res = await api.agentLog(agent.id); if (alive) setLogs(res.logs || []); }
      catch { if (alive) setLogs([]); }
    })();
    return () => { alive = false; };
  }, [agent.id]);

  if (logs === null) return <SkeletonList count={5} />;
  if (logs.length === 0) return <EmptyState icon="receipt_long" title="No log entries" hint="This agent hasn't run yet." />;
  return (
    <div className="space-y-2">
      {logs.map(l => (
        <div key={l.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <Badge tone="info">{l.action}</Badge>
            <span className="text-[11px] text-muted/70">{timeAgo(l.created_at)}</span>
          </div>
          {l.summary && <div className="mt-1.5 text-sm text-ink">{l.summary}</div>}
          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1"><Icon name="toll" size={13} />{l.token_count?.toLocaleString() ?? 0} tok</span>
            <span className="inline-flex items-center gap-1"><Icon name="payments" size={13} />${(l.cost_usd ?? 0).toFixed(4)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Memory ────────────────────────────────────────────────────────────
function MemoryPanel({ agent }: { agent: Agent }) {
  const toast = useToast();
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [topic, setTopic] = useState('');
  const [fact, setFact] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try { const res = await api.agentMemory(agent.id); setMemories(res.memories || []); }
    catch { setMemories([]); }
  };
  useEffect(() => { setMemories(null); load(); /* eslint-disable-next-line */ }, [agent.id]);

  const write = async () => {
    if (!topic.trim() || !fact.trim()) { toast('Topic and fact are required', 'warn'); return; }
    setSaving(true);
    try {
      await api.writeMemory(agent.id, { topic: topic.trim(), fact: fact.trim() });
      toast('Memory written', 'ok');
      setTopic(''); setFact('');
      await load();
    } catch {
      toast('Could not write memory', 'danger');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      {/* Write form */}
      <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
        <div className="font-display text-xs font-semibold uppercase tracking-wider text-muted">Write a memory</div>
        <Input value={topic} onChange={e => setTopic(e.target.value)} placeholder="Topic" />
        <Textarea value={fact} onChange={e => setFact(e.target.value)} rows={3} placeholder="Fact…" />
        <div className="flex justify-end">
          <Button variant="secondary" icon="add" loading={saving} onClick={write}>Add memory</Button>
        </div>
      </div>

      {/* List */}
      {memories === null ? <SkeletonList count={4} />
        : memories.length === 0 ? <EmptyState icon="auto_awesome" title="No memories" hint="This agent hasn't learned anything yet." />
        : (
          <div className="space-y-2">
            {memories.map(m => (
              <div key={m.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone="violet">{m.topic}</Badge>
                  <span className="text-[11px] text-muted/70">{Math.round((m.confidence ?? 0) * 100)}%</span>
                </div>
                <div className="mt-1.5 text-sm text-ink">{m.fact}</div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

// ── Inbox ─────────────────────────────────────────────────────────────
function InboxPanel({ agent }: { agent: Agent }) {
  const toast = useToast();
  const [messages, setMessages] = useState<InboxMessage[] | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const load = async () => {
    try { const res = await api.agentInbox(agent.id); setMessages(res.messages || []); }
    catch { setMessages([]); }
  };
  useEffect(() => { setMessages(null); load(); /* eslint-disable-next-line */ }, [agent.id]);

  const send = async () => {
    if (!subject.trim() || !body.trim()) { toast('Subject and body are required', 'warn'); return; }
    setSending(true);
    try {
      await api.sendMessage(agent.id, { subject: subject.trim(), body: body.trim() });
      toast('Message sent', 'ok');
      setSubject(''); setBody('');
      await load();
    } catch {
      toast('Could not send message', 'danger');
    }
    setSending(false);
  };

  return (
    <div className="space-y-4">
      {/* Compose */}
      <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
        <div className="font-display text-xs font-semibold uppercase tracking-wider text-muted">Send a message</div>
        <Input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject" />
        <Textarea value={body} onChange={e => setBody(e.target.value)} rows={3} placeholder="Message…" />
        <div className="flex justify-end">
          <Button variant="secondary" icon="send" loading={sending} onClick={send}>Send</Button>
        </div>
      </div>

      {/* Thread */}
      {messages === null ? <SkeletonList count={4} />
        : messages.length === 0 ? <EmptyState icon="mail" title="Inbox empty" hint="No messages for this agent yet." />
        : (
          <div className="space-y-2">
            {messages.map(m => (
              <div key={m.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-ink">{m.from_real || m.from_name || 'System'}</span>
                  <span className="text-[11px] text-muted/70">{timeAgo(m.created_at)}</span>
                </div>
                {m.subject && <div className="mt-1 text-sm font-medium text-accent">{m.subject}</div>}
                {m.body && <div className="mt-1 text-sm text-muted">{m.body}</div>}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
