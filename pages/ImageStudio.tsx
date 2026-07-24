// Image Studio — a full Fal.ai generation cockpit. Left: prompt + settings.
// Right: output + session gallery. Talks to /api/studio/generate + /models.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, EmptyState, Icon, Input, Select, Textarea, Toggle, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import type { StudioModel, StudioImage } from '../lib/types';

// ── Static config ──────────────────────────────────────────────────────────
const ASPECTS: Array<{ id: string; label: string; icon: string }> = [
  { id: '1:1', label: '1:1', icon: 'crop_square' },
  { id: '16:9', label: '16:9', icon: 'crop_16_9' },
  { id: '9:16', label: '9:16', icon: 'crop_portrait' },
  { id: '4:3', label: '4:3', icon: 'crop_landscape' },
  { id: '3:2', label: '3:2', icon: 'crop_3_2' },
  { id: '2:3', label: '2:3', icon: 'crop_portrait' },
  { id: '3:4', label: '3:4', icon: 'crop_portrait' },
];
const ASPECT_DIMS: Record<string, [number, number]> = {
  '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344],
  '4:3': [1152, 896], '3:4': [896, 1152], '3:2': [1216, 832], '2:3': [832, 1216],
};
const STYLE_PRESETS: Array<{ name: string; kw: string }> = [
  { name: 'Photorealistic', kw: 'photorealistic, ultra detailed, 50mm, natural lighting' },
  { name: 'Cinematic', kw: 'cinematic lighting, dramatic, film grain, anamorphic, moody' },
  { name: 'Anime', kw: 'anime style, cel shaded, vibrant, studio quality' },
  { name: 'Digital Art', kw: 'digital art, concept art, trending on artstation, highly detailed' },
  { name: 'Oil Painting', kw: 'oil painting, textured brushstrokes, classical, rich colours' },
  { name: '3D Render', kw: '3d render, octane, ray tracing, subsurface scattering' },
  { name: 'Pixel Art', kw: 'pixel art, 16-bit, retro game sprite' },
  { name: 'Sketch', kw: 'pencil sketch, hand drawn, cross hatching, monochrome' },
  { name: 'Watercolour', kw: 'watercolour painting, soft washes, paper texture' },
  { name: 'Minimalist', kw: 'minimalist, clean, negative space, simple palette' },
];

type HistoryItem = StudioImage & { prompt: string };

const STUDIO_HISTORY_KEY = 'agentos_studio_history';

export default function ImageStudio() {
  const toast = useToast();
  const { selectedTenant } = useApp();
  const sessionId = useRef(`s${Date.now()}`).current;

  const [models, setModels] = useState<StudioModel[]>([]);
  const [model, setModel] = useState('flux_schnell');
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [showNegative, setShowNegative] = useState(false);
  const [aspect, setAspect] = useState('1:1');
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  const [numImages, setNumImages] = useState(1);
  const [randomSeed, setRandomSeed] = useState(true);
  const [seed, setSeed] = useState('');
  const [steps, setSteps] = useState(4);
  const [guidance, setGuidance] = useState(7.5);
  const [safeMode, setSafeMode] = useState(true);
  const [usedPresets, setUsedPresets] = useState<Set<string>>(new Set());

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const raw = localStorage.getItem(STUDIO_HISTORY_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return [];
  });
  const [current, setCurrent] = useState<HistoryItem | null>(null);

  // Persist history to localStorage whenever it changes
  useEffect(() => {
    try { localStorage.setItem(STUDIO_HISTORY_KEY, JSON.stringify(history.slice(0, 40))); } catch { /* ignore */ }
  }, [history]);

  const styleRef = useRef<HTMLDivElement>(null);
  const [styleOpen, setStyleOpen] = useState(false);

  const spec = useMemo(() => models.find(m => m.id === model), [models, model]);

  useEffect(() => {
    api.studioModels()
      .then(r => {
        setModels(r.models);
        if (r.models.length && !r.models.some(m => m.id === model)) setModel(r.models[0].id);
      })
      .catch(() => toast('Could not load studio models', 'danger'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Adopt the model's default step count whenever the model changes.
  useEffect(() => { if (spec) setSteps(spec.steps); }, [spec?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirrors server-side studio.estimate_cost — an estimate, not billing truth.
  const estCost = useMemo(() => {
    if (!spec) return '0.00';
    const stepFactor = Math.max(0.5, (steps || spec.steps) / Math.max(1, spec.steps));
    return (spec.cost * stepFactor * Math.max(1, numImages)).toFixed(3);
  }, [spec, steps, numImages]);

  const applyPreset = (p: { name: string; kw: string }) => {
    setPrompt(v => (v.trim() ? `${v.trim()}, ${p.kw}` : p.kw));
    setUsedPresets(s => new Set(s).add(p.name));
  };

  const generate = async (opts?: { seedOverride?: number | null }) => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setError(null);
    const dims = ASPECT_DIMS[aspect];
    try {
      const res = await api.studioGenerate({
        prompt: prompt.trim(),
        negative_prompt: negative.trim() || undefined,
        model,
        aspect_ratio: aspect,
        width: customW ? Number(customW) : dims?.[0],
        height: customH ? Number(customH) : dims?.[1],
        num_images: numImages,
        seed: opts?.seedOverride ?? (randomSeed ? undefined : seed || undefined),
        steps,
        guidance: spec?.guidance ? guidance : undefined,
        safe_mode: safeMode,
        session_id: sessionId,
        tenant_id: selectedTenant ?? undefined,
      });
      const items: HistoryItem[] = res.images.map(img => ({ ...img, prompt: prompt.trim() }));
      if (items.length) {
        setHistory(h => [...items, ...h].slice(0, 40));
        setCurrent(items[0]);
        // Gallery rows are written server-side during generation; the client
        // only adds the prompt as a memory star in the Galaxy.
        api.vaultAddMemory({
          tenant_id: selectedTenant ?? undefined,
          topic: 'studio',
          fact: prompt.trim(),
          metadata: {
            url: items[0].url,
            model,
            aspect,
            images: String(items.length),
          },
        }).catch(() => {});
        const saved = res.saved ?? 0;
        if (saved) {
          toast(`${saved} image${saved > 1 ? 's' : ''} saved — check Gallery & Galaxy`, 'ok');
        } else {
          toast('Generated, but the Gallery save failed — download to keep it', 'danger');
        }
      }
    } catch (e: any) {
      setError(e?.message || 'Generation failed — check the Fal connection in Integrations.');
    } finally {
      setGenerating(false);
    }
  };

  const download = (item: HistoryItem) => {
    const a = document.createElement('a');
    a.href = item.url;
    a.download = `studio-${item.seed ?? Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const copyImage = async (item: HistoryItem) => {
    try {
      const blob = await fetch(item.url).then(r => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      toast('Image copied', 'ok');
    } catch {
      try {
        await navigator.clipboard.writeText(new URL(item.url, location.origin).href);
        toast('Image URL copied', 'ok');
      } catch {
        toast('Copy failed', 'danger');
      }
    }
  };

  // Reuse an image's prompt + seed as the starting point for a tweaked rerun.
  const useAsVariation = (item: HistoryItem) => {
    setPrompt(item.prompt);
    if (item.seed != null) { setSeed(String(item.seed)); setRandomSeed(false); }
    toast('Prompt & seed loaded — tweak and regenerate', 'info');
  };

  return (
    <div className="flex h-full flex-col">
      {/* ── TOP: settings bar ──────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/6 bg-surface/60 px-4 py-2.5 backdrop-blur">
        <div className="mr-1 flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-xl"
            style={{ background: '#C084FC1a', color: '#C084FC', boxShadow: '0 0 18px -6px #C084FC99' }}>
            <Icon name="palette" size={17} />
          </div>
          <h1 className="font-display text-sm font-bold tracking-wide text-ink">Studio</h1>
        </div>
        <div className="hidden h-5 w-px bg-white/8 sm:block" />
        <select value={model} onChange={e => setModel(e.target.value)} disabled={!models.length}
          className="h-8 rounded-lg border border-white/10 bg-black/30 px-2 text-xs font-semibold text-ink transition-colors hover:border-white/25 focus:border-accent/50 focus:outline-none disabled:opacity-50">
          {models.length === 0
            ? <option value="">No models available</option>
            : models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <div className="flex gap-1 rounded-lg border border-white/8 bg-black/20 p-0.5">
          {ASPECTS.slice(0,5).map(a => (
            <button key={a.id} onClick={() => setAspect(a.id)} title={`Aspect ${a.label}`}
              className={`grid h-7 place-items-center rounded-md px-1.5 text-[10px] font-semibold transition-all
                ${aspect === a.id
                  ? 'bg-accent/15 text-accent shadow-[0_0_10px_-2px_rgba(25,195,230,0.5)]'
                  : 'text-muted hover:bg-white/5 hover:text-ink'}`}>
              {a.label}
            </button>
          ))}
        </div>
        <div className="flex h-8 items-center gap-1.5 rounded-lg border border-white/8 bg-black/20 px-2 text-xs text-muted">
          <span className="text-[10px] font-semibold uppercase tracking-wide">Steps</span>
          <input type="range" min={1} max={spec?.max_steps || 50} value={steps}
            onChange={e => setSteps(Number(e.target.value))} className="h-1 w-16 accent-[#C084FC]" />
          <span className="w-4 font-mono text-[11px] text-ink">{steps}</span>
        </div>
        <div className="flex h-8 items-center gap-1 rounded-lg border border-white/8 bg-black/20 px-2 text-xs text-muted"
          title="Images per run">
          <Icon name="collections" size={13} />
          <select value={numImages} onChange={e => setNumImages(Number(e.target.value))}
            className="bg-transparent text-xs font-semibold text-ink focus:outline-none">
            {[1,2,3,4].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button onClick={() => setRandomSeed(v => !v)}
          title={randomSeed ? 'Random seed — click to lock' : 'Locked seed — click to randomise'}
          className={`flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-semibold transition-all
            ${!randomSeed ? 'border-accent/50 bg-accent/10 text-accent' : 'border-white/10 text-muted hover:border-white/25 hover:text-ink'}`}>
          <Icon name={randomSeed ? 'casino' : 'tag'} size={14} />
          {randomSeed ? 'Random' : (seed || '?')}
        </button>
        <div className="relative" ref={styleRef}>
          <button onClick={() => setStyleOpen(v => !v)}
            className={`flex h-8 items-center gap-1 rounded-lg border px-2 text-[11px] font-semibold transition-all
              ${styleOpen ? 'border-violet/50 bg-violet/10 text-violet' : 'border-white/10 text-muted hover:border-white/25 hover:text-ink'}`}>
            <Icon name="style" size={14} />
            Style
            <Icon name="expand_more" size={14} className={`transition-transform duration-200 ${styleOpen ? 'rotate-180' : ''}`} />
          </button>
          {styleOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setStyleOpen(false)} />
              <div className="absolute right-0 top-full z-20 mt-1.5 w-52 glass-raised rounded-xl p-2 shadow-2xl animate-fadeInUp">
                <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted/60">
                  Style presets
                </div>
                <div className="flex flex-wrap gap-1">
                  {STYLE_PRESETS.map(p => (
                    <button key={p.name} onClick={() => { applyPreset(p); setStyleOpen(false); }}
                      className={`rounded-full border px-2 py-0.5 text-[10px] transition-all active:scale-95 ${usedPresets.has(p.name) ? 'border-violet/50 bg-violet/10 text-ink' : 'border-white/10 text-muted hover:border-violet/30 hover:text-ink'}`}>
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <label className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-[11px] font-semibold transition-all
          ${safeMode ? 'border-emerald/40 bg-emerald/10 text-emerald' : 'border-white/10 text-muted hover:border-white/25'}`}>
          <input type="checkbox" checked={safeMode} onChange={e => setSafeMode(e.target.checked)}
            className="hidden" />
          <Icon name={safeMode ? 'verified_user' : 'gpp_maybe'} size={14} />
          Safe
        </label>
      </div>

      {/* ── CENTRE: output ─────────────────────────────── */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-black/40 p-4">
        {/* faint violet studio glow */}
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_45%_40%_at_50%_45%,rgba(192,132,252,0.06),transparent_70%)]" />
        {generating ? (
          <div className="relative flex w-full max-w-lg flex-col items-center gap-4">
            {/* skeleton canvas + render beam sweeping down it while the model paints */}
            <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-violet/20 shadow-[0_0_60px_-18px_rgba(192,132,252,0.5)]"
              style={{ aspectRatio: aspect.replace(':', ' / '), maxHeight: '52vh' }}>
              <div className="skeleton absolute inset-0" />
              <div className="render-scan" />
            </div>
            <div className="max-w-md text-center text-sm text-muted line-clamp-2">{prompt}</div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <Icon name="progress_activity" size={16} className="animate-spin text-[#C084FC]" /> Rendering with {spec?.label}…
            </div>
          </div>
        ) : error ? (
          <div className="relative flex flex-col items-center gap-3 text-center animate-fadeInUp">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose/15 text-rose shadow-[0_0_32px_-8px_rgba(244,63,94,0.5)]">
              <Icon name="error" size={26} />
            </div>
            <div className="max-w-sm text-sm text-muted">{error}</div>
            <Button variant="secondary" icon="refresh" onClick={() => generate()}>Retry</Button>
          </div>
        ) : current ? (
          <div className="relative flex h-full w-full flex-col items-center justify-center gap-4">
            <div key={current.url} className="relative animate-reveal">
              <div className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(ellipse_at_center,rgba(192,132,252,0.16),transparent_70%)] blur-xl" />
              <img src={current.url} alt={current.prompt}
                className="max-h-[60vh] max-w-full rounded-2xl object-contain shadow-[0_24px_80px_-16px_rgba(0,0,0,0.8)] ring-1 ring-white/10" />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="secondary" icon="download" onClick={() => download(current)}>Download</Button>
              <Button variant="secondary" icon="content_copy" onClick={() => copyImage(current)}>Copy</Button>
              <Button variant="secondary" icon="refresh" onClick={() => generate({ seedOverride: current.seed })}>Regen</Button>
              <Button variant="secondary" icon="alt_route" onClick={() => useAsVariation(current)}>Variation</Button>
            </div>
            <div className="font-mono text-[11px] text-muted/70">{current.model} · seed {current.seed ?? '—'}</div>
          </div>
        ) : (
          <div className="relative">
            <EmptyState large icon="palette" accent="#C084FC" title="Your canvas awaits"
              hint="Describe anything — the studio renders it in seconds and files it in your Gallery.">
              <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted/60">
                <kbd className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5">Enter</kbd>
                generate
                <span className="text-muted/30">·</span>
                <kbd className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5">Shift+Enter</kbd>
                new line
              </div>
            </EmptyState>
          </div>
        )}
      </div>

      {/* ── GALLERY STRIP ───────────────────────────────── */}
      {history.length > 0 && (
        <div className="border-t border-white/6 bg-gradient-to-t from-surface/70 to-surface/30 px-4 py-2.5">
          <div className="flex items-center gap-2.5 overflow-x-auto pb-0.5 pt-1.5">
            <span className="flex shrink-0 items-center gap-1.5 pr-1 font-mono text-[10px] uppercase tracking-widest text-muted/60">
              <Icon name="history" size={13} />
              {history.length}
            </span>
            {history.map((item, i) => (
              <div key={i} className="group relative shrink-0">
                <button onClick={() => setCurrent(item)} title={item.prompt}
                  className={`block overflow-hidden rounded-xl transition-all duration-200
                    ${current?.url === item.url
                      ? 'scale-105 ring-2 ring-[#C084FC] shadow-[0_0_18px_-2px_rgba(192,132,252,0.55)]'
                      : 'opacity-65 ring-1 ring-white/10 hover:-translate-y-0.5 hover:scale-105 hover:opacity-100 hover:ring-white/30'}`}>
                  <img src={item.url} alt="" className="h-14 w-14 object-cover" />
                </button>
                <button onClick={(e) => { e.stopPropagation(); const next = history.filter((_, idx) => idx !== i); setHistory(next); if (current?.url === item.url) setCurrent(next[0] || null); }}
                  className="absolute -right-1.5 -top-1.5 grid h-[18px] w-[18px] scale-75 place-items-center rounded-full bg-rose/90 text-[11px] leading-none text-white opacity-0 shadow transition-all hover:bg-rose group-hover:scale-100 group-hover:opacity-100"
                  title="Remove image">&times;</button>
              </div>
            ))}
            <button onClick={() => { setHistory([]); setCurrent(null); localStorage.removeItem(STUDIO_HISTORY_KEY); }}
              className="ml-auto shrink-0 rounded-lg border border-white/10 px-2.5 py-1.5 text-[10px] font-semibold text-muted transition-all hover:border-rose/30 hover:text-rose">
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ── BOTTOM: prompt + generate (sticky, always visible) ─── */}
      <div className="sticky bottom-0 border-t border-white/8 bg-surface/90 px-4 py-3 backdrop-blur">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <textarea value={prompt} rows={2} autoFocus
              onChange={e => setPrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
              placeholder="Describe the image you want to generate…"
              className="w-full resize-none rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-base text-ink transition-shadow placeholder:text-muted/60 focus:border-[#C084FC]/50 focus:outline-none focus:ring-1 focus:ring-[#C084FC]/30 focus:shadow-[0_0_32px_-10px_rgba(192,132,252,0.5)]"
            />
            <div className="mt-1 flex items-center gap-3 text-[11px] text-muted/60">
              <button onClick={() => setShowNegative(v => !v)} className="hover:text-ink">+ negative</button>
              <span>· est. ${estCost} · Enter to send, Shift+Enter for new line</span>
            </div>
          </div>
          <Button variant="primary" icon="auto_awesome" loading={generating}
            onClick={() => generate()} className="min-h-[44px] px-6 text-base shrink-0"
            style={{
              background: 'linear-gradient(135deg, #C084FC, #8B5CF6)',
              boxShadow: generating
                ? '0 0 40px rgba(192,132,252,0.6), inset 0 1px 0 rgba(255,255,255,0.35)'
                : '0 0 24px rgba(192,132,252,0.35), inset 0 1px 0 rgba(255,255,255,0.35)',
              color: '#1A0533',
            }}>
            {generating ? '…' : 'Generate'}
          </Button>
        </div>
        {showNegative && (
          <textarea value={negative} rows={1}
            onChange={e => setNegative(e.target.value)}
            placeholder="Negative prompt (what to avoid)…"
            className="mt-2 w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-ink/70 placeholder:text-muted/40 focus:border-accent/30 focus:outline-none"
          />
        )}
      </div>
    </div>
  );
}

function Slider({ label, min, max, step, value, onChange, display, disabled, hint }:
  { label: string; min: number; max: number; step: number; value: number;
    onChange: (v: number) => void; display: string; disabled?: boolean; hint?: string }) {
  return (
    <div className={`mt-4 ${disabled ? 'opacity-50' : ''}`}>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</label>
        <span className="font-mono text-xs text-ink">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-accent disabled:cursor-not-allowed"
        style={{ accentColor: '#19C3E6' }} />
      {hint && <p className="mt-1 text-[11px] text-muted/60">{hint}</p>}
    </div>
  );
}
