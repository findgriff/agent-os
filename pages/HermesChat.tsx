// Hermes Chat — talk to Hermes directly from the AGENT OS web UI, no
// WhatsApp or terminal needed. Backed by POST /api/hermes/chat (which drives
// the Hermes CLI on a per-user session) and GET /api/hermes/history.
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Icon, useToast } from '../components/ui';

interface HermesMessage {
  id: number | string;
  role: 'user' | 'hermes';
  content: string;
  created_at?: number;
  pending?: boolean;
  error?: boolean;
}

const ACCENT = '#19C3E6';

const clock = (ts?: number) =>
  ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
     : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let _seq = 0;
const tmpId = () => `t${Date.now()}_${_seq++}`;

// Minimal, safe markdown: escape HTML then bold **…**. No raw HTML passes.
function renderMd(text: string): string {
  const esc = (text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export default function HermesChat() {
  const toast = useToast();
  const [messages, setMessages] = useState<HermesMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  // Load transcript on entry.
  useEffect(() => {
    api.get<{ messages: HermesMessage[] }>('/api/hermes/history')
      .then(r => setMessages(r.messages || []))
      .catch(() => toast('Could not load chat history', 'danger'))
      .finally(() => setLoading(false));
  }, []);

  // Auto-scroll to newest.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || sending) return;
    const userMsg: HermesMessage = { id: tmpId(), role: 'user', content: text };
    const pending: HermesMessage = { id: tmpId(), role: 'hermes', content: '', pending: true };
    setMessages(m => [...m, userMsg, pending]);
    setInput('');
    setSending(true);
    try {
      const res = await api.post<{ ok: boolean; reply: string }>(
        '/api/hermes/chat', { message: text });
      setMessages(m => m.map(msg => msg.id === pending.id
        ? { ...msg, pending: false, content: res.reply || '(no response)', error: !res.ok }
        : msg));
    } catch {
      setMessages(m => m.map(msg => msg.id === pending.id
        ? { ...msg, pending: false, error: true, content: 'Message failed — please try again.' }
        : msg));
      toast('Hermes request failed', 'danger');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-white/6 px-5 py-4">
        <div className="grid h-11 w-11 place-items-center rounded-2xl"
          style={{ background: `${ACCENT}1a`, color: ACCENT,
            boxShadow: `0 0 22px -6px ${ACCENT}` }}>
          <Icon name="smart_toy" size={24} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-lg font-bold text-ink">Hermes</h1>
            <span className="h-2 w-2 rounded-full"
              style={{ background: '#22C55E', boxShadow: '0 0 8px #22C55E' }} />
          </div>
          <p className="truncate text-xs text-muted">
            Chat with your Hermes agent — memory, tools and all — right here.
          </p>
        </div>
      </header>

      {/* Message list */}
      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-muted">
              <Icon name="progress_activity" size={20} className="animate-spin" />
              <span className="text-sm">Loading conversation…</span>
            </div>
          ) : messages.length === 0 ? (
            <EmptyState onPick={send} />
          ) : (
            messages.map(m => <Bubble key={m.id} m={m} />)
          )}
        </div>
      </div>

      {/* Composer */}
      <form onSubmit={e => { e.preventDefault(); send(input); }}
        className="shrink-0 border-t border-white/8 bg-surface/50 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <textarea
            value={input} rows={1} placeholder="Message Hermes…"
            disabled={sending}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
            }}
            className="max-h-40 min-h-[46px] flex-1 resize-none rounded-2xl border border-white/10 bg-black/30
              px-4 py-3 text-sm text-ink placeholder:text-muted/60 focus:border-accent/50 focus:outline-none
              focus:ring-1 focus:ring-accent/30 disabled:opacity-60" />
          <button type="submit" disabled={sending || !input.trim()}
            className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-2xl bg-accent text-[#04222b]
              shadow-[0_0_20px_rgba(25,195,230,0.25)] transition-all hover:brightness-110
              disabled:cursor-not-allowed disabled:opacity-40 active:scale-95"
            aria-label="Send">
            <Icon name={sending ? 'progress_activity' : 'send'} size={20}
              className={sending ? 'animate-spin' : ''} />
          </button>
        </div>
        <p className="mx-auto mt-1.5 w-full max-w-3xl px-1 text-[11px] text-muted/50">
          Enter to send · Shift+Enter for a new line
        </p>
      </form>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────
const SUGGESTIONS = [
  'What can you help me with?',
  'Summarise my recent activity',
  "What's on my plate today?",
];

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center animate-fadeInUp">
      <div className="grid h-16 w-16 place-items-center rounded-3xl"
        style={{ background: `${ACCENT}14`, color: ACCENT, boxShadow: `0 0 40px -10px ${ACCENT}` }}>
        <Icon name="smart_toy" size={34} />
      </div>
      <div>
        <h2 className="font-display text-xl font-bold text-ink">Chat with Hermes</h2>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Ask anything — Hermes keeps the thread, so you can pick up where you left off.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map(s => (
          <button key={s} onClick={() => onPick(s)}
            className="rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs text-muted
              transition-all hover:border-accent/40 hover:text-ink active:scale-95">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────
function Bubble({ m }: { m: HermesMessage }) {
  const isUser = m.role === 'user';
  return (
    <div className={`flex items-end gap-2.5 animate-fadeInUp ${isUser ? 'flex-row-reverse' : ''}`}>
      {!isUser && (
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl"
          style={{ background: `${ACCENT}1a`, color: ACCENT }}>
          <Icon name="smart_toy" size={17} />
        </div>
      )}
      <div className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed
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
          : <span className="whitespace-pre-wrap break-words [&_strong]:font-semibold"
              dangerouslySetInnerHTML={{ __html: renderMd(m.content) }} />}
        {!m.pending && (
          <div className={`mt-1 text-[10px] ${isUser ? 'text-[#04222b]/60' : 'text-muted/70'}`}>
            {clock(m.created_at)}
          </div>
        )}
      </div>
    </div>
  );
}
