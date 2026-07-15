// ChatPanel — a slide-in chat drawer for a single connected integration.
// 420px, glass-dark. Talks to POST /api/bridges/:id/chat. "Take Command"
// broadcasts each message to every other connected integration.
import { useEffect, useRef, useState } from 'react';
import { Icon, useToast } from './ui';
import { api } from '../lib/api';
import { styleFor } from '../pages/Integrations';
import type { Connection, ChatMessage } from '../lib/types';

const QUICK_ACTIONS = [
  { label: 'Run all agents', icon: 'play_arrow' },
  { label: 'Generate briefing', icon: 'description' },
  { label: 'Show memory stats', icon: 'insights' },
];

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let _seq = 0;
const uid = () => `m${Date.now()}_${_seq++}`;

const statusColour = (s?: string) =>
  s === 'connected' ? '#22C55E' : s === 'error' ? '#F43F5E' : '#7B8DA8';

export function ChatPanel({ connection, open, onClose }:
  { connection: Connection | null; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const st = styleFor(connection?.platform || '');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [takeCommand, setTakeCommand] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  // Reset the transcript when switching between integrations.
  useEffect(() => {
    if (connection) {
      setMessages([{
        id: uid(), role: 'agent', ts: Date.now(),
        text: `You're connected to **${connection.label || connection.meta.label}**. `
          + `Ask a question or fire a quick action below.`,
      }]);
      setTakeCommand(false);
    }
  }, [connection?.id]);

  // Autoscroll to newest.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !connection) return null;

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || sending || !connection) return;
    const userMsg: ChatMessage = { id: uid(), role: 'user', ts: Date.now(), text };
    const pending: ChatMessage = { id: uid(), role: 'agent', ts: Date.now(), text: '', pending: true };
    setMessages(m => [...m, userMsg, pending]);
    setInput('');
    setSending(true);
    try {
      const res = await api.bridgeChat(connection.id, { message: text, take_command: takeCommand });
      setMessages(m => m.map(msg => msg.id === pending.id
        ? { ...msg, pending: false, text: res.reply || '(no response)',
            error: !res.ok, broadcast: res.broadcast?.length ? res.broadcast : undefined }
        : msg));
    } catch {
      setMessages(m => m.map(msg => msg.id === pending.id
        ? { ...msg, pending: false, error: true, text: 'Message failed — please retry.' }
        : msg));
      toast('Chat request failed', 'danger');
    } finally {
      setSending(false);
    }
  };

  const onAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setInput(i => `${i}${i ? ' ' : ''}[attached: ${f.name}] `);
    e.target.value = '';
  };

  if (!connection) {
    return (
      <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
        <div onClick={e => e.stopPropagation()}
          className="flex h-full w-full flex-col items-center justify-center gap-3 glass-raised border-l border-white/10 sm:max-w-[420px] md:w-[420px] p-6 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose/15 text-rose"><Icon name="link_off" size={26} /></div>
          <p className="font-display text-lg font-bold text-ink">No connection selected</p>
          <p className="max-w-xs text-sm text-muted">Open Integrations to connect a platform first, then click its chat icon.</p>
          <button onClick={onClose} className="mt-2 rounded-xl border border-white/10 px-4 py-2 text-sm text-muted hover:text-ink">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-[fadeInUp_0.2s]" />
      <div
        onClick={e => e.stopPropagation()}
        className="relative flex h-full w-full max-w-full flex-col glass-raised border-l border-white/10 animate-slideInRight sm:max-w-[420px] md:w-[420px]"
      >
        {/* Header */}
        <header className="flex items-center gap-3 border-b border-white/8 px-4 py-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
            style={{ background: `${st.accent}1a`, color: st.accent }}>
            <Icon name={st.icon} size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-display font-semibold text-ink">
                {connection.label || connection.meta.label}
              </span>
              <span className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: statusColour(connection.last_status),
                  boxShadow: `0 0 8px ${statusColour(connection.last_status)}` }} />
            </div>
            <div className="truncate text-[11px] text-muted">{connection.meta.blurb}</div>
          </div>
          <button onClick={onClose} className="shrink-0 text-muted transition-colors hover:text-ink"
            aria-label="Close chat"><Icon name="close" size={22} /></button>
        </header>

        {/* Take Command toggle */}
        <div className="flex items-center justify-between border-b border-white/6 bg-black/20 px-4 py-2">
          <div className="flex items-center gap-1.5 text-xs">
            <Icon name="campaign" size={16} className={takeCommand ? 'text-accent' : 'text-muted'} />
            <span className={takeCommand ? 'text-ink' : 'text-muted'}>Take Command</span>
            <span className="text-[10px] text-muted/70">· broadcast to all</span>
          </div>
          <button type="button" role="switch" aria-checked={takeCommand}
            onClick={() => setTakeCommand(v => !v)}
            className={`relative h-5 w-9 rounded-full transition-colors
              ${takeCommand ? 'bg-accent shadow-[0_0_12px_rgba(25,195,230,0.5)]' : 'bg-white/10'}`}>
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform
              ${takeCommand ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
          </button>
        </div>

        {/* Message list */}
        <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map(m => <Bubble key={m.id} m={m} accent={st.accent} icon={st.icon} />)}
        </div>

        {/* Quick actions */}
        <div className="flex gap-2 overflow-x-auto border-t border-white/6 px-4 py-2">
          {QUICK_ACTIONS.map(q => (
            <button key={q.label} disabled={sending} onClick={() => send(q.label)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10
                bg-white/5 px-3 py-1 text-xs text-muted transition-all hover:text-ink hover:border-accent/40
                disabled:opacity-40 active:scale-95">
              <Icon name={q.icon} size={14} />{q.label}
            </button>
          ))}
        </div>

        {/* Input bar — sticky to bottom, safe-area-aware for mobile keyboards */}
        <form onSubmit={e => { e.preventDefault(); send(input); }}
          className="sticky bottom-0 flex items-end gap-2 border-t border-white/8 bg-surface/90 px-3 pb-[env(safe-area-inset-bottom,12px)] pt-3 backdrop-blur">
          <input ref={fileRef} type="file" className="hidden" onChange={onAttach} />
          <button type="button" onClick={() => fileRef.current?.click()}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-muted hover:bg-white/5 hover:text-ink"
            aria-label="Attach"><Icon name="attach_file" size={20} /></button>
          <textarea
            value={input} rows={1} placeholder="Message…"
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
            }}
            className="max-h-28 min-h-[40px] flex-1 resize-none rounded-xl border border-white/10 bg-black/30
              px-3 py-2.5 text-sm text-ink placeholder:text-muted/60 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30" />
          <button type="submit" disabled={sending || !input.trim()}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-[#04222b]
              shadow-[0_0_20px_rgba(25,195,230,0.25)] transition-all hover:brightness-110
              disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
            aria-label="Send">
            <Icon name={sending ? 'progress_activity' : 'send'} size={18}
              className={sending ? 'animate-spin' : ''} />
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────
function Bubble({ m, accent, icon }: { m: ChatMessage; accent: string; icon: string }) {
  const isUser = m.role === 'user';
  return (
    <div className={`flex items-end gap-2 animate-fadeInUp ${isUser ? 'flex-row-reverse' : ''}`}>
      {!isUser && (
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
          style={{ background: `${accent}1a`, color: accent }}>
          <Icon name={icon} size={16} />
        </div>
      )}
      <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed
        ${isUser
          ? 'bg-accent text-[#04222b] rounded-br-md'
          : `glass text-ink rounded-bl-md ${m.error ? 'border border-rose/30' : ''}`}`}>
        {m.pending
          ? <span className="flex gap-1 py-1">
              {[0, 1, 2].map(i => (
                <span key={i} className="h-1.5 w-1.5 rounded-full bg-muted animate-pulse"
                  style={{ animationDelay: `${i * 150}ms` }} />
              ))}
            </span>
          : <span className="whitespace-pre-wrap [&_strong]:font-semibold"
              dangerouslySetInnerHTML={{ __html: renderMd(m.text) }} />}
        {m.broadcast && (
          <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
              Broadcast · {m.broadcast.length}
            </div>
            {m.broadcast.map(b => (
              <div key={b.id} className="text-[11px] opacity-90">
                <span className="font-semibold">{b.label}:</span> {b.reply.slice(0, 120)}
              </div>
            ))}
          </div>
        )}
        <div className={`mt-1 text-[10px] ${isUser ? 'text-[#04222b]/60' : 'text-muted/70'}`}>
          {clock(m.ts)}
        </div>
      </div>
    </div>
  );
}

// Minimal, safe markdown: escape HTML then bold **…**. No raw HTML passes through.
function renderMd(text: string): string {
  const esc = (text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
