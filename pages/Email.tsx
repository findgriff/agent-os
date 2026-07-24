// Email — a three-pane agent mail client. Left: folders + metrics + connected
// mailboxes. Middle: the inbox list for the active folder. Right: the open
// message with reply / mark / archive actions. Talks to /api/email/*.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Icon, Button, Badge, Field, Input, Textarea, Select, Modal,
  EmptyState, SkeletonList, useToast, useCountUp,
} from '../components/ui';
import { Avatar } from '../components/Avatar';
import { useApp } from '../lib/store';
import { api, timeAgo } from '../lib/api';
import type { AgentEmail, EmailMetrics, EmailStatus, Agent } from '../lib/types';

const TEAL = '#14B8A6'; // feature accent

type FolderKey = 'inbox' | 'unread' | 'replied' | 'archived' | 'sent';
const FOLDERS: Array<{ key: FolderKey; label: string; icon: string }> = [
  { key: 'inbox',    label: 'Inbox',    icon: 'inbox' },
  { key: 'unread',   label: 'Unread',   icon: 'mark_email_unread' },
  { key: 'replied',  label: 'Replied',  icon: 'reply' },
  { key: 'archived', label: 'Archived', icon: 'archive' },
  { key: 'sent',     label: 'Sent',     icon: 'send' },
];

const mailbox = (a: Agent) => `${a.slug}@agent-os.ai`;
const asPct = (v: number) => Math.round(v <= 1 ? v * 100 : v);
const snippet = (s?: string | null) => (s || '').replace(/\s+/g, ' ').trim();

export default function Email() {
  const { selectedTenant } = useApp();
  const toast = useToast();

  const [folder, setFolder] = useState<FolderKey>('inbox');
  const [emails, setEmails] = useState<AgentEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [metrics, setMetrics] = useState<EmailMetrics | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // compose / reply modal
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyToId, setReplyToId] = useState<number | null>(null);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [fromAgentId, setFromAgentId] = useState<number | null>(null);
  const [sending, setSending] = useState(false);

  // connect-account stub modal
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectAddr, setConnectAddr] = useState('');
  const [connectProvider, setConnectProvider] = useState('gmail');

  const refreshMetrics = useCallback(() => {
    api.emailMetrics(selectedTenant ?? undefined).then(setMetrics)
      .catch(() => toast('Failed to load email metrics', 'danger'));
  }, [selectedTenant, toast]);

  const loadEmails = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setError(false); }
    try {
      const params: { tenant_id?: number; status?: string } = {};
      if (selectedTenant != null) params.tenant_id = selectedTenant;
      if (folder !== 'inbox') params.status = folder;
      const res = await api.emailInbox(params);
      setEmails(res.emails || []);
    } catch {
      if (!silent) { setEmails([]); setError(true); }
      toast('Failed to load emails', 'danger');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [folder, selectedTenant, toast]);

  useEffect(() => { loadEmails(); }, [loadEmails]);
  useEffect(() => {
    refreshMetrics();
    api.agents(selectedTenant ?? undefined).then(r => setAgents(r.agents || []))
      .catch(() => toast('Failed to load mailboxes', 'danger'));
  }, [selectedTenant, refreshMetrics, toast]);

  const selected = useMemo(
    () => emails.find(e => e.id === selectedId) || null,
    [emails, selectedId],
  );

  // metric count-ups
  const cSent   = useCountUp(metrics?.sent_today ?? 0);
  const cReply  = useCountUp(metrics ? asPct(metrics.reply_rate) : 0);
  const cBounce = useCountUp(metrics ? asPct(metrics.bounce_rate) : 0);
  const cUnread = useCountUp(metrics?.unread ?? 0);
  const unread  = metrics?.unread ?? 0;

  const setStatusLocal = (id: number, status: EmailStatus) =>
    setEmails(list => list.map(e => (e.id === id ? { ...e, status } : e)));

  const selectFolder = (f: FolderKey) => { setFolder(f); setSelectedId(null); };

  const openEmail = (em: AgentEmail) => {
    setSelectedId(em.id);
    if (em.status === 'unread') {
      setStatusLocal(em.id, 'read'); // optimistic
      api.updateEmailStatus(em.id, 'read')
        .then(() => refreshMetrics())
        .catch(() => { setStatusLocal(em.id, 'unread'); toast('Could not mark as read', 'danger'); });
    }
  };

  const toggleRead = async (em: AgentEmail) => {
    const next: EmailStatus = em.status === 'unread' ? 'read' : 'unread';
    setStatusLocal(em.id, next);
    try { await api.updateEmailStatus(em.id, next); refreshMetrics(); }
    catch { setStatusLocal(em.id, em.status); toast('Update failed', 'danger'); }
  };

  const archiveEmail = async (em: AgentEmail) => {
    setStatusLocal(em.id, 'archived');
    setSelectedId(null);
    try {
      await api.updateEmailStatus(em.id, 'archived');
      toast('Message archived', 'ok');
      refreshMetrics();
      loadEmails(true);
    } catch {
      setStatusLocal(em.id, em.status);
      toast('Archive failed', 'danger');
    }
  };

  const openCompose = () => {
    setReplyToId(null);
    setTo(''); setSubject(''); setBody('');
    setFromAgentId(agents[0]?.id ?? null);
    setComposeOpen(true);
  };

  const openReply = (em: AgentEmail) => {
    setReplyToId(em.id);
    setTo(em.from_address || '');
    const s = em.subject || '';
    setSubject(/^re:/i.test(s) ? s : `Re: ${s || '(no subject)'}`);
    setBody('');
    const match = agents.find(a => a.id === em.to_agent_id);
    setFromAgentId(match ? match.id : (agents[0]?.id ?? null));
    setComposeOpen(true);
  };

  const send = async () => {
    if (!to.trim())      { toast('Add a recipient', 'warn'); return; }
    if (!subject.trim()) { toast('Add a subject', 'warn'); return; }
    setSending(true);
    try {
      await api.sendEmail({
        to: to.trim(),
        subject: subject.trim(),
        body: body.trim(),
        from_agent_id: fromAgentId ?? undefined,
        tenant_id: selectedTenant ?? undefined,
      });
      if (replyToId != null) {
        setStatusLocal(replyToId, 'replied');
        api.updateEmailStatus(replyToId, 'replied').catch(() => {});
      }
      toast('Email sent', 'ok');
      setComposeOpen(false);
      refreshMetrics();
      loadEmails(true);
    } catch (e: any) {
      toast(e?.message || 'Failed to send email', 'danger');
    } finally {
      setSending(false);
    }
  };

  const composeBtnStyle = { background: TEAL, color: '#04222b', boxShadow: `0 0 22px ${TEAL}59` };

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ──────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center gap-3 border-b border-white/6 px-4 py-4 md:px-6 animate-fadeInUp">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl"
          style={{ background: `${TEAL}1a`, color: TEAL, boxShadow: `0 0 26px -8px ${TEAL}` }}>
          <Icon name="mail" size={24} />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold text-ink">Email</h1>
          <p className="truncate text-xs text-muted">
            Agent mailboxes{metrics ? ` · ${metrics.received} received · ${unread} unread` : ''}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" icon="refresh" title="Refresh" aria-label="Refresh"
            className="!px-2.5" loading={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try { await loadEmails(); refreshMetrics(); }
              finally { setRefreshing(false); }
            }} />
          <Button variant="primary" icon="edit_note" onClick={openCompose} style={composeBtnStyle}>
            Compose
          </Button>
        </div>
      </header>

      {/* ── Body ────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* LEFT RAIL (lg+) */}
        <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-r border-white/6 bg-surface/30 p-4 lg:flex">
          <Button variant="primary" icon="edit_note" onClick={openCompose}
            style={composeBtnStyle} className="w-full py-2.5">
            Compose
          </Button>

          {/* Folders */}
          <div className="space-y-1">
            {FOLDERS.map(f => {
              const active = folder === f.key;
              return (
                <button key={f.key} onClick={() => selectFolder(f.key)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm transition-all
                    ${active ? 'bg-white/10 text-ink' : 'text-muted hover:bg-white/5 hover:text-ink'}`}>
                  <Icon name={f.icon} size={19} fill={active} style={active ? { color: TEAL } : undefined} />
                  <span className="flex-1 text-left font-medium">{f.label}</span>
                  {f.key === 'inbox' && unread > 0 && (
                    <span className="rounded-full px-2 py-0.5 text-[11px] font-bold"
                      style={{ background: `${TEAL}22`, color: TEAL }}>{unread}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Metrics */}
          <div>
            <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted/70">Overview</div>
            <div className="grid grid-cols-2 gap-2">
              <MetricTile icon="send"              label="Sent today"  value={cSent}         accent={TEAL} />
              <MetricTile icon="reply"             label="Reply rate"  value={`${cReply}%`}  accent="#38BDF8" />
              <MetricTile icon="cancel"            label="Bounce rate" value={`${cBounce}%`} accent="#F43F5E" />
              <MetricTile icon="mark_email_unread" label="Unread"      value={cUnread}       accent="#F59E0B" />
            </div>
          </div>

          {/* Connected accounts */}
          <div>
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted/70">Connected</span>
              <button onClick={() => setConnectOpen(true)}
                className="flex items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-ink">
                <Icon name="add" size={14} /> Connect
              </button>
            </div>
            <div className="space-y-1">
              {agents.length === 0 && (
                <div className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-xs text-muted">
                  No mailboxes yet
                </div>
              )}
              {agents.map(a => (
                <div key={a.id} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/5">
                  <Avatar colour={a.avatar_colour} initials={a.avatar_initials} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-ink">{a.real_name || a.name}</div>
                    <div className="truncate text-[11px] text-muted">{mailbox(a)}</div>
                  </div>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-emerald shadow-[0_0_8px_#22C55E]" title="Connected" />
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* MIDDLE — inbox list */}
        <section className={`w-full flex-col overflow-hidden border-white/6 md:w-[340px] md:shrink-0 md:border-r lg:w-[380px]
          ${selectedId ? 'hidden md:flex' : 'flex'}`}>
          {/* list header + mobile folder chips */}
          <div className="shrink-0 border-b border-white/6 px-3 py-3">
            <div className="flex items-center gap-2 px-1">
              <Icon name={FOLDERS.find(f => f.key === folder)?.icon || 'inbox'} size={18} style={{ color: TEAL }} />
              <h2 className="font-display text-sm font-semibold capitalize text-ink">{folder}</h2>
              <span className="text-xs text-muted">· {emails.length}</span>
            </div>
            <div className="-mx-1 mt-2 flex gap-1.5 overflow-x-auto px-1 lg:hidden">
              {FOLDERS.map(f => {
                const active = folder === f.key;
                return (
                  <button key={f.key} onClick={() => selectFolder(f.key)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-all
                      ${active ? 'border-transparent' : 'border-white/10 text-muted hover:text-ink'}`}
                    style={active ? { background: `${TEAL}1f`, color: TEAL } : undefined}>
                    <Icon name={f.icon} size={14} />{f.label}
                    {f.key === 'inbox' && unread > 0 && <span className="font-bold"> · {unread}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* rows */}
          <div className="flex-1 overflow-y-auto p-2">
            {loading ? (
              <SkeletonList count={6} />
            ) : error ? (
              <EmptyState icon="cloud_off" title="Couldn't load mail"
                hint="Something went wrong reaching the server."
                action={<Button icon="refresh" onClick={() => loadEmails()}>Retry</Button>} />
            ) : emails.length === 0 ? (
              <EmptyState icon={FOLDERS.find(f => f.key === folder)?.icon || 'inbox'} accent={TEAL}
                title={folder === 'inbox' ? 'Inbox zero' : `No ${folder} mail`}
                hint={folder === 'sent' ? 'Messages your agents send appear here.' : 'Nothing to show in this folder yet.'} />
            ) : (
              <div className="space-y-1.5">
                {emails.map((em, i) => {
                  const isUnread = em.status === 'unread';
                  const isActive = em.id === selectedId;
                  const primary = folder === 'sent'
                    ? `To ${em.to_address || '—'}`
                    : (em.from_address || 'Unknown sender');
                  return (
                    <button key={em.id} onClick={() => openEmail(em)}
                      className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-all animate-fadeInUp
                        ${isActive
                          ? 'border-white/15 bg-white/10'
                          : 'border-transparent hover:border-white/10 hover:bg-white/5'}`}
                      style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>
                      <div className="flex shrink-0 flex-col items-center gap-2 pt-0.5">
                        <span className="h-2 w-2 rounded-full"
                          style={{ background: isUnread ? TEAL : 'transparent',
                                   boxShadow: isUnread ? `0 0 8px ${TEAL}` : undefined }} />
                        <Avatar colour={em.agent_colour} initials={em.agent_initials || undefined} size={30} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`min-w-0 flex-1 truncate text-sm ${isUnread ? 'font-bold text-ink' : 'font-medium text-ink/85'}`}>
                            {primary}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted">{timeAgo(em.created_at)}</span>
                        </div>
                        <div className={`mt-0.5 truncate text-[13px] ${isUnread ? 'font-semibold text-ink' : 'text-ink/70'}`}>
                          {em.subject || '(no subject)'}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs text-muted">
                            {snippet(em.body) || 'No preview'}
                          </span>
                          <StatusBadge status={em.status} />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* RIGHT — detail */}
        <section className={`min-w-0 flex-1 flex-col overflow-hidden bg-black/20
          ${selectedId ? 'flex' : 'hidden md:flex'}`}>
          {selected ? (
            <>
              <div className="flex shrink-0 items-center gap-1 border-b border-white/6 px-3 py-2.5 md:px-5">
                <button onClick={() => setSelectedId(null)} aria-label="Back"
                  className="mr-1 grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-white/5 hover:text-ink md:hidden">
                  <Icon name="arrow_back" size={20} />
                </button>
                <div className="flex-1" />
                {selected.status !== 'sent' && (
                  <Button variant="ghost" icon="reply" title="Reply" onClick={() => openReply(selected)}>
                    <span className="hidden lg:inline">Reply</span>
                  </Button>
                )}
                {selected.status !== 'sent' && (
                  <Button variant="ghost"
                    icon={selected.status === 'unread' ? 'mark_email_read' : 'mark_email_unread'}
                    title={selected.status === 'unread' ? 'Mark read' : 'Mark unread'}
                    onClick={() => toggleRead(selected)}>
                    <span className="hidden lg:inline">{selected.status === 'unread' ? 'Mark read' : 'Mark unread'}</span>
                  </Button>
                )}
                <Button variant="ghost" icon="archive" title="Archive" onClick={() => archiveEmail(selected)}>
                  <span className="hidden lg:inline">Archive</span>
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-6 animate-fadeInUp">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-display text-xl font-bold leading-snug text-ink md:text-2xl">
                    {selected.subject || '(no subject)'}
                  </h2>
                  <StatusBadge status={selected.status} />
                </div>

                <div className="mt-5 flex items-start gap-3">
                  <Avatar colour={selected.agent_colour} initials={selected.agent_initials || undefined} size={44} glow />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2">
                      <span className="font-semibold text-ink">{selected.from_address || 'Unknown sender'}</span>
                      {selected.agent_name && <span className="text-xs text-muted">· {selected.agent_name}</span>}
                    </div>
                    <div className="truncate text-xs text-muted">to {selected.to_address || '—'}</div>
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-muted">
                    <div>{new Date(selected.created_at * 1000).toLocaleString()}</div>
                    <div>{timeAgo(selected.created_at)}</div>
                  </div>
                </div>

                <div className="mt-6 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink/90">
                  {selected.body || <span className="text-muted">This message has no content.</span>}
                </div>

                {selected.status !== 'sent' && (
                  <div className="mt-8 border-t border-white/6 pt-5">
                    <Button variant="secondary" icon="reply" onClick={() => openReply(selected)}>Reply</Button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center p-6">
              <EmptyState icon="drafts" accent={TEAL}
                title="No message selected"
                hint="Pick a conversation from the list to read it here." />
            </div>
          )}
        </section>
      </div>

      {/* ── Compose / Reply modal ───────────────────────────────── */}
      <Modal open={composeOpen} onClose={() => setComposeOpen(false)}
        title={replyToId != null ? 'Reply' : 'New message'} width="max-w-xl">
        <div className="space-y-3">
          <Field label="To">
            <Input value={to} type="email" placeholder="name@company.com" onChange={e => setTo(e.target.value)} />
          </Field>
          <Field label="From">
            <Select className="w-full" value={fromAgentId == null ? '' : String(fromAgentId)}
              onChange={e => setFromAgentId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Default mailbox</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{(a.real_name || a.name)} · {mailbox(a)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Subject">
            <Input value={subject} placeholder="Subject line" onChange={e => setSubject(e.target.value)} />
          </Field>
          <Field label="Message">
            <Textarea value={body} rows={8} placeholder="Write your message…"
              className="resize-none" onChange={e => setBody(e.target.value)} />
          </Field>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setComposeOpen(false)}>Cancel</Button>
            <Button variant="primary" icon="send" loading={sending} onClick={send} style={composeBtnStyle}>
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Connect account (stub) modal ────────────────────────── */}
      <Modal open={connectOpen} onClose={() => setConnectOpen(false)} title="Connect a mailbox">
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Link an external inbox so agents can send and receive from it. This is a preview — no live connection is made.
          </p>
          <Field label="Provider">
            <Select className="w-full" value={connectProvider} onChange={e => setConnectProvider(e.target.value)}>
              <option value="gmail">Gmail</option>
              <option value="outlook">Outlook</option>
              <option value="imap">IMAP / SMTP</option>
            </Select>
          </Field>
          <Field label="Email address">
            <Input value={connectAddr} type="email" placeholder="you@company.com"
              onChange={e => setConnectAddr(e.target.value)} />
          </Field>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setConnectOpen(false)}>Cancel</Button>
            <Button variant="primary" icon="link" style={{ background: TEAL, color: '#04222b' }}
              onClick={() => {
                if (!connectAddr.trim()) { toast('Enter an email address', 'warn'); return; }
                toast(`Connection request queued for ${connectAddr.trim()}`, 'ok');
                setConnectOpen(false); setConnectAddr('');
              }}>
              Connect
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────
function StatusBadge({ status }: { status: EmailStatus }) {
  switch (status) {
    case 'replied':  return <Badge tone="info" dot>Replied</Badge>;
    case 'archived': return <Badge tone="neutral">Archived</Badge>;
    case 'bounced':  return <Badge tone="danger" dot>Bounced</Badge>;
    case 'sent':     return <Badge tone="violet">Sent</Badge>;
    default:         return null;
  }
}

function MetricTile({ icon, label, value, accent }:
  { icon: string; label: string; value: string | number; accent: string }) {
  return (
    <div className="glass rounded-xl p-3">
      <div className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: `${accent}1a`, color: accent }}>
        <Icon name={icon} size={16} />
      </div>
      <div className="mt-2 font-display text-xl font-bold leading-none text-ink">{value}</div>
      <div className="mt-1 text-[11px] text-muted">{label}</div>
    </div>
  );
}
