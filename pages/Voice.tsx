// Apollo — the real-time conversational voice butler for AGENT OS.
// A KITT-red equalizer orb is the hero: it pulses while listening and Apollo replies
// aloud. Real-time mode keeps the mic open in a turn-taking loop; off means
// push-to-talk. Apollo can open apps/sites, build small tools, and search the
// web — every command runs through /api/apollo/command and streams back an
// action result rendered inline. Switching tabs auto-stops the mic and shows
// "Tap to resume" (never auto-restarts). Collapses to a floating panel.
import { useState, useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, Button, Card, Badge, Toggle, Input, Modal, EmptyState, useToast } from '../components/ui';
import { api, timeAgo } from '../lib/api';
import { useApp } from '../lib/store';
import type { ApolloCommand, ApolloAction, ApolloResult, ApolloCommandResult } from '../lib/types';

const RED = '#EF4444';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Msg {
  id: string; role: 'user' | 'apollo'; text: string; ts: number;
  action?: ApolloAction; result?: ApolloResult; status?: string; latency?: number;
}

interface Settings {
  speak: boolean; lang: string; voiceUri: string;
  wakeWord: boolean; realtimeWs: boolean;
}
const DEFAULTS: Settings = {
  speak: true, lang: 'en-US', voiceUri: 'openai:onyx',
  wakeWord: false, realtimeWs: false,
};
const SETTINGS_KEY = 'agentos_apollo_settings';
const MIC_KEY = 'agentos_apollo_mic_id';

// Apollo's OpenAI TTS voices, surfaced in the picker as `openai:<voice>`.
const OPENAI_VOICES = [
  { id: 'openai:onyx', label: 'KITT · Onyx (OpenAI TTS)' },
  { id: 'openai:nova', label: 'Apollo · Nova (OpenAI TTS)' },
  { id: 'openai:alloy', label: 'Apollo · Alloy (OpenAI TTS)' },
  { id: 'openai:fable', label: 'Apollo · Fable (OpenAI TTS)' },
  { id: 'openai:shimmer', label: 'Apollo · Shimmer (OpenAI TTS)' },
];
// Close the mic only after this much quiet following speech — long enough that a
// natural pause mid-thought never cuts the operator off (the old cut-off bug).
const SILENCE_MS = 2500;

const LANGS = [
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'es-ES', label: 'Español (ES)' },
  { id: 'fr-FR', label: 'Français (FR)' },
  { id: 'de-DE', label: 'Deutsch (DE)' },
];

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let _mid = 0;
const nextId = () => `m${Date.now()}_${_mid++}`;

const speechAvailable = typeof window !== 'undefined' &&
  !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
const synthAvailable = typeof window !== 'undefined' && !!(window as any).speechSynthesis;

export default function Voice() {
  const toast = useToast();
  const navigate = useNavigate();
  const { selectedTenant } = useApp();

  const [phase, setPhase] = useState<Phase>('idle');
  const [realtime, setRealtime] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [textInput, setTextInput] = useState('');
  const [history, setHistory] = useState<ApolloCommand[] | null>(null);
  const [historyError, setHistoryError] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [voices, setVoices] = useState<any[]>([]);
  const [audioDevices, setAudioDevices] = useState<{ id: string; label: string }[]>([]);
  const voiceFieldId = useId();
  const micFieldId = useId();
  const langFieldId = useId();
  const [selectedMicId, setSelectedMicId] = useState<string>(() => {
    try { return localStorage.getItem(MIC_KEY) || ''; } catch { return ''; }
  });
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return DEFAULTS;
  });

  // Refs mirror state so recognition/visibility callbacks read the latest
  // values without re-subscribing or capturing stale closures.
  const recognitionRef = useRef<any>(null);
  const finalRef = useRef('');
  const discardRef = useRef(false);
  const realtimeRef = useRef(realtime);
  const suspendedRef = useRef(suspended);
  const phaseRef = useRef<Phase>(phase);
  const settingsRef = useRef(settings);
  const controlsRef = useRef<{ suspend: () => void }>({ suspend: () => {} });
  const logRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const silenceRef = useRef<number | null>(null);
  const restartRef = useRef<number | null>(null);   // real-time keep-alive timer
  const mountedRef = useRef(true);

  useEffect(() => { realtimeRef.current = realtime; }, [realtime]);
  useEffect(() => { suspendedRef.current = suspended; }, [suspended]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  }, [settings]);
  useEffect(() => {
    try { localStorage.setItem(MIC_KEY, selectedMicId); } catch { /* ignore */ }
  }, [selectedMicId]);

  // Enumerate available microphones
  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(devices => {
      const mics = devices
        .filter(d => d.kind === 'audioinput')
        .map(d => ({ id: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}…` }));
      setAudioDevices(mics);
    }).catch(() => {});
  }, []);

  const setPhaseNow = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  // ── data ────────────────────────────────────────────────────────────────
  const loadHistory = async () => {
    try {
      const r = await api.apolloHistory(selectedTenant ?? undefined);
      setHistory(r.commands);
      setHistoryError(false);
    } catch { setHistory([]); setHistoryError(true); }
  };
  useEffect(() => {
    setMessages([]); setHistory(null); loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTenant]);

  // load synth voices (async in most browsers)
  useEffect(() => {
    const synth = (window as any).speechSynthesis;
    if (!synth) return;
    const load = () => setVoices(synth.getVoices() || []);
    load();
    synth.onvoiceschanged = load;
    return () => { try { synth.onvoiceschanged = null; } catch { /* ignore */ } };
  }, []);

  // auto-scroll the conversation to the newest message
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // ── speech synthesis ──────────────────────────────────────────────────────
  // Stop whatever Apollo is currently saying (OpenAI clip or browser synth).
  const cancelPlayback = () => {
    if (audioRef.current) {
      try { audioRef.current.pause(); audioRef.current.src = ''; } catch { /* ignore */ }
      audioRef.current = null;
    }
    try { (window as any).speechSynthesis?.cancel?.(); } catch { /* ignore */ }
  };

  const speakBrowser = (text: string, onDone?: () => void) => {
    const synth = (window as any).speechSynthesis;
    if (!synth || !text.trim()) { onDone?.(); return; }
    try {
      synth.cancel();
      const u = new (window as any).SpeechSynthesisUtterance(text);
      u.lang = settingsRef.current.lang;
      const uri = settingsRef.current.voiceUri;
      if (uri && !uri.startsWith('openai:')) {
        const v = synth.getVoices().find((x: any) => x.voiceURI === uri);
        if (v) u.voice = v;
      }
      let done = false;
      const finish = () => { if (!done) { done = true; onDone?.(); } };
      u.onend = finish; u.onerror = finish;
      synth.speak(u);
    } catch { onDone?.(); }
  };

  // Speak Apollo's reply. An `openai:*` voice streams OpenAI TTS audio (falling
  // back to the browser voice on any failure); otherwise browser synth is used.
  const speakReply = (text: string, onDone?: () => void) => {
    if (!text.trim()) { onDone?.(); return; }
    cancelPlayback();
    setPhaseNow('speaking');
    const uri = settingsRef.current.voiceUri;
    if (!uri.startsWith('openai:')) { speakBrowser(text, onDone); return; }
    const voice = uri.slice('openai:'.length) || 'nova';
    let settled = false;
    const fallback = () => { if (!settled) { settled = true; speakBrowser(text, onDone); } };
    const finish = () => { if (!settled) { settled = true; onDone?.(); } };
    api.apolloTts({ text, voice }).then(({ audio_url }) => {
      if (!mountedRef.current) return;   // navigated away during the TTS request
      const audio = new Audio(audio_url);
      audioRef.current = audio;
      audio.onended = () => { if (audioRef.current === audio) audioRef.current = null; finish(); };
      audio.onerror = () => { if (audioRef.current === audio) audioRef.current = null; fallback(); };
      audio.play().catch(() => { if (audioRef.current === audio) audioRef.current = null; fallback(); });
    }).catch(fallback);   // endpoint unavailable (no key / 502) → browser voice
  };

  // ── message helpers ───────────────────────────────────────────────────────
  const pushMsg = (m: Omit<Msg, 'id' | 'ts'> & { ts?: number }) =>
    setMessages(list => [...list, { id: nextId(), ts: Date.now(), ...m }]);

  // ── the listen → think → speak loop ───────────────────────────────────────
  const maybeResume = () => {
    if (realtimeRef.current && !suspendedRef.current && !document.hidden) startListening();
    else setPhaseNow('idle');
  };

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) { maybeResume(); return; }
    pushMsg({ role: 'user', text });
    setLiveTranscript('');
    setPhaseNow('thinking');
    try {
      const res: ApolloCommandResult = await api.apolloCommand({
        text, tenant_id: selectedTenant ?? undefined,
      });
      pushMsg({ role: 'apollo', text: res.response || '…', action: res.action,
        result: res.result, status: res.status, latency: res.latency_ms });
      handleAction(res);
      loadHistory();
      if (settingsRef.current.speak && res.response) speakReply(res.response, maybeResume);
      else { setPhaseNow('idle'); maybeResume(); }
    } catch (e: any) {
      toast(e?.message || 'Apollo could not respond right now.', 'danger');
      pushMsg({ role: 'apollo', text: 'I ran into a problem reaching the server.', status: 'failed' });
      maybeResume();
    }
  };

  const handleAction = (res: ApolloCommandResult) => {
    if (res.action === 'open' && res.result && 'target' in res.result && res.result.url) {
      const w = window.open(res.result.url, '_blank', 'noopener');
      if (!w) toast(`Pop-up blocked — tap the link to open ${res.result.target}.`, 'warn');
    }
  };

  // ── Web Speech recognition ────────────────────────────────────────────────
  // Keep the mic open (continuous) and only close it after SILENCE_MS of quiet
  // following speech, so a natural pause never cuts the operator off.
  const clearSilence = () => {
    if (silenceRef.current) { window.clearTimeout(silenceRef.current); silenceRef.current = null; }
  };
  const armSilence = () => {
    clearSilence();
    silenceRef.current = window.setTimeout(() => {
      silenceRef.current = null;
      const rec = recognitionRef.current;   // onend then submits what we heard
      if (rec) { try { rec.stop(); } catch { /* ignore */ } }
    }, SILENCE_MS);
  };

  const startListening = () => {
    if (suspendedRef.current || document.hidden) return;
    const Ctor: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) { toast("Speech recognition isn't available — type to Apollo below.", 'warn'); return; }
    if (recognitionRef.current) return;
    cancelPlayback();   // new voice input interrupts Apollo mid-sentence
    // Warm up the selected mic so the browser uses the right device
    const warmMic = selectedMicId
      ? navigator.mediaDevices?.getUserMedia({ audio: { deviceId: selectedMicId } })
          .then(s => { s.getTracks().forEach(t => t.stop()); })
          .catch(() => {})
      : Promise.resolve();
    warmMic.then(() => {
      const rec = new Ctor();
      rec.lang = settingsRef.current.lang;
      rec.interimResults = true;
      rec.continuous = true;   // don't stop on the first pause — let speech flow
      finalRef.current = '';
      discardRef.current = false;
      setLiveTranscript('');

      rec.onresult = (e: any) => {
        let interim = '', finalT = finalRef.current;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const chunk = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalT += chunk + ' '; else interim += chunk;
        }
        finalRef.current = finalT;
        setLiveTranscript((finalT + ' ' + interim).trim());
        armSilence();   // reset the quiet-countdown on every word heard
      };
      rec.onerror = (e: any) => {
        const err = e?.error;
        if (err && err !== 'aborted' && err !== 'no-speech') toast(`Microphone error: ${err}`, 'danger');
      };
      rec.onend = () => {
        clearSilence();
        recognitionRef.current = null;
        const finalText = finalRef.current.trim();
        finalRef.current = '';
        setLiveTranscript('');
        if (discardRef.current) { discardRef.current = false; setPhaseNow('idle'); return; }
        if (finalText) { submit(finalText); return; }
        // nothing captured — keep the loop alive in real-time mode, throttled
        if (realtimeRef.current && !suspendedRef.current && !document.hidden) {
          restartRef.current = window.setTimeout(() => {
            restartRef.current = null;
            if (realtimeRef.current && !suspendedRef.current && !document.hidden
              && !recognitionRef.current && phaseRef.current !== 'thinking'
              && phaseRef.current !== 'speaking') startListening();
          }, 500);
        } else setPhaseNow('idle');
      };

      recognitionRef.current = rec;
      setPhaseNow('listening');
      rec.start();
    }).catch(() => {
      toast('Could not start the microphone.', 'danger');
      setPhaseNow('idle');
    });
  };

  const stopListening = () => {
    clearSilence();
    const rec = recognitionRef.current;
    if (rec) { try { rec.stop(); } catch { /* ignore */ } }
  };

  const abortListening = () => {
    discardRef.current = true;
    clearSilence();
    const rec = recognitionRef.current;
    if (rec) { try { rec.abort(); } catch { /* ignore */ } }
    recognitionRef.current = null;
    setPhaseNow('idle');
  };

  const toggleRealtime = () => {
    const next = !realtime;
    setRealtime(next); realtimeRef.current = next;
    if (next) {
      if (!suspendedRef.current && phaseRef.current === 'idle' && !recognitionRef.current) startListening();
    } else abortListening();
  };

  const resume = () => {
    setSuspended(false); suspendedRef.current = false;
    if (realtimeRef.current) startListening();
  };

  const onOrbClick = () => {
    if (suspendedRef.current) { resume(); return; }
    if (phase === 'thinking') return;
    if (phase === 'listening') stopListening();
    else startListening();
  };

  const onTextSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const t = textInput.trim();
    if (!t || phase === 'thinking') return;
    setTextInput('');
    submit(t);
  };

  const clearConversation = () => { setMessages([]); setLiveTranscript(''); };

  // suspend on tab switch; show "Tap to resume" on return (never auto-restart)
  controlsRef.current.suspend = () => {
    setSuspended(true); suspendedRef.current = true;
    abortListening();
    cancelPlayback();
  };
  useEffect(() => {
    const onVis = () => { if (document.hidden) controlsRef.current.suspend(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // stop everything on unmount
  useEffect(() => () => {
    mountedRef.current = false;
    discardRef.current = true;
    if (silenceRef.current) window.clearTimeout(silenceRef.current);
    if (restartRef.current) window.clearTimeout(restartRef.current);
    try { recognitionRef.current?.abort?.(); } catch { /* ignore */ }
    try { audioRef.current?.pause?.(); } catch { /* ignore */ }
    try { (window as any).speechSynthesis?.cancel?.(); } catch { /* ignore */ }
  }, []);

  // ── derived ───────────────────────────────────────────────────────────────
  const statusText = suspended ? 'Paused — tap to resume'
    : phase === 'listening' ? 'Listening…'
    : phase === 'thinking' ? 'Thinking…'
    : phase === 'speaking' ? 'Apollo is speaking…'
    : 'Apollo is ready';

  const latency = useMemo(() => {
    const vals = (history ?? []).map(c => c.latency_ms).filter(v => v > 0);
    if (!vals.length) return null;
    return {
      avg: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
      last: vals[0], best: Math.min(...vals), count: vals.length,
    };
  }, [history]);

  const creations = useMemo(
    () => (history ?? []).filter(c => c.action === 'build' && c.result && 'filename' in c.result && c.result.url),
    [history]);

  const voiceOptions = voices.filter(
    (v: any) => v.lang?.startsWith(settings.lang?.split('-')[0] || 'en'));
  const renderVoiceOptions = () => (
    <>
      <option value="">Default (browser voice)</option>
      {OPENAI_VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
      {voiceOptions.map((v: any) => (
        <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
      ))}
    </>
  );

  // ── floating collapsed panel ──────────────────────────────────────────────
  if (collapsed) {
    return (
      <>
        <div className="fixed bottom-5 right-5 z-40 w-[min(360px,calc(100vw-2.5rem))] glass-raised rounded-2xl border border-amber/20 shadow-2xl animate-fadeInUp">
          <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3">
            <Orb phase={phase} size="sm" onClick={onOrbClick} suspended={suspended} />
            <div className="min-w-0 flex-1">
              <div className="font-display text-sm font-bold text-ink">Apollo</div>
              <div className="truncate text-[11px] text-muted">{statusText}</div>
            </div>
            <button onClick={() => setCollapsed(false)} title="Expand"
              className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-white/6 hover:text-ink">
              <Icon name="open_in_full" size={18} />
            </button>
          </div>
          <div ref={logRef} className="max-h-[40vh] min-h-[6rem] space-y-2 overflow-y-auto px-3 py-3">
            {messages.length === 0
              ? <p className="px-1 py-6 text-center text-xs text-muted">Tap the orb and speak.</p>
              : messages.slice(-8).map(m => <Bubble key={m.id} m={m} compact />)}
          </div>
          <form onSubmit={onTextSubmit} className="flex items-center gap-2 border-t border-white/8 px-3 py-2.5">
            <Input value={textInput} onChange={e => setTextInput(e.target.value)}
              disabled={phase === 'thinking'} placeholder="Message Apollo…" className="flex-1" />
            <button type="submit" disabled={phase === 'thinking' || !textInput.trim()}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[#04222b] disabled:opacity-40"
              style={{ background: RED }}>
              <Icon name="send" size={18} />
            </button>
          </form>
        </div>
      </>
    );
  }

  // ── full-screen layout ────────────────────────────────────────────────────
  return (
    <div className="relative h-full w-full overflow-y-auto">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[520px]"
        style={{ background: 'radial-gradient(120% 80% at 50% -10%, rgba(245,158,11,0.13), transparent 62%)' }} />

      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-6 md:px-6 md:py-8">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 animate-fadeInUp">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl"
              style={{ background: 'rgba(245,158,11,0.14)', color: RED, boxShadow: '0 0 28px -6px rgba(245,158,11,0.55)' }}>
              <Icon name="auto_awesome" size={24} fill />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold text-ink">Apollo</h1>
              <p className="text-xs text-muted">Your real-time voice butler</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={speechAvailable ? 'warn' : 'neutral'} dot>
              {speechAvailable ? 'Voice ready' : 'Text only'}
            </Badge>
            <button onClick={() => setSideOpen(o => !o)} title="Toggle side panel"
              className="hidden h-9 w-9 place-items-center rounded-xl text-muted hover:bg-white/6 hover:text-ink lg:grid">
              <Icon name="view_sidebar" size={20} />
            </button>
            <button onClick={() => setCollapsed(true)} title="Collapse to panel"
              className="grid h-9 w-9 place-items-center rounded-xl text-muted hover:bg-white/6 hover:text-ink">
              <Icon name="close_fullscreen" size={20} />
            </button>
            <button onClick={() => setShowSettings(true)} title="Voice settings"
              className="grid h-9 w-9 place-items-center rounded-xl text-muted hover:bg-white/6 hover:text-ink">
              <Icon name="tune" size={20} />
            </button>
          </div>
        </div>

        {/* Hero */}
        <Card glass className="relative mb-6 overflow-hidden p-6 md:p-10 animate-fadeInUp">
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-40 blur-3xl"
              style={{ background: 'radial-gradient(circle, rgba(245,158,11,0.24), transparent 70%)' }} />
            <div className="absolute right-8 top-6 h-40 w-40 rounded-full opacity-20 blur-3xl animate-float"
              style={{ background: 'radial-gradient(circle, rgba(245,158,11,0.28), transparent 70%)' }} />
          </div>

          <div className="relative z-10 flex flex-col items-center gap-5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${phase === 'idle' && !suspended ? '' : 'animate-pulse'}`}
                style={{ background: suspended ? '#7B8DA8' : RED }} />
              <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                {phase === 'listening' ? 'Listening' : phase === 'thinking' ? 'Thinking'
                  : phase === 'speaking' ? 'Speaking' : suspended ? 'Paused' : 'Ready'}
              </span>
            </div>

            <Orb phase={phase} size="lg" onClick={onOrbClick} suspended={suspended} />
            <Waveform active={phase === 'listening' || phase === 'speaking'} />

            <div className="min-h-[3.5rem] max-w-md text-center">
              <p className="font-display text-lg font-semibold text-ink">{statusText}</p>
              {(phase === 'listening' || phase === 'thinking') && liveTranscript ? (
                <p className="mt-1 text-sm text-muted">“{liveTranscript}”</p>
              ) : suspended ? (
                <button onClick={resume}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold"
                  style={{ borderColor: `${RED}55`, color: RED }}>
                  <Icon name="play_arrow" size={16} /> Tap to resume
                </button>
              ) : phase === 'idle' ? (
                <p className="mt-1 text-xs text-muted/70">
                  {speechAvailable ? 'Tap the orb, or type below — “open YouTube”, “build a landing page”, “search for…”'
                    : 'Voice input isn’t supported here — type to Apollo below.'}
                </p>
              ) : null}
            </div>

            {/* controls: real-time · voice · speak */}
            <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
              <label className="flex items-center gap-2 text-sm">
                <span className="font-medium text-ink">Real-time</span>
                <Toggle checked={realtime} onChange={toggleRealtime} disabled={!speechAvailable} />
              </label>
              <div className="flex items-center gap-2 text-sm">
                <Icon name="record_voice_over" size={18} className="text-muted" />
                <select value={settings.voiceUri}
                  onChange={e => setSettings(s => ({ ...s, voiceUri: e.target.value }))}
                  className="max-w-[210px] rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-ink focus:border-amber/50 focus:outline-none">
                  {renderVoiceOptions()}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <span className="font-medium text-ink">Speak</span>
                <Toggle checked={settings.speak}
                  onChange={() => setSettings(s => ({ ...s, speak: !s.speak }))} />
              </label>
            </div>

            {/* text input */}
            <form onSubmit={onTextSubmit} className="flex w-full max-w-md items-center gap-2">
              <Input value={textInput} onChange={e => setTextInput(e.target.value)}
                disabled={phase === 'thinking'}
                placeholder={speechAvailable ? 'Or type a command to Apollo…' : 'Type a command to Apollo…'}
                className="flex-1" />
              <button type="submit" disabled={phase === 'thinking' || !textInput.trim()}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-[#04222b] transition-all active:scale-95 disabled:opacity-40"
                style={{ background: RED, boxShadow: '0 0 20px rgba(245,158,11,0.35)' }}>
                <Icon name="send" size={18} /> Send
              </button>
            </form>

            {/* Every exchange is persisted to the Memory Galaxy by the backend. */}
            <button onClick={() => navigate('/galaxy')}
              className="inline-flex items-center gap-1.5 text-[11px] text-muted/70 transition-colors hover:text-amber">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: RED, boxShadow: `0 0 8px ${RED}` }} />
              Conversations saved to the galaxy
            </button>
          </div>
        </Card>

        {/* Conversation + side panel */}
        <div className={`grid gap-6 ${sideOpen ? 'lg:grid-cols-[1fr,320px]' : 'grid-cols-1'}`}>
          {/* Conversation */}
          <Card glass className="flex min-h-[22rem] flex-col p-4 animate-fadeInUp md:p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color: RED }}>
                <Icon name="forum" size={16} /> Conversation
              </div>
              {messages.length > 0 && (
                <button onClick={clearConversation}
                  className="inline-flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-rose">
                  <Icon name="delete_sweep" size={16} /> Clear conversation
                </button>
              )}
            </div>
            <div ref={logRef} className="flex-1 space-y-3 overflow-y-auto pr-1" style={{ maxHeight: '52vh' }}>
              {messages.length === 0 ? (
                <div className="flex h-full min-h-[16rem] items-center justify-center">
                  <EmptyState icon="graphic_eq" accent={RED} title="Configure Apollo voice agent"
                    hint="Pick a voice, then ask a question or give a command like “open GitHub”, “search for the weather in Tokyo”, or “build a pricing page”."
                    action={
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button variant="glass" icon="tune" onClick={() => setShowSettings(true)}>Configure voice</Button>
                        <Button variant="ghost" icon="history" onClick={() => setSideOpen(true)} className="hidden lg:inline-flex">
                          Command history
                        </Button>
                      </div>
                    } />
                </div>
              ) : messages.map(m => <Bubble key={m.id} m={m} />)}
            </div>
          </Card>

          {/* Side panel */}
          {sideOpen && (
            <div className="space-y-4">
              <SidePanel title="Command history" icon="history" count={history?.length}>
                {history === null ? <Loading />
                  : historyError ? (
                    <div className="flex items-center justify-between gap-2 rounded-xl border border-rose/20 bg-rose/5 px-3 py-2">
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                        <Icon name="error" size={14} className="shrink-0 text-rose" />
                        <span className="truncate">Couldn't load history.</span>
                      </span>
                      <button onClick={loadHistory}
                        className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-muted transition-colors hover:text-ink">
                        <Icon name="refresh" size={14} /> Retry
                      </button>
                    </div>
                  )
                  : history.length === 0 ? <Empty text="No commands yet." />
                  : history.slice(0, 12).map(c => (
                    <div key={c.id} className="rounded-xl border border-white/6 bg-white/[0.02] px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <p className="line-clamp-2 flex-1 text-xs text-ink">{c.text}</p>
                        <Badge tone={c.status === 'failed' ? 'danger' : 'ok'}>
                          {c.status === 'failed' ? 'failed' : 'done'}
                        </Badge>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted/70">
                        {c.action && <IntentChip action={c.action} />}
                        <span>{timeAgo(c.created_at)}</span>
                        {c.latency_ms > 0 && <><span>·</span><span>{fmtMs(c.latency_ms)}</span></>}
                      </div>
                    </div>
                  ))}
              </SidePanel>

              <SidePanel title="Latency" icon="speed">
                {!latency ? <Empty text="No timings yet." /> : (
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <LatCell label="Avg" value={fmtMs(latency.avg)} />
                    <LatCell label="Last" value={fmtMs(latency.last)} />
                    <LatCell label="Best" value={fmtMs(latency.best)} />
                  </div>
                )}
              </SidePanel>

              <SidePanel title="Recent creations" icon="auto_awesome" count={creations.length || undefined}>
                {creations.length === 0 ? <Empty text="Nothing built yet — try “build a…”." />
                  : creations.slice(0, 8).map(c => {
                    const r = c.result as { url: string; title?: string; filename: string };
                    return (
                      <a key={c.id} href={r.url} target="_blank" rel="noreferrer"
                        className="flex items-center gap-2 rounded-xl border border-amber/15 bg-amber/5 px-3 py-2 transition-colors hover:bg-amber/10">
                        <Icon name="draft" size={18} style={{ color: RED }} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium text-ink">{r.title || c.text}</span>
                          <span className="block text-[10px] text-muted/70">{timeAgo(c.created_at)}</span>
                        </span>
                        <Icon name="open_in_new" size={15} className="text-muted" />
                      </a>
                    );
                  })}
              </SidePanel>
            </div>
          )}
        </div>
      </div>

      {/* Settings */}
      <Modal open={showSettings} onClose={() => setShowSettings(false)} title="Apollo settings">
        <div className="space-y-5">
          <div>
            <label htmlFor={voiceFieldId} className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Voice</label>
            <select id={voiceFieldId} value={settings.voiceUri}
              onChange={e => setSettings(s => ({ ...s, voiceUri: e.target.value }))}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-base text-ink focus:border-amber/50 focus:outline-none">
              {renderVoiceOptions()}
            </select>
            <p className="mt-1 text-[11px] text-muted/70">Apollo speaks with natural OpenAI voices; browser voices are also available.</p>
          </div>
          <div>
            <label htmlFor={micFieldId} className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Microphone</label>
            <select id={micFieldId} value={selectedMicId}
              onChange={e => setSelectedMicId(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-base text-ink focus:border-amber/50 focus:outline-none">
              <option value="">System default microphone</option>
              {audioDevices.map(d => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted/70">
              {audioDevices.length === 0
                ? 'No microphones detected — grant microphone permission first.'
                : 'Switch to choose a different mic (the change takes effect on the next listen).'}
            </p>
          </div>
          <div>
            <label htmlFor={langFieldId} className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Recognition language</label>
            <select id={langFieldId} value={settings.lang}
              onChange={e => setSettings(s => ({ ...s, lang: e.target.value }))}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-base text-ink focus:border-amber/50 focus:outline-none">
              {LANGS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted">Speak replies</label>
              <p className="mt-0.5 text-[11px] text-muted/70">Apollo reads answers aloud.</p>
            </div>
            <Toggle checked={settings.speak}
              onChange={() => setSettings(s => ({ ...s, speak: !s.speak }))} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted">Always listen</label>
              <p className="mt-0.5 text-[11px] text-muted/70">
                {speechAvailable ? 'Keep the mic open for hands-free, continuous conversation.'
                  : 'Voice input isn’t supported in this browser.'}
              </p>
            </div>
            <Toggle checked={realtime} disabled={!speechAvailable} onChange={toggleRealtime} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted">Wake word (“Apollo”)</label>
              <p className="mt-0.5 text-[11px] text-muted/70">Hands-free activation — coming soon.</p>
            </div>
            <Toggle checked={settings.wakeWord}
              onChange={() => setSettings(s => ({ ...s, wakeWord: !s.wakeWord }))} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted">Real-time mode (WebSocket)</label>
              <p className="mt-0.5 text-[11px] text-muted/70">Low-latency streaming voice — coming soon.</p>
            </div>
            <Toggle checked={settings.realtimeWs}
              onChange={() => setSettings(s => ({ ...s, realtimeWs: !s.realtimeWs }))} />
          </div>
          <div className="flex justify-end pt-1">
            <Button variant="primary" icon="check" onClick={() => setShowSettings(false)}
              style={{ background: RED, color: '#04222b' }}>Done</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

const fmtMs = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

// ── Circular Equalizer Orb — KITT-inspired graphic equalizer ────────────────
function Orb({ phase, size, onClick, suspended }:
  { phase: Phase; size: 'sm' | 'lg'; onClick: () => void; suspended: boolean }) {
  const listening = phase === 'listening';
  const thinking = phase === 'thinking';
  const speaking = phase === 'speaking';
  const active = listening || thinking || speaking;

  // Generate cube data once
  const [cubes] = useState(() => {
    const result: { ringIdx: number; angle: number; ringR: number; i: number; n: number; phaseOff: number; baseX: number; baseY: number; w: number; h: number }[] = [];
    const rings = [
      { n: 12, r: 26, w: 10, h: 7 },
      { n: 18, r: 48, w: 9, h: 7 },
      { n: 24, r: 70, w: 8, h: 7 },
      { n: 30, r: 92, w: 7, h: 7 },
      { n: 36, r: 114, w: 6, h: 7 },
    ];
    rings.forEach((ring, ri) => {
      for (let i = 0; i < ring.n; i++) {
        const angle = (i / ring.n) * 360 - 90;
        const rad = (angle * Math.PI) / 180;
        result.push({
          ringIdx: ri, angle, ringR: ring.r, i, n: ring.n,
          phaseOff: (i / ring.n) * Math.PI * 2,
          baseX: 130 + ring.r * Math.cos(rad),
          baseY: 130 + ring.r * Math.sin(rad),
          w: ring.w, h: ring.h,
        });
      }
    });
    return result;
  });

  const rafRef = useRef<number>(0);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rects = svg.querySelectorAll('rect');
    let running = true;

    const animate = (ts: number) => {
      if (!running) return;
      const t = ts * 0.002;
      cubes.forEach((c, idx) => {
        const rect = rects[idx];
        if (!rect) return;
        const relR = c.ringR / 114;
        let val: number, isRed: boolean;

        if (!active) {
          val = 0.02 + Math.sin(t * 0.3 + c.phaseOff) * 0.02 + 0.02;
          isRed = true;
        } else if (listening) {
          const w1 = Math.sin(t * 2.5 - relR * 7 + c.phaseOff) * 0.5 + 0.5;
          const w2 = Math.sin(t * 1.8 + c.angle * 0.04) * 0.3 + 0.3;
          const w3 = Math.sin(t * 3.2 - relR * 4 + c.angle * 0.02) * 0.2 + 0.2;
          val = 0.03 + (w1 * 0.4 + w2 * 0.2 + w3 * 0.15);
          isRed = false;
        } else {
          const band = Math.floor((c.angle + 90 + 15) / 30) % 12;
          const sweep = Math.sin(t * 2.2 + band * 0.6) * 0.5 + 0.5;
          const freq = Math.sin(t * 3.5 + relR * 8 + c.angle * 0.03) * 0.5 + 0.5;
          const pop = Math.sin(t * 5 + c.phaseOff * 2) * 0.5 + 0.5;
          const ringBoost = 0.3 + relR * 0.7;
          val = 0.03 + (sweep * 0.3 + freq * 0.25 + pop * 0.15) * ringBoost;
          isRed = true;
        }

        val = Math.max(0.02, Math.min(val, 1));
        rect.setAttribute('fill', isRed ? '#EF4444' : '#38BDF8');
        rect.setAttribute('opacity', String(val));
        rect.setAttribute('filter', val > 0.3 ? 'url(#glo)' : 'none');
        
        const scale = val > 0.5 ? 1 + (val - 0.5) * 0.15 : 1;
        rect.setAttribute('transform', `rotate(${c.angle + 90}, ${c.baseX}, ${c.baseY}) scale(${scale})`);
      });
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, [active, listening, thinking, speaking, cubes]);

  return size === 'lg' ? (
    <button type="button" onClick={onClick} disabled={thinking}
      aria-label={listening ? 'Stop listening' : 'Start listening'}
      className="relative flex flex-col items-center gap-4 cursor-pointer active:scale-[0.97] transition-transform disabled:cursor-not-allowed">
      <div className="relative flex items-center justify-center" style={{ width: '340px', height: '340px' }}>
        {/* Outer glow */}
        <div className="absolute inset-0 rounded-full transition-opacity duration-700 pointer-events-none"
          style={{
            background: speaking || thinking ? 'radial-gradient(circle, rgba(239,68,68,0.06), transparent 70%)' :
              listening ? 'radial-gradient(circle, rgba(56,189,248,0.04), transparent 70%)' : 'transparent',
            opacity: active ? 0.6 : 0,
          }} />
        {/* Dark housing */}
        <div className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle at 45% 40%, #0f0f18, #06060a)',
            boxShadow: 'inset 0 0 80px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.03)',
          }} />
        {/* Glass reflection */}
        <div className="absolute inset-0 rounded-full pointer-events-none z-10"
          style={{
            background: 'linear-gradient(160deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 30%, transparent 50%, rgba(255,255,255,0.02) 70%, transparent 100%)',
          }} />
        {/* Inner ring border */}
        <div className="absolute rounded-full pointer-events-none z-10"
          style={{ width: '88%', height: '88%', border: '1px solid rgba(255,255,255,0.03)', top: '6%', left: '6%' }} />
        {/* Cubes SVG */}
        <svg ref={svgRef} className="cubes absolute z-20" viewBox="0 0 260 260"
          style={{ width: '88%', height: '88%', top: '6%', left: '6%' }}>
          <defs>
            <filter id="glo" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {cubes.map((c, i) => (
            <rect key={i}
              x={c.baseX - c.w / 2} y={c.baseY - c.h / 2}
              width={c.w} height={c.h} rx="1.5" ry="1.5"
              transform={`rotate(${c.angle + 90}, ${c.baseX}, ${c.baseY})`}
              fill="#EF4444" opacity="0.03" />
          ))}
        </svg>
        {/* Center dot */}
        <div className="absolute z-30 w-[5px] h-[5px] rounded-full transition-all duration-500"
          style={{
            background: speaking ? '#EF4444' : listening ? '#38BDF8' : 'rgba(245,158,11,0.15)',
            boxShadow: speaking ? '0 0 10px rgba(239,68,68,0.5)' : listening ? '0 0 10px rgba(56,189,248,0.4)' : 'none',
          }} />
      </div>
      <span className="text-[10px] font-semibold uppercase tracking-[0.3em] transition-colors duration-300"
        style={{ color: speaking ? '#EF4444' : listening ? '#38BDF8' : thinking ? '#EF444480' : 'rgba(245,158,11,0.3)' }}>
        {speaking ? 'SPEAKING' : thinking ? 'PROCESSING' : listening ? 'LISTENING' : suspended ? 'STANDBY' : 'TAP TO SPEAK'}
      </span>
    </button>
  ) : (
    <button type="button" onClick={onClick} disabled={thinking}
      className="h-11 w-11 rounded-full transition-all"
      style={{
        background: active ? (speaking ? '#EF4444' : '#38BDF8') : '#EF444420',
        boxShadow: active ? '0 0 16px rgba(239,68,68,0.5)' : 'none',
      }}
      aria-label={listening ? 'Stop' : 'Talk to Apollo'} />
  );
}

// ── Waveform — amber bars that react while listening ─────────────────────────
// ── KITT Scanner — Knight Rider front LED bar ────────────────────────────────
function Waveform({ active }: { active: boolean }) {
  const scanRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scanRef.current;
    if (!el || !active) return;
    let pos = 0, dir = 1, raf = 0;
    const animate = () => {
      pos += dir * 3;
      if (pos > 200) dir = -1;
      if (pos < 0) dir = 1;
      el.style.transform = `translateX(${pos}px)`;
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  
  return (
    <div className="relative h-[6px] w-[260px] max-w-[85vw] overflow-hidden rounded-full"
      style={{ background: 'rgba(239,68,68,0.06)' }}>
      <div ref={scanRef}
        className="absolute top-0 h-full rounded-full transition-none"
        style={{
          width: '80px',
          left: '-80px',
          background: 'linear-gradient(90deg, transparent, #EF4444, #EF444488, transparent)',
          boxShadow: '0 0 14px rgba(239,68,68,0.5), 0 0 30px rgba(239,68,68,0.15)',
          opacity: active ? 1 : 0.15,
        }} />
    </div>
  );
}

// ── Message bubble ───────────────────────────────────────────────────────────
function Bubble({ m, compact }: { m: Msg; compact?: boolean }) {
  const isUser = m.role === 'user';
  return (
    <div className={`flex items-end gap-2 ${isUser ? 'flex-row-reverse' : ''} animate-fadeInUp`}>
      {!compact && (
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full"
          style={isUser
            ? { background: 'rgba(56,189,248,0.15)', color: '#38BDF8' }
            : { background: 'rgba(245,158,11,0.15)', color: RED }}>
          <Icon name={isUser ? 'person' : 'auto_awesome'} size={17} fill={!isUser} />
        </div>
      )}
      <div className={`min-w-0 max-w-[85%] ${isUser ? 'items-end text-right' : ''}`}>
        <div className={`rounded-2xl px-3 py-2 text-sm leading-relaxed ${isUser
          ? 'rounded-br-sm border border-sky/20 bg-sky/10 text-ink'
          : 'rounded-bl-sm border border-amber/15 bg-amber/[0.07] text-ink'}`}>
          {m.text}
          {!isUser && m.action && m.result && <ActionResult action={m.action} result={m.result} />}
        </div>
        <div className={`mt-0.5 flex items-center gap-1.5 px-1 text-[10px] text-muted/70 ${isUser ? 'justify-end' : ''}`}>
          <span>{clock(m.ts)}</span>
          {!isUser && m.latency ? <><span>·</span><span>{fmtMs(m.latency)}</span></> : null}
          {m.status === 'failed' && <Badge tone="danger">failed</Badge>}
        </div>
      </div>
    </div>
  );
}

// ── Action result rendered under an Apollo message ──────────────────────────
function ActionResult({ action, result }: { action: ApolloAction; result: ApolloResult }) {
  if (!result) return null;
  if (action === 'open' && 'target' in result && result.url) {
    return (
      <a href={result.url} target="_blank" rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber/25 bg-amber/10 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-amber/20"
        style={{ color: RED }}>
        <Icon name="open_in_new" size={15} /> Open {result.target}
      </a>
    );
  }
  if (action === 'build' && 'filename' in result && result.url) {
    return (
      <a href={result.url} target="_blank" rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber/25 bg-amber/10 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-amber/20"
        style={{ color: RED }}>
        <Icon name="visibility" size={15} /> View creation
      </a>
    );
  }
  if (action === 'search' && 'results' in result) {
    const hits = result.results || [];
    if (!hits.length) return null;
    return (
      <div className="mt-2 space-y-1.5 border-t border-white/8 pt-2">
        {hits.slice(0, 4).map((h, i) => (
          <a key={i} href={h.url} target="_blank" rel="noreferrer"
            className="flex items-start gap-1.5 text-xs text-muted transition-colors hover:text-ink">
            <Icon name="link" size={14} className="mt-0.5 shrink-0" style={{ color: RED }} />
            <span className="line-clamp-1">{h.title}</span>
          </a>
        ))}
      </div>
    );
  }
  return null;
}

// ── Side-panel bits ──────────────────────────────────────────────────────────
function SidePanel({ title, icon, count, children }:
  { title: string; icon: string; count?: number; children: ReactNode }) {
  return (
    <Card glass className="p-3.5 animate-fadeInUp">
      <div className="mb-2.5 flex items-center gap-2">
        <Icon name={icon} size={16} style={{ color: RED }} />
        <h2 className="font-display text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
        {typeof count === 'number' && <Badge tone="neutral">{count}</Badge>}
      </div>
      <div className="space-y-2">{children}</div>
    </Card>
  );
}

function IntentChip({ action }: { action: ApolloAction }) {
  const icon = action === 'open' ? 'open_in_new' : action === 'build' ? 'construction' : 'search';
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full bg-amber/10 px-1.5 py-0.5" style={{ color: RED }}>
      <Icon name={icon} size={11} /> {action}
    </span>
  );
}

function LatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/6 bg-white/[0.02] py-2">
      <div className="font-display text-base font-bold text-ink">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted/70">{label}</div>
    </div>
  );
}

const Empty = ({ text }: { text: string }) => <p className="px-1 py-2 text-xs text-muted/70">{text}</p>;
const Loading = () => (
  <div className="space-y-2">
    {[0, 1, 2].map(i => <div key={i} className="h-12 rounded-xl bg-white/5 animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />)}
  </div>
);
