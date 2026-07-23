// War Room — live group chat where the operator rallies colour-coded AI agents.
// Left: room list. Right: participants bar + message thread + @mention composer.
// Talks to /api/chat/rooms{,/:id/messages,/:id/summarize}. Operator messages
// send with no from_agent_id; an @mention triggers backend AI replies.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import {
  Badge, Button, EmptyState, Icon, Input, Modal, SkeletonList, useToast,
} from '../components/ui';
import { api, timeAgo } from '../lib/api';
import { useApp } from '../lib/store';
import type { Agent, Room, RoomMessage } from '../lib/types';

const FEATURE = '#EF4444';      // nav colour for the war-room feature
const OPERATOR = '#7B8DA8';     // muted — the human operator

// Derive up-to-two-letter initials from a display name.
const initialsOf = (name: string) =>
  (name || '')
    .split(/\s+/).filter(Boolean).slice(0, 2)
    .map(w => w[0]).join('').toUpperCase() || '··';

// Highlight @mentions inside a message body (React nodes — no raw HTML).
function withMentions(text: string) {
  return text.split(/(@[^\s@]+)/g).map((part, i) =>
    part.startsWith('@') && part.length > 1
      ? <span key={i} className="font-semibold underline decoration-dotted underline-offset-2">{part}</span>
      : <span key={i}>{part}</span>,
  );
}

type MentionState = { open: boolean; query: string; start: number };

export default function WarRoom() {
  const toast = useToast();
  const { selectedTenant } = useApp();

  // ── Rooms + directory ──────────────────────────────────────────────────
  const [rooms, setRooms] = useState<Room[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [activeRoomId, setActiveRoomId] = useState<number | null>(null);

  // ── Active thread ──────────────────────────────────────────────────────
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [typing, setTyping] = useState(false);
  const [pending, setPending] = useState<Agent[]>([]);

  // ── Composer + @mention popup ──────────────────────────────────────────
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<MentionState>({ open: false, query: '', start: 0 });
  const [mentionIdx, setMentionIdx] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // ── Modals ─────────────────────────────────────────────────────────────
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summary, setSummary] = useState('');
  const [summarizing, setSummarizing] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);

  const activeRoom = useMemo(
    () => rooms.find(r => r.id === activeRoomId) ?? null,
    [rooms, activeRoomId],
  );

  // Load rooms + agent directory whenever the project changes.
  useEffect(() => {
    let alive = true;
    setLoadingRooms(true);
    setActiveRoomId(null);
    setMessages([]);
    Promise.all([
      api.chatRooms(selectedTenant ?? undefined),
      api.agents(selectedTenant ?? undefined),
    ])
      .then(([r, a]) => { if (alive) { setRooms(r.rooms); setAgents(a.agents); } })
      .catch(() => { if (alive) toast('Could not load war rooms', 'danger'); })
      .finally(() => { if (alive) setLoadingRooms(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTenant]);

  // On desktop, drop straight into the most recent room.
  useEffect(() => {
    if (!activeRoomId && rooms.length && window.matchMedia('(min-width: 768px)').matches) {
      setActiveRoomId(rooms[0].id);
    }
  }, [rooms, activeRoomId]);

  // Load the thread for the active room.
  useEffect(() => {
    if (!activeRoomId) { setMessages([]); return; }
    let alive = true;
    setLoadingMsgs(true);
    setTyping(false);
    api.roomMessages(activeRoomId)
      .then(r => {
        if (!alive) return;
        setMessages(r.messages);
        setRooms(rs => rs.map(x => x.id === r.room.id ? { ...x, ...r.room } : x));
      })
      .catch(() => { if (alive) toast('Could not load messages', 'danger'); })
      .finally(() => { if (alive) setLoadingMsgs(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId]);

  // Keep the newest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, typing]);

  // Which known agents are @mentioned in a body of text.
  const mentionedIn = (text: string): Agent[] => {
    const t = text.toLowerCase();
    return agents.filter(a => {
      const rn = (a.real_name || a.name || '').toLowerCase();
      const sl = (a.slug || '').toLowerCase();
      return (!!sl && t.includes('@' + sl)) || (!!rn && t.includes('@' + rn));
    });
  };

  const mentionMatches = useMemo(() => {
    if (!mention.open) return [];
    const q = mention.query.toLowerCase();
    return agents.filter(a => {
      const rn = (a.real_name || a.name || '').toLowerCase();
      const sl = (a.slug || '').toLowerCase();
      return !q || rn.includes(q) || sl.includes(q);
    }).slice(0, 6);
  }, [mention.open, mention.query, agents]);

  // Detect the "@token" being typed at the caret.
  const syncMention = (value: string, caret: number) => {
    const m = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    if (m && agents.length) {
      setMention({ open: true, query: m[1], start: caret - m[1].length - 1 });
      setMentionIdx(0);
    } else {
      setMention(prev => (prev.open ? { open: false, query: '', start: 0 } : prev));
    }
  };

  const closeMention = () => setMention({ open: false, start: 0, query: '' });

  const handleDeleteRoom = async (id: number, name: string) => {
    if (!confirm(`Delete "${name}" and all its messages?`)) return;
    try {
      await api.deleteChatRoom(id);
      setRooms(prev => prev.filter(r => r.id !== id));
      if (activeRoomId === id) setActiveRoomId(null);
      toast('Room deleted', 'ok');
    } catch { toast('Could not delete room', 'danger'); }
  };

  const insertMention = (a?: Agent) => {
    if (!a) return;
    const el = composerRef.current;
    const caret = el?.selectionStart ?? input.length;
    const name = a.real_name || a.name || a.slug;
    const before = input.slice(0, mention.start);
    const token = `@${name} `;
    const next = before + token + input.slice(caret);
    setInput(next);
    closeMention();
    requestAnimationFrame(() => {
      const pos = before.length + token.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.open && mentionMatches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => (i + 1) % mentionMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx(i => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(mentionMatches[Math.min(mentionIdx, mentionMatches.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeMention(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !activeRoom || sending) return;
    const mentioned = mentionedIn(text);
    const willReply = mentioned.length > 0;

    const optimistic: RoomMessage = {
      id: -Date.now(), room_id: activeRoom.id, from_agent_id: null,
      from_name: 'Operator', text, created_at: Math.floor(Date.now() / 1000),
      colour: OPERATOR, initials: 'OP',
    };
    setMessages(m => [...m, optimistic]);
    setInput('');
    closeMention();
    setSending(true);
    if (willReply) { setTyping(true); setPending(mentioned); }

    try {
      const res = await api.sendRoomMessage(activeRoom.id, { text, reply: willReply });
      setMessages(m => [...m.filter(x => x.id !== optimistic.id), res.message, ...res.replies]);
      // Keep the sidebar counts / ordering fresh.
      api.chatRooms(selectedTenant ?? undefined).then(r => setRooms(r.rooms)).catch(() => {});
    } catch (e: any) {
      setMessages(m => m.filter(x => x.id !== optimistic.id));
      setInput(text);
      toast(e?.message || 'Message failed — please retry', 'danger');
    } finally {
      setSending(false);
      setTyping(false);
      setPending([]);
    }
  };

  const createRoom = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const { room } = await api.createRoom({ name, tenant_id: selectedTenant ?? undefined });
      setRooms(rs => [room, ...rs.filter(r => r.id !== room.id)]);
      setActiveRoomId(room.id);
      setNewOpen(false);
      setNewName('');
      toast('War room created', 'ok');
    } catch (e: any) {
      toast(e?.message || 'Could not create room', 'danger');
    } finally {
      setCreating(false);
    }
  };

  const summarize = async () => {
    if (!activeRoom || summarizing) return;
    setSummarizing(true);
    try {
      const { summary: s } = await api.chatSummarize(activeRoom.id);
      setSummary(s);
      setSummaryOpen(true);
    } catch (e: any) {
      toast(e?.message || 'Could not summarise room', 'danger');
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── LEFT: room list ─────────────────────────────────────────────── */}
      <aside className={`${activeRoomId ? 'hidden' : 'flex'} w-full shrink-0 flex-col border-r border-white/8 md:flex md:w-72 lg:w-80`}>
        <header className="flex items-center justify-between gap-2 border-b border-white/8 px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
              style={{ background: `${FEATURE}1a`, color: FEATURE }}>
              <Icon name="groups" size={20} />
            </div>
            <div className="min-w-0">
              <h1 className="font-display text-base font-bold leading-tight text-ink">War Room</h1>
              <p className="text-[11px] text-muted">{rooms.length} room{rooms.length === 1 ? '' : 's'}</p>
            </div>
          </div>
          <Button variant="glass" icon="add" onClick={() => setNewOpen(true)} className="!px-2.5">New</Button>
        </header>

        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {loadingRooms ? (
            <SkeletonList count={6} />
          ) : rooms.length === 0 ? (
            <EmptyState icon="forum" title="No war rooms yet" accent={FEATURE}
              hint="Spin up a room to get your agents talking."
              action={<Button variant="primary" icon="add" onClick={() => setNewOpen(true)}
                style={{ background: FEATURE, boxShadow: `0 0 20px ${FEATURE}55` }}>New room</Button>} />
          ) : (
            rooms.map((room, i) => {
              const active = room.id === activeRoomId;
              return (
                <button key={room.id} onClick={() => setActiveRoomId(room.id)}
                  style={{ animationDelay: `${i * 40}ms` }}
                  className={`group w-full animate-fadeInUp rounded-xl border px-3 py-2.5 text-left transition-all active:scale-[0.99]
                    ${active
                      ? 'border-[#EF4444]/40 bg-[#EF4444]/10 shadow-[0_0_20px_-6px_rgba(239,68,68,0.5)]'
                      : 'border-white/8 hover:border-white/15 hover:bg-white/5'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-ink">{room.name}</span>
                    {room.message_count > 0 && (
                      <Badge tone={active ? 'danger' : 'neutral'}>{room.message_count}</Badge>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteRoom(room.id, room.name); }}
                      className="ml-1 hidden h-5 w-5 place-items-center rounded text-[11px] text-muted/40 opacity-0 transition-all hover:bg-rose/20 hover:text-rose group-hover:opacity-100 group-hover:grid"
                      title="Delete room">
                      ×
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="flex items-center">
                      <div className="flex -space-x-1.5">
                        {room.participants.slice(0, 5).map((p, idx) => (
                          <span key={idx} title={p.name}
                            className="h-3.5 w-3.5 rounded-full border border-[#0D1520]"
                            style={{ background: p.colour }} />
                        ))}
                      </div>
                      {room.participants.length > 5 && (
                        <span className="ml-1.5 text-[10px] text-muted">+{room.participants.length - 5}</span>
                      )}
                      {room.participants.length === 0 && (
                        <span className="text-[10px] text-muted/70">No agents yet</span>
                      )}
                    </div>
                    <span className="shrink-0 text-[10px] text-muted">{timeAgo(room.last_at)}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ── RIGHT: chat surface ─────────────────────────────────────────── */}
      <section className={`${activeRoomId ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col bg-black/20 md:flex`}>
        {!activeRoom ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState icon="forum" accent={FEATURE}
              title={rooms.length ? 'Select a war room' : 'No war rooms yet'}
              hint={rooms.length
                ? 'Pick a room on the left to jump into the conversation.'
                : 'Create your first room to rally the agents.'}
              action={rooms.length ? undefined : (
                <Button variant="primary" icon="add" onClick={() => setNewOpen(true)}
                  style={{ background: FEATURE, boxShadow: `0 0 20px ${FEATURE}55` }}>New room</Button>
              )} />
          </div>
        ) : (
          <>
            {/* Participants bar */}
            <header className="flex items-center gap-3 border-b border-white/8 bg-surface/60 px-3 py-3 backdrop-blur md:px-4">
              <button onClick={() => setActiveRoomId(null)} aria-label="Back to rooms"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted hover:bg-white/5 hover:text-ink md:hidden">
                <Icon name="arrow_back" size={20} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-display font-semibold text-ink">{activeRoom.name}</h2>
                  <Badge tone="neutral">
                    {activeRoom.participants.length} agent{activeRoom.participants.length === 1 ? '' : 's'}
                  </Badge>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  {activeRoom.participants.length > 0 && (
                    <div className="flex -space-x-2">
                      {activeRoom.participants.slice(0, 6).map((p, i) => (
                        <Avatar key={i} colour={p.colour} initials={initialsOf(p.name)} size={24} />
                      ))}
                    </div>
                  )}
                  <span className="truncate text-[11px] text-muted">
                    {activeRoom.participants.map(p => p.name).join(', ') || 'Invite agents by @mentioning them'}
                  </span>
                </div>
              </div>
              <Button variant="glass" icon="auto_awesome" loading={summarizing}
                onClick={summarize} disabled={messages.length === 0}
                className="shrink-0"><span className="hidden sm:inline">Summarise</span></Button>
            </header>

            {/* Message thread */}
            <div className="flex-1 space-y-3 overflow-y-auto px-3 py-4 md:px-6">
              {loadingMsgs ? (
                <SkeletonList count={5} />
              ) : messages.length === 0 ? (
                <div className="grid h-full place-items-center">
                  <EmptyState icon="waving_hand" accent={FEATURE} title="Start the conversation"
                    hint={`Type @ to mention an agent and pull them into ${activeRoom.name}.`} />
                </div>
              ) : (
                messages.map(m => <Bubble key={m.id} m={m} />)
              )}

              {typing && <Typing agents={pending} />}
              <div ref={bottomRef} />
            </div>

            {/* Composer */}
            <form onSubmit={e => { e.preventDefault(); void send(); }}
              className="relative flex items-end gap-2 border-t border-white/8 bg-surface/80 px-3 py-3 backdrop-blur">
              {mention.open && mentionMatches.length > 0 && (
                <div className="absolute bottom-full left-3 right-3 mb-2 md:left-6 md:max-w-sm">
                  <div className="glass-raised max-h-60 animate-fadeInUp overflow-y-auto rounded-xl border border-white/10 p-1.5 shadow-2xl">
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted/70">
                      Mention an agent
                    </div>
                    <button key="all" type="button" tabIndex={-1}
                      onMouseDown={e => {
                        e.preventDefault();
                        const el = composerRef.current;
                        const caret = el?.selectionStart ?? input.length;
                        const allMentions = agents.map(a => a.real_name || a.name || a.slug).join(' @');
                        const before = input.slice(0, mention.start);
                        const token = `@${allMentions} `;
                        const next = before + token + input.slice(caret);
                        setInput(next);
                        closeMention();
                        requestAnimationFrame(() => {
                          const pos = before.length + token.length;
                          el?.focus();
                          el?.setSelectionRange(pos, pos);
                        });
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/10 ${mentionIdx === -1 ? 'bg-white/10' : ''}`}>
                      <div className="grid h-6 w-6 place-items-center rounded-lg bg-accent/20 text-accent text-[10px] font-bold">+</div>
                      <div className="min-w-0">
                        <div className="truncate text-sm text-ink">@all — mention every agent</div>
                        <div className="truncate text-[11px] text-muted">{agents.length} agents</div>
                      </div>
                    </button>
                    {mentionMatches.map((a, i) => (
                      <button key={a.id} type="button"
                        onMouseDown={e => { e.preventDefault(); insertMention(a); }}
                        onMouseEnter={() => setMentionIdx(i)}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors
                          ${i === mentionIdx ? 'bg-white/10' : 'hover:bg-white/5'}`}>
                        <Avatar colour={a.avatar_colour} initials={a.avatar_initials || initialsOf(a.real_name || a.name)} size={26} />
                        <div className="min-w-0">
                          <div className="truncate text-sm text-ink">{a.real_name || a.name}</div>
                          <div className="truncate text-[11px] text-muted">@{a.slug}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <textarea
                ref={composerRef} value={input} rows={1}
                placeholder={`Message ${activeRoom.name}…  ·  @ to mention`}
                onChange={e => { setInput(e.target.value); syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
                onKeyDown={onComposerKey}
                onBlur={() => setTimeout(closeMention, 120)}
                className="max-h-32 min-h-[42px] flex-1 resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-ink
                  placeholder:text-muted/60 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30" />
              <button type="submit" disabled={sending || !input.trim()} aria-label="Send message"
                className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-xl bg-accent text-[#04222b]
                  shadow-[0_0_20px_rgba(25,195,230,0.25)] transition-all hover:brightness-110
                  disabled:cursor-not-allowed disabled:opacity-40 active:scale-95">
                <Icon name={sending ? 'progress_activity' : 'send'} size={18} className={sending ? 'animate-spin' : ''} />
              </button>
            </form>
          </>
        )}
      </section>

      {/* New room modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New war room">
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Room name</label>
            <Input autoFocus value={newName} placeholder="e.g. Q3 Launch War Room"
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void createRoom(); } }} />
          </div>
          <p className="text-[11px] text-muted/70">
            Agents join automatically the first time you @mention them here.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setNewOpen(false)}>Cancel</Button>
            <Button variant="primary" icon="add" loading={creating} disabled={!newName.trim()}
              onClick={createRoom} style={{ background: FEATURE, boxShadow: `0 0 20px ${FEATURE}55` }}>
              Create room
            </Button>
          </div>
        </div>
      </Modal>

      {/* Summary modal */}
      <Modal open={summaryOpen} onClose={() => setSummaryOpen(false)} title="Room summary" width="max-w-xl">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
            style={{ background: '#A78BFA1a', color: '#A78BFA' }}>
            <Icon name="auto_awesome" size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {summary || 'No summary available.'}
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="secondary" icon="content_copy"
                onClick={() => {
                  navigator.clipboard?.writeText(summary).then(
                    () => toast('Summary copied', 'ok'),
                    () => toast('Copy failed', 'danger'),
                  );
                }}>Copy</Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Message bubble ──────────────────────────────────────────────────────────
function Bubble({ m }: { m: RoomMessage }) {
  const isOperator = m.from_agent_id == null;
  const colour = m.colour || OPERATOR;

  if (isOperator) {
    return (
      <div className="flex animate-slideInRight flex-row-reverse items-end gap-2">
        <div className="max-w-[82%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2.5 text-sm leading-relaxed text-[#04222b] shadow-[0_0_22px_-6px_rgba(25,195,230,0.5)] sm:max-w-[70%]">
          <div className="whitespace-pre-wrap break-words">{withMentions(m.text)}</div>
          <div className="mt-1 text-right text-[10px] text-[#04222b]/60">
            {m.from_name || 'Operator'} · {timeAgo(m.created_at)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex animate-fadeInUp items-end gap-2">
      <Avatar colour={colour} initials={m.initials || initialsOf(m.from_name)} size={30} glow />
      <div className="min-w-0 max-w-[82%] sm:max-w-[70%]">
        <div className="mb-0.5 ml-1 text-[11px] font-semibold" style={{ color: colour }}>{m.from_name}</div>
        <div className="rounded-2xl rounded-bl-md border px-3.5 py-2.5 text-sm leading-relaxed text-ink"
          style={{ background: `${colour}18`, borderColor: `${colour}33` }}>
          <div className="whitespace-pre-wrap break-words">{withMentions(m.text)}</div>
          <div className="mt-1 text-[10px] text-muted/70">{timeAgo(m.created_at)}</div>
        </div>
      </div>
    </div>
  );
}

// ── Typing indicator ────────────────────────────────────────────────────────
function Typing({ agents }: { agents: Agent[] }) {
  return (
    <div className="flex animate-fadeInUp items-end gap-2">
      {agents.length > 0 ? (
        <div className="flex -space-x-2">
          {agents.slice(0, 3).map(a => (
            <Avatar key={a.id} colour={a.avatar_colour} initials={a.avatar_initials || initialsOf(a.real_name || a.name)} size={30} glow />
          ))}
        </div>
      ) : (
        <Avatar colour="#A78BFA" initials="AI" size={30} glow />
      )}
      <div className="rounded-2xl rounded-bl-md border border-white/10 bg-white/5 px-4 py-3">
        <span className="flex items-center gap-1">
          {[0, 1, 2].map(i => (
            <span key={i} className="h-1.5 w-1.5 rounded-full bg-muted animate-pulse"
              style={{ animationDelay: `${i * 160}ms` }} />
          ))}
        </span>
      </div>
    </div>
  );
}
