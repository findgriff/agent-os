// Image Studio — a full Fal.ai generation cockpit. Left: prompt + settings.
// Right: output + session gallery. Talks to /api/studio/generate + /models.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Icon, Input, Select, Textarea, Toggle, useToast } from '../components/ui';
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
      });
      const items: HistoryItem[] = res.images.map(img => ({ ...img, prompt: prompt.trim() }));
      if (items.length) {
        setHistory(h => [...items, ...h].slice(0, 40));
        setCurrent(items[0]);
        // Save each image to the permanent Gallery (fire-and-forget)
        items.forEach(img => {
          api.saveWorkspaceItem({
            tenant_id: selectedTenant ?? undefined,
            type: 'image',
            title: prompt.trim().slice(0, 200),
            url: img.url,
            thumbnail: img.url,
            model,
            tags: ['studio', model, aspect],
          }).catch(() => {}); // silent — gallery save is a bonus, not critical
        });
        // Also save the prompt as a memory star in the Galaxy
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
        toast(`${items.length} image${items.length > 1 ? 's' : ''} saved — check Gallery & Galaxy`, 'ok');
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
      <div className="flex flex-wrap items-center gap-2 border-b border-white/6 bg-surface/60 px-4 py-2">
        <div className="flex items-center gap-2 mr-2">
          <div className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: '#C084FC1a', color: '#C084FC' }}>
            <Icon name="palette" size={16} />
          </div>
          <h1 className="font-display text-sm font-bold text-ink">Studio</h1>
        </div>
        <select value={model} onChange={e => setModel(e.target.value)}
          className="rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-xs font-semibold text-ink h-7">
          {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <div className="flex gap-1">
          {ASPECTS.slice(0,5).map(a => (
            <button key={a.id} onClick={() => setAspect(a.id)}
              className={`grid place-items-center rounded border px-1.5 py-1 text-[10px] transition-all h-7 ${aspect === a.id ? 'border-accent/50 bg-accent/10 text-ink' : 'border-white/10 text-muted hover:text-ink'}`}>
              {a.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted">
          <span>Steps</span>
          <input type="range" min={1} max={spec?.max_steps || 50} value={steps}
            onChange={e => setSteps(Number(e.target.value))} className="w-12 h-1 accent-[#C084FC]" />
          <span className="font-mono w-3">{steps}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted">
          <Icon name="collections" size={12} />
          <select value={numImages} onChange={e => setNumImages(Number(e.target.value))}
            className="bg-transparent text-xs text-ink font-semibold">
            {[1,2,3,4].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button onClick={() => setRandomSeed(v => !v)}
          className={`rounded border px-1.5 py-1 text-[10px] transition-all h-7 ${!randomSeed ? 'border-accent/50 bg-accent/10 text-ink' : 'border-white/10 text-muted'}`}>
          {randomSeed ? '🎲' : `#${seed || '?'}`}
        </button>
        <div className="relative" ref={styleRef}>
          <button onClick={() => setStyleOpen(v => !v)}
            className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-1 text-[10px] text-muted hover:text-ink h-7">
            Style ▾
          </button>
          {styleOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setStyleOpen(false)} />
              <div className="absolute right-0 top-full z-20 mt-1 w-44 glass-raised rounded-xl p-2 shadow-2xl">
                <div className="flex flex-wrap gap-1">
                  {STYLE_PRESETS.map(p => (
                    <button key={p.name} onClick={() => { applyPreset(p); setStyleOpen(false); }}
                      className={`rounded-full border px-2 py-0.5 text-[10px] transition-all ${usedPresets.has(p.name) ? 'border-violet/50 bg-violet/10 text-ink' : 'border-white/10 text-muted hover:text-ink'}`}>
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <label className="flex items-center gap-1 text-[10px] text-muted cursor-pointer h-7">
          <input type="checkbox" checked={safeMode} onChange={e => setSafeMode(e.target.checked)}
            className="accent-[#C084FC]" />
          Safe
        </label>
      </div>

      {/* ── CENTRE: output ─────────────────────────────── */}
      <div className="flex flex-1 items-center justify-center overflow-hidden bg-black/40 p-4">
        {generating ? (
          <div className="flex w-full max-w-lg flex-col items-center gap-4">
            <div className="aspect-square w-full max-w-md animate-pulse rounded-2xl bg-white/5" />
            <div className="max-w-md text-center text-sm text-muted line-clamp-2">{prompt}</div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <Icon name="progress_activity" size={16} className="animate-spin" /> Rendering with {spec?.label}…
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-rose/15 text-rose"><Icon name="error" size={26} /></div>
            <div className="max-w-sm text-sm text-muted">{error}</div>
            <Button variant="secondary" icon="refresh" onClick={() => generate()}>Retry</Button>
          </div>
        ) : current ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-4">
            <img src={current.url} alt={current.prompt}
              className="max-h-[60vh] max-w-full rounded-2xl object-contain shadow-2xl animate-fadeInUp" />
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="secondary" icon="download" onClick={() => download(current)}>Download</Button>
              <Button variant="secondary" icon="content_copy" onClick={() => copyImage(current)}>Copy</Button>
              <Button variant="secondary" icon="refresh" onClick={() => generate({ seedOverride: current.seed })}>Regen</Button>
              <Button variant="secondary" icon="alt_route" onClick={() => useAsVariation(current)}>Variation</Button>
            </div>
            <div className="text-[11px] text-muted/70">{current.model} · seed {current.seed ?? '—'}</div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-2xl bg-white/5 text-muted"><Icon name="image" size={30} /></div>
            <div className="font-display text-ink">Your canvas awaits</div>
            <div className="max-w-xs text-sm text-muted">Type a prompt below and hit Generate.</div>
          </div>
        )}
      </div>

      {/* ── GALLERY STRIP ───────────────────────────────── */}
      {history.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-t border-white/6 bg-surface/40 px-4 py-2">
          {history.map((item, i) => (
            <button key={i} onClick={() => setCurrent(item)}
              className={`shrink-0 overflow-hidden rounded-lg border-2 transition-all ${current?.url === item.url ? 'border-accent' : 'border-transparent opacity-60 hover:opacity-100'}`}>
              <img src={item.url} alt="" className="h-10 w-10 object-cover" />
            </button>
          ))}
          <button onClick={() => { setHistory([]); setCurrent(null); localStorage.removeItem(STUDIO_HISTORY_KEY); }}
            className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-[10px] text-muted hover:text-rose hover:border-rose/30 transition-all ml-auto">
            Clear
          </button>
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
              className="w-full resize-none rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-ink placeholder:text-muted/60 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
            <div className="mt-1 flex items-center gap-3 text-[11px] text-muted/60">
              <button onClick={() => setShowNegative(v => !v)} className="hover:text-ink">+ negative</button>
              <span>· est. ${estCost} · Enter to send, Shift+Enter for new line</span>
            </div>
          </div>
          <Button variant="primary" icon="auto_awesome" loading={generating}
            onClick={() => generate()} className="min-h-[44px] px-6 text-base shrink-0"
            style={{ background: '#C084FC', boxShadow: '0 0 24px rgba(192,132,252,0.35)' }}>
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
