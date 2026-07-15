// Voice Agent — talk to Hermes. A mesmerising pulsing microphone is the hero:
// press it, speak, and the in-browser Web Speech API streams a live transcript
// to /api/voice/chat. Falls back to a text box when speech isn't available.
// Left of the fold: hero mic + waveform + live transcript. Below: the latest
// exchange, this-session log, and saved history.
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Icon, Button, Card, Badge, Toggle, Input, Select, Modal,
  EmptyState, SkeletonList, useToast, Stat,
} from '../components/ui';
import { api, timeAgo } from '../lib/api';
import { useApp } from '../lib/store';
import type { VoiceSession } from '../lib/types';

// ── Static config ──────────────────────────────────────────────────────────
type Phase = 'idle' | 'listening' | 'processing';

interface VoiceSettings { wakeWord: string; lang: string; speak: boolean; voiceUri: string; }
const DEFAULT_SETTINGS: VoiceSettings = { wakeWord: 'Hermes', lang: 'en-US', speak: false, voiceUri: '' };
const SETTINGS_KEY = 'agentos_voice_settings';

const LANGS: Array<{ id: string; label: string }> = [
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'es-ES', label: 'Español (ES)' },
  { id: 'fr-FR', label: 'Français (FR)' },
  { id: 'de-DE', label: 'Deutsch (DE)' },
];

// Scoped keyframes for the rose glow-pulse + expanding rings. Injected once via
// a <style> element so the whole feature stays in this single file.
const VOICE_CSS = `
.voice-pulse { animation: voicePulse 1.5s ease-in-out infinite; }
@keyframes voicePulse {
  0%,100% { box-shadow: 0 0 34px -4px rgba(244,63,94,0.55), inset 0 0 24px rgba(244,63,94,0.22); }
  50%     { box-shadow: 0 0 76px 6px  rgba(244,63,94,0.85), inset 0 0 40px rgba(244,63,94,0.34); }
}
.voice-ring {
  position: absolute; left: 50%; top: 50%;
  height: 8rem; width: 8rem; border-radius: 9999px;
  border: 2px solid rgba(244,63,94,0.55);
  transform: translate(-50%,-50%) scale(0.72);
  animation: voiceRing 2.1s ease-out infinite; pointer-events: none;
}
@media (min-width: 768px) { .voice-ring { height: 10rem; width: 10rem; } }
@keyframes voiceRing {
  0%   { transform: translate(-50%,-50%) scale(0.72); opacity: 0.6; }
  80%  { opacity: 0.06; }
  100% { transform: translate(-50%,-50%) scale(2.15); opacity: 0; }
}
`;

const fmtDur = (s: number): string => {
  if (!s || s < 1) return '0s';
  const m = Math.floor(s / 60), sec = s % 60;
  return m ? `${m}m ${sec}s` : `${sec}s`;
};

export default function VoiceOld() {
  const toast = useToast();
  const { selectedTenant } = useApp();

  // capability detection (once)
  const speechAvailable = useMemo(
    () => typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition),
    [],
  );
  const synthAvailable = useMemo(
    () => typeof window !== 'undefined' && !!(window as any).speechSynthesis,
    [],
  );

  // state machine + transcripts
  const [phase, setPhase] = useState<Phase>('idle');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [textInput, setTextInput] = useState('');

  // this-session conversation (in memory) + saved history
  const [convo, setConvo] = useState<VoiceSession[]>([]);
  const [current, setCurrent] = useState<VoiceSession | null>(null);
  const [history, setHistory] = useState<VoiceSession[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  // settings (persisted locally)
  const [showSettings, setShowSettings] = useState(false);
  const [voices, setVoices] = useState<any[]>([]);
  const [settings, setSettings] = useState<VoiceSettings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return DEFAULT_SETTINGS;
  });

  const recognitionRef = useRef<any>(null);
  const finalRef = useRef('');
  const startRef = useRef(0);

  // ── data ──────────────────────────────────────────────────────────────────
  const loadHistory = useCallback(async () => {
    try {
      const r = await api.voiceHistory(selectedTenant ?? undefined);
      setHistory(r.sessions);
    } catch (e: any) {
      toast(e?.message || 'Could not load voice history', 'danger');
      setHistory([]);
    }
  }, [selectedTenant, toast]);

  useEffect(() => {
    // reset the ephemeral session when the project context changes
    setCurrent(null);
    setConvo([]);
    setExpanded(null);
    setHistory(null);
    loadHistory();
  }, [loadHistory]);

  // stop the mic / silence Hermes on unmount
  useEffect(() => () => {
    try { recognitionRef.current?.abort?.(); } catch { /* ignore */ }
    try { (window as any).speechSynthesis?.cancel?.(); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }, [settings]);

  // ── speech synthesis (speak replies) ────────────────────────────────────────
  const speak = (text: string) => {
    if (!synthAvailable || !text.trim()) return;
    try {
      const synth = (window as any).speechSynthesis;
      synth.cancel();
      const u = new (window as any).SpeechSynthesisUtterance(text);
      u.lang = settings.lang;
      if (settings.voiceUri) {
        const voices = synth.getVoices();
        const match = voices.find((v: any) => v.voiceURI === settings.voiceUri);
        if (match) u.voice = match;
      }
      synth.speak(u);
    } catch { /* ignore */ }
  };

  // ── send a message to Hermes ────────────────────────────────────────────────
  const submit = async (transcript: string, duration: number) => {
    const text = transcript.trim();
    if (!text) { setPhase('idle'); return; }
    setLiveTranscript(text);
    setPhase('processing');
    try {
      const { session } = await api.voiceChat({
        transcript: text,
        duration: duration > 0 ? duration : undefined,
        tenant_id: selectedTenant ?? undefined,
      });
      setConvo(c => [session, ...c]);
      setCurrent(session);
      if (settings.speak) speak(session.response || '');
      loadHistory();
    } catch (e: any) {
      toast(e?.message || 'Hermes could not respond right now.', 'danger');
    } finally {
      setPhase('idle');
      setLiveTranscript('');
    }
  };

  // ── Web Speech recognition ──────────────────────────────────────────────────
  const startListening = () => {
    const Ctor: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) { toast("Speech recognition isn't available — type to Hermes below.", 'warn'); return; }
    try {
      const rec = new Ctor();
      rec.lang = settings.lang;
      rec.interimResults = true;
      rec.continuous = false;
      finalRef.current = '';
      startRef.current = Date.now();
      setLiveTranscript('');

      rec.onresult = (e: any) => {
        let interim = '';
        let finalT = finalRef.current;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const chunk = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalT += chunk;
          else interim += chunk;
        }
        finalRef.current = finalT;
        setLiveTranscript((finalT + ' ' + interim).trim());
      };
      rec.onerror = (e: any) => {
        const err = e?.error;
        if (err && err !== 'aborted' && err !== 'no-speech') {
          toast(`Microphone error: ${err}`, 'danger');
        }
      };
      rec.onend = () => {
        recognitionRef.current = null;
        const finalText = finalRef.current.trim();
        const duration = Math.max(1, Math.round((Date.now() - startRef.current) / 1000));
        if (finalText) submit(finalText, duration);
        else setPhase('idle');
      };

      recognitionRef.current = rec;
      setPhase('listening');
      rec.start();
    } catch {
      toast('Could not start the microphone.', 'danger');
      setPhase('idle');
    }
  };

  const stopListening = () => {
    const rec = recognitionRef.current;
    if (rec) { try { rec.stop(); } catch { /* ignore */ } }
  };

  const onMicClick = () => {
    if (phase === 'processing') return;
    if (phase === 'listening') stopListening();
    else startListening();
  };

  const onTextSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const t = textInput.trim();
    if (!t || phase === 'processing') return;
    setTextInput('');
    submit(t, 0);
  };

  const del = async (id: number) => {
    try {
      await api.deleteVoiceSession(id);
      setHistory(h => (h ? h.filter(s => s.id !== id) : h));
      if (expanded === id) setExpanded(null);
      toast('Session deleted', 'ok');
    } catch (e: any) {
      toast(e?.message || 'Delete failed', 'danger');
    }
  };

  // ── derived ─────────────────────────────────────────────────────────────────
  const heroColor = phase === 'listening' ? '#F43F5E' : phase === 'processing' ? '#A78BFA' : '#19C3E6';
  const pill = phase === 'listening' ? 'Listening' : phase === 'processing' ? 'Thinking' : 'Ready';
  const bigStatus = phase === 'listening' ? 'Listening…'
    : phase === 'processing' ? 'Hermes is thinking…'
    : speechAvailable ? 'Tap the mic to speak' : 'Type to Hermes';

  const totalTalk = useMemo(() => (history ?? []).reduce((a, s) => a + (s.duration || 0), 0), [history]);
  const lastAt = history && history.length ? history[0].created_at : null;

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className="relative h-full w-full overflow-y-auto">
      <style>{VOICE_CSS}</style>
      {/* ambient top glow */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[460px]"
        style={{ background: 'radial-gradient(120% 80% at 50% -10%, rgba(244,63,94,0.11), transparent 60%)' }} />

      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-6 md:px-6 md:py-8">
        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="mb-6 flex items-center justify-between gap-3 animate-fadeInUp">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl"
              style={{ background: 'rgba(244,63,94,0.14)', color: '#F43F5E', boxShadow: '0 0 26px -6px rgba(244,63,94,0.5)' }}>
              <Icon name="mic" size={24} fill />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold text-ink">Voice Agent</h1>
              <p className="text-xs text-muted">Speak with Hermes, hands-free</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={speechAvailable ? 'info' : 'warn'} dot>
              {speechAvailable ? 'Web Speech' : 'Text only'}
            </Badge>
            <Button variant="glass" icon="tune" onClick={() => setShowSettings(true)}>
              <span className="hidden sm:inline">Settings</span>
            </Button>
          </div>
        </div>

        {/* ── Stats ──────────────────────────────────────────────────────────── */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Sessions" value={history?.length ?? 0} icon="forum" accent="#F43F5E" />
          <Stat label="Talk time" value={fmtDur(totalTalk)} icon="schedule" accent="#A78BFA" delay={60} />
          <Stat label="Last chat" value={timeAgo(lastAt)} icon="history" accent="#19C3E6" delay={120} />
        </div>

        {/* ── Hero: mic + waveform + transcript ──────────────────────────────── */}
        <Card glass className="relative mb-6 overflow-hidden p-6 md:p-10 animate-fadeInUp">
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-3xl"
              style={{ background: 'radial-gradient(circle, rgba(244,63,94,0.22), transparent 70%)' }} />
            <div className="absolute right-8 top-6 h-40 w-40 rounded-full opacity-25 blur-3xl animate-float"
              style={{ background: 'radial-gradient(circle, rgba(167,139,250,0.28), transparent 70%)' }} />
            <div className="absolute bottom-6 left-8 h-40 w-40 rounded-full opacity-20 blur-3xl animate-float"
              style={{ background: 'radial-gradient(circle, rgba(25,195,230,0.28), transparent 70%)', animationDelay: '2s' }} />
          </div>

          <div className="relative z-10 flex flex-col items-center gap-5">
            {/* status pill */}
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${
                phase === 'listening' ? 'bg-rose animate-pulse'
                : phase === 'processing' ? 'bg-violet animate-pulse' : 'bg-accent'}`} />
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{pill}</span>
            </div>

            {/* mic + rings */}
            <div className="relative grid h-52 w-52 place-items-center md:h-64 md:w-64">
              {phase !== 'listening' && (
                <span className="absolute h-40 w-40 rounded-full opacity-70 md:h-48 md:w-48"
                  style={{ boxShadow: `0 0 70px -14px ${heroColor}` }} />
              )}
              {phase === 'listening' && [0, 1, 2].map(i => (
                <span key={i} className="voice-ring" style={{ animationDelay: `${i * 0.7}s` }} />
              ))}
              <button
                type="button"
                onClick={onMicClick}
                disabled={phase === 'processing'}
                aria-label={phase === 'listening' ? 'Stop listening' : 'Start listening'}
                className={`relative grid h-32 w-32 place-items-center rounded-full border transition-all duration-500
                  active:scale-95 disabled:cursor-not-allowed md:h-40 md:w-40 ${phase === 'listening' ? 'voice-pulse' : ''}`}
                style={{
                  background: `radial-gradient(circle at 32% 28%, ${heroColor}59, ${heroColor}14 68%)`,
                  borderColor: `${heroColor}80`,
                  color: phase === 'listening' ? '#ffffff' : heroColor,
                  boxShadow: phase === 'listening' ? undefined : `0 0 44px -8px ${heroColor}77, inset 0 0 30px ${heroColor}1f`,
                }}
              >
                <Icon
                  name={phase === 'processing' ? 'progress_activity' : 'mic'}
                  size={54}
                  fill
                  className={phase === 'processing' ? 'animate-spin' : ''}
                />
              </button>
            </div>

            {/* waveform */}
            <Waveform active={phase === 'listening'} />

            {/* status text + live transcript */}
            <div className="min-h-[3.75rem] max-w-md text-center">
              <p className="font-display text-lg font-semibold text-ink">{bigStatus}</p>
              {(phase === 'listening' || phase === 'processing') && liveTranscript ? (
                <p className="mt-1 text-sm text-muted">“{liveTranscript}”</p>
              ) : phase === 'idle' && !speechAvailable ? (
                <p className="mt-1 text-sm text-muted">Voice input isn't supported in this browser — type below.</p>
              ) : phase === 'idle' && speechAvailable && settings.wakeWord ? (
                <p className="mt-1 text-xs text-muted/70">Wake word: “{settings.wakeWord}”</p>
              ) : null}
            </div>

            {/* text input (fallback + secondary) */}
            <form onSubmit={onTextSubmit} className="flex w-full max-w-md items-center gap-2">
              <Input
                value={textInput}
                onChange={e => setTextInput(e.target.value)}
                disabled={phase === 'processing'}
                placeholder={speechAvailable ? 'Or type to Hermes…' : 'Type to Hermes…'}
                className="flex-1"
              />
              <Button
                type="submit"
                variant="primary"
                icon="send"
                disabled={phase === 'processing' || !textInput.trim()}
                className="shrink-0"
                style={{ background: '#F43F5E', color: '#ffffff', boxShadow: '0 0 20px rgba(244,63,94,0.35)' }}
              >
                Send
              </Button>
            </form>
          </div>
        </Card>

        {/* ── Latest exchange ────────────────────────────────────────────────── */}
        {current && (
          <Card glass hover className="mb-6 p-4 animate-fadeInUp md:p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-rose">
                <Icon name="graphic_eq" size={16} /> Latest exchange
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <Badge tone="neutral">{current.duration}s</Badge>
                <span>{timeAgo(current.created_at)}</span>
                {synthAvailable && current.response ? (
                  <button type="button" title="Replay" onClick={() => speak(current.response || '')}
                    className="text-muted transition-colors hover:text-ink">
                    <Icon name="volume_up" size={18} />
                  </button>
                ) : null}
              </div>
            </div>
            <div className="mb-3 flex items-start gap-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
                <Icon name="person" size={18} />
              </div>
              <p className="pt-1 text-sm leading-relaxed text-ink">{current.transcript || '—'}</p>
            </div>
            <div className="flex items-start gap-3">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-rose/15 text-rose">
                <Icon name="smart_toy" size={18} fill />
              </div>
              <div className="rounded-2xl rounded-tl-sm border border-rose/15 bg-rose/5 px-3 py-2 text-sm leading-relaxed text-ink">
                {current.response || 'No response.'}
              </div>
            </div>
          </Card>
        )}

        {/* ── This session + History ─────────────────────────────────────────── */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* This session */}
          <div className="space-y-3">
            <SectionHeader icon="forum" color="#A78BFA" title="This session" count={convo.length} />
            {convo.length <= 1 ? (
              <Card glass className="p-4">
                <p className="text-sm text-muted">
                  {convo.length === 0
                    ? 'No exchanges yet — tap the mic or type to talk to Hermes.'
                    : 'Earlier exchanges from this session will stack up here.'}
                </p>
              </Card>
            ) : (
              <div className="space-y-2">
                {convo.slice(1).map((s, i) => (
                  <Card key={`${s.id}-${i}`} glass className="p-3 animate-fadeInUp" style={{ animationDelay: `${i * 40}ms` }}>
                    <p className="line-clamp-2 text-sm text-ink">{s.transcript || '—'}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted">
                      <span className="text-rose">Hermes: </span>{s.response || '—'}
                    </p>
                    <div className="mt-1 text-[11px] text-muted/70">{s.duration}s · {timeAgo(s.created_at)}</div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* History */}
          <div className="space-y-3">
            <SectionHeader icon="history" color="#19C3E6" title="History" count={history?.length} />
            {history === null ? (
              <SkeletonList count={4} />
            ) : history.length === 0 ? (
              <EmptyState icon="graphic_eq" accent="#F43F5E"
                title="No voice sessions yet"
                hint="Your conversations with Hermes are saved here — ask something to get started." />
            ) : (
              <div className="space-y-2">
                {history.map((s, i) => (
                  <Card key={s.id} glass className="p-3 animate-fadeInUp" style={{ animationDelay: `${i * 40}ms` }}>
                    <div className="flex items-start gap-3">
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose/10 text-rose">
                        <Icon name="graphic_eq" size={18} />
                      </div>
                      <button type="button" onClick={() => setExpanded(e => (e === s.id ? null : s.id))}
                        className="min-w-0 flex-1 text-left">
                        <p className="truncate text-sm text-ink">{s.transcript || 'Voice note'}</p>
                        <p className={`text-xs text-muted ${expanded === s.id ? '' : 'line-clamp-1'}`}>
                          {s.response || 'No response'}
                        </p>
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted/70">
                          <Icon name="schedule" size={12} />{s.duration}s
                          <span>·</span><span>{timeAgo(s.created_at)}</span>
                        </div>
                      </button>
                      <div className="flex shrink-0 flex-col items-center gap-1">
                        <button type="button" title="Delete" onClick={() => del(s.id)}
                          className="text-muted transition-colors hover:text-rose">
                          <Icon name="delete" size={18} />
                        </button>
                        <button type="button" aria-label="Toggle details"
                          onClick={() => setExpanded(e => (e === s.id ? null : s.id))}
                          className="text-muted transition-colors hover:text-ink">
                          <Icon name={expanded === s.id ? 'expand_less' : 'expand_more'} size={18} />
                        </button>
                      </div>
                    </div>
                    {expanded === s.id && (
                      <div className="mt-3 space-y-2 border-t border-white/6 pt-3 animate-fadeInUp">
                        <p className="text-xs leading-relaxed">
                          <span className="text-muted">You: </span><span className="text-ink">{s.transcript || '—'}</span>
                        </p>
                        <p className="text-xs leading-relaxed">
                          <span className="text-rose">Hermes: </span><span className="text-ink">{s.response || '—'}</span>
                        </p>
                        {synthAvailable && s.response ? (
                          <Button variant="ghost" icon="volume_up" onClick={() => speak(s.response || '')}>Replay</Button>
                        ) : null}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Settings ─────────────────────────────────────────────────────────── */}
      <Modal open={showSettings} onClose={() => setShowSettings(false)} title="Voice settings">
        <div className="space-y-5">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Voice</label>
            <div className="flex gap-2">
              <select value={settings.voiceUri} className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-ink"
                onChange={e => setSettings(s => ({ ...s, voiceUri: e.target.value }))}
                onFocus={() => {
                  const synth = (window as any).speechSynthesis;
                  if (synth) {
                    const v = synth.getVoices();
                    if (v.length) setVoices(v);
                    else synth.onvoiceschanged = () => setVoices(synth.getVoices());
                  }
                }}>
                <option value="">System default</option>
                {voices.filter((v: any) => v.lang?.startsWith(settings.lang?.split('-')[0] || 'en')).map((v: any) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
              <button onClick={() => {
                const synth = (window as any).speechSynthesis;
                if (!synth) return;
                const u = new (window as any).SpeechSynthesisUtterance('Hello, I am Hermes. How can I help you?');
                u.lang = settings.lang;
                if (settings.voiceUri) {
                  const m = voices.find((v: any) => v.voiceURI === settings.voiceUri);
                  if (m) u.voice = m;
                }
                synth.cancel();
                synth.speak(u);
              }}
                className="rounded-lg border border-white/10 px-3 py-2 text-[10px] text-muted hover:text-ink">
                Preview
              </button>
            </div>
            <p className="mt-1 text-[11px] text-muted/70">Click the field to load available system voices.</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Wake word</label>
            <Input value={settings.wakeWord} placeholder="Hermes"
              onChange={e => setSettings(s => ({ ...s, wakeWord: e.target.value }))} />
            <p className="mt-1 text-[11px] text-muted/70">Cosmetic — a phrase to say before your command.</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Recognition language</label>
            <Select value={settings.lang} className="w-full"
              onChange={e => setSettings(s => ({ ...s, lang: e.target.value }))}>
              {LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted">Speak replies</label>
              <p className="mt-0.5 text-[11px] text-muted/70">
                {synthAvailable ? "Hermes reads answers aloud." : 'Not supported in this browser.'}
              </p>
            </div>
            <Toggle checked={settings.speak} disabled={!synthAvailable}
              onChange={() => setSettings(s => ({ ...s, speak: !s.speak }))} />
          </div>
          <div className="flex justify-end pt-1">
            <Button variant="primary" icon="check" onClick={() => setShowSettings(false)}>Done</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Waveform — vertical bars that react while listening ─────────────────────
function Waveform({ active }: { active: boolean }) {
  const BARS = 32;
  const [heights, setHeights] = useState<number[]>(() => Array(BARS).fill(8));

  useEffect(() => {
    if (!active) { setHeights(Array(BARS).fill(8)); return; }
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 85) {
        last = t;
        setHeights(hs => hs.map((_, i) => {
          const centre = 1 - Math.abs(i - BARS / 2) / (BARS / 2); // taller in the middle
          const base = 10 + centre * 30;
          return Math.max(5, Math.round(base * (0.35 + Math.random() * 0.95)));
        }));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div className="flex h-14 items-center justify-center gap-1" aria-hidden="true">
      {heights.map((h, i) => (
        <span key={i}
          className={`w-1 rounded-full transition-[height] duration-100 ease-out ${active ? 'bg-rose' : 'bg-white/15'}`}
          style={{ height: `${h}px`, opacity: active ? 0.55 + (h / 60) : 1 }} />
      ))}
    </div>
  );
}

// ── Section header ──────────────────────────────────────────────────────────
function SectionHeader({ icon, title, count, color = '#7B8DA8' }:
  { icon: string; title: string; count?: number; color?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon name={icon} size={16} style={{ color }} />
      <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">{title}</h2>
      {typeof count === 'number' && <Badge tone="neutral">{count}</Badge>}
    </div>
  );
}
