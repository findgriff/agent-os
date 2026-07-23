// Video Studio — full editor with multi-track timeline, trimming, and render.
// Upload clips, trim, arrange, add captions, render with baked-in captions.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Input, Select, Textarea, Toggle, Icon, Modal, EmptyState, useToast } from '../components/ui';
import { api } from '../lib/api';
import type { StudioVideo } from '../lib/types';

// ── Types ──────────────────────────────────────────────────────────────────
interface VideoClip {
  id: string;
  name: string;
  path: string;
  duration: number;
  trimStart: number;
  trimEnd: number;
  width?: number;
  height?: number;
}

interface TimelineTrack {
  id: string;
  label: string;
  type: 'video' | 'captions' | 'audio';
  clips: VideoClip[] | VideoCaption[];
  colour: string;
}

interface VideoCaption {
  id: string;
  start: number;
  end: number;
  text: string;
  position: 'top' | 'middle' | 'bottom';
  fontSize: number;
  color: string;
}

const genId = () => Math.random().toString(36).slice(2, 10);

// ── Project save/load ─────────────────────────────────────────────────────
const PROJECT_KEY = 'agentos_video_project';

interface ProjectState {
  clips: VideoClip[];
  captions: VideoCaption[];
  totalDuration: number;
  scrubTime: number;
  renderUrl: string | null;
  updatedAt: number;
}

function saveProject(clips: VideoClip[], captions: VideoCaption[], totalDuration: number, scrubTime: number, renderUrl: string | null) {
  try {
    const state: ProjectState = { clips, captions, totalDuration, scrubTime, renderUrl, updatedAt: Date.now() };
    localStorage.setItem(PROJECT_KEY, JSON.stringify(state));
  } catch { /* storage full */ }
}

function loadProject(): ProjectState | null {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function clearProject() {
  localStorage.removeItem(PROJECT_KEY);
}

// ════════════════════════════════════════════════════════════════════════════
export default function VideoStudio() {
  const toast = useToast();
  const [tab, setTab] = useState<'editor' | 'generate'>('editor');

  // Editor state
  const [clips, setClips] = useState<VideoClip[]>([]);
  const [captions, setCaptions] = useState<VideoCaption[]>([]);
  const [totalDuration, setTotalDuration] = useState(10);
  const [scrubTime, setScrubTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewCaption, setPreviewCaption] = useState<VideoCaption | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [showAddCaption, setShowAddCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState<VideoCaption>({
    id: genId(), start: 0, end: 2, text: '', position: 'bottom', fontSize: 24, color: '#FFFFFF',
  });
  const [editCaption, setEditCaption] = useState<VideoCaption | null>(null);
  const [editCaptionIdx, setEditCaptionIdx] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [trimClip, setTrimClip] = useState<VideoClip | null>(null);
  const playRef = useRef<number>(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [projectLoaded, setProjectLoaded] = useState(false);

  // ── Load project on mount ────────────────────────────────────────────────
  useEffect(() => {
    const saved = loadProject();
    if (saved && saved.clips.length) {
      setClips(saved.clips);
      setCaptions(saved.captions);
      setTotalDuration(saved.totalDuration);
      setScrubTime(saved.scrubTime);
      setRenderUrl(saved.renderUrl);
    }
    setProjectLoaded(true);
  }, []);

  // ── Auto-save on every change ────────────────────────────────────────────
  useEffect(() => {
    if (!projectLoaded) return;
    const timer = setTimeout(() => {
      saveProject(clips, captions, totalDuration, scrubTime, renderUrl);
    }, 500);
    return () => clearTimeout(timer);
  }, [clips, captions, totalDuration, scrubTime, renderUrl, projectLoaded]);

  // ── Playback ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) return;
    const i = setInterval(() => {
      setScrubTime(t => {
        const next = t + 0.05;
        if (next >= totalDuration) { setPlaying(false); return 0; }
        return next;
      });
    }, 50);
    return () => clearInterval(i);
  }, [playing, totalDuration]);

  // ── Upload ───────────────────────────────────────────────────────────────
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      // Read file as base64
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1];
        const res = await fetch('/api/studio/video/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('agentos_token') || ''}` },
          body: JSON.stringify({ data: base64, filename: file.name }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const clip: VideoClip = {
          id: genId(), name: file.name, path: data.path,
          duration: data.duration || 5, trimStart: 0, trimEnd: data.duration || 5,
          width: data.width, height: data.height,
        };
        setClips(prev => [...prev, clip]);
        setTotalDuration(t => Math.max(t, clip.duration));
        toast(`Uploaded ${file.name}`, 'ok');
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      toast(err.message || 'Upload failed', 'danger');
      setUploading(false);
    }
  };

  // ── Trim ─────────────────────────────────────────────────────────────────
  const applyTrim = async () => {
    if (!trimClip) return;
    try {
      const res = await fetch('/api/studio/video/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('agentos_token') || ''}` },
        body: JSON.stringify({ source: trimClip.path, start: trimClip.trimStart, end: trimClip.trimEnd }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setClips(prev => prev.map(c => c.id === trimClip.id ? { ...c, path: data.path, duration: data.duration || (trimClip.trimEnd - trimClip.trimStart) } : c));
      toast('Trim applied', 'ok');
      setTrimClip(null);
    } catch (err: any) {
      toast(err.message || 'Trim failed', 'danger');
    }
  };

  // ── Render with captions ─────────────────────────────────────────────────
  const handleRender = async () => {
    if (!clips.length) { toast('Add a video clip first', 'warn'); return; }
    setRendering(true);
    setRenderUrl(null);
    try {
      const res = await fetch('/api/studio/video/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('agentos_token') || ''}` },
        body: JSON.stringify({ source: clips[0].path, captions }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRenderUrl(data.path);
      toast('Render complete', 'ok');
    } catch (err: any) {
      toast(err.message || 'Render failed', 'danger');
    }
    setRendering(false);
  };

  // ── Caption operations ───────────────────────────────────────────────────
  const addCaption = () => {
    if (!captionDraft.text.trim()) { toast('Caption text required', 'warn'); return; }
    setCaptions(prev => [...prev, { ...captionDraft, id: genId() }].sort((a, b) => a.start - b.start));
    setCaptionDraft({ id: genId(), start: Math.max(0, captionDraft.end), end: captionDraft.end + 2, text: '', position: 'bottom', fontSize: 24, color: '#FFFFFF' });
    setShowAddCaption(false);
    toast('Caption added', 'ok');
  };

  const removeCaption = (idx: number) => setCaptions(prev => prev.filter((_, i) => i !== idx));

  const updateCaption = () => {
    if (editCaption === null || editCaptionIdx === null) return;
    setCaptions(prev => prev.map((c, i) => i === editCaptionIdx ? editCaption : c).sort((a, b) => a.start - b.start));
    setEditCaption(null); setEditCaptionIdx(null);
    toast('Caption updated', 'ok');
  };

  const currentCaption = captions.find(c => scrubTime >= c.start && scrubTime <= c.end);

  // SRT export
  const exportSRT = () => {
    if (!captions.length) { toast('No captions', 'warn'); return; }
    const fmt = (sec: number) => {
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60), ms = Math.floor((sec % 1) * 1000);
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
    };
    const srt = captions.map((c, i) => `${i+1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join('\n');
    const blob = new Blob([srt], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'captions.srt';
    a.click(); URL.revokeObjectURL(a.href);
  };

  // ── Tracks for timeline ──────────────────────────────────────────────────
  const tracks: TimelineTrack[] = [
    { id: 'video', label: 'Video', type: 'video', clips, colour: '#19C3E6' },
    { id: 'captions', label: 'Captions', type: 'captions', clips: captions, colour: '#A78BFA' },
  ];

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-3 p-3">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex rounded-xl border border-white/10 p-0.5">
            <button onClick={() => setTab('editor')}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${tab === 'editor' ? 'bg-accent text-white' : 'text-muted hover:text-ink'}`}>
              Editor
            </button>
            <button onClick={() => setTab('generate')}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${tab === 'generate' ? 'bg-accent text-white' : 'text-muted hover:text-ink'}`}>
              Generate
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept="video/mp4,video/webm,video/mov" onChange={handleUpload} className="hidden" />
          <Button variant="ghost" icon="upload" loading={uploading} onClick={() => fileRef.current?.click()}>Upload</Button>
          <Button variant="ghost" icon="refresh" onClick={() => {
            if (window.confirm('Start a new project? Current work will be saved.')) {
              saveProject(clips, captions, totalDuration, scrubTime, renderUrl);
              setClips([]); setCaptions([]); setTotalDuration(10);
              setScrubTime(0); setRenderUrl(null);
              toast('New project started', 'ok');
            }
          }}>New</Button>
          <Button variant="primary" icon="movie" loading={rendering} onClick={handleRender} disabled={!clips.length}>Render</Button>
          <Button variant="ghost" icon="download" onClick={exportSRT} disabled={!captions.length}>SRT</Button>
        </div>
      </div>

      {/* Main area: preview + timeline */}
      <div className="flex flex-1 gap-3 overflow-hidden">
        {/* LEFT: Preview */}
        <div className="flex w-2/5 flex-col gap-3">
          <Card ref={previewRef} className="relative flex aspect-video items-center justify-center overflow-hidden bg-black/60">
            {clips.length > 0 ? (
              <>
                <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#0a1628] to-[#05080C]">
                  {renderUrl ? (
                    <video src={renderUrl} controls className="max-h-full max-w-full" />
                  ) : (
                    <div className="text-center">
                      <Icon name="videocam" size={40} className="text-accent/30" />
                      <p className="mt-1 text-xs text-muted">{clips[0].name}</p>
                      <p className="text-[10px] text-muted/50">{clips.length} clip{clips.length > 1 ? 's' : ''} · {captions.length} captions</p>
                    </div>
                  )}
                </div>
                {!renderUrl && (
                  <button onClick={() => setPlaying(!playing)}
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 grid h-14 w-14 place-items-center rounded-full bg-accent/80 text-white shadow-[0_0_30px_rgba(25,195,230,0.4)] hover:scale-105 hover:bg-accent transition-all">
                    <Icon name={playing ? 'pause' : 'play_arrow'} size={28} />
                  </button>
                )}
                {currentCaption && !renderUrl && (
                  <div className="absolute left-0 right-0 mx-auto w-3/4 rounded-lg bg-black/70 px-4 py-2 text-center shadow-lg"
                    style={{
                      top: currentCaption.position === 'top' ? '12%' : currentCaption.position === 'middle' ? '45%' : '78%',
                      fontSize: currentCaption.fontSize, color: currentCaption.color,
                    }}>
                    {currentCaption.text}
                  </div>
                )}
                {/* Progress bar */}
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/10">
                  <div className="h-full bg-accent transition-all duration-100" style={{ width: `${(scrubTime / totalDuration) * 100}%` }} />
                </div>
              </>
            ) : (
              <EmptyState icon="videocam" accent="#19C3E6" title="No clips"
                hint="Upload a video to start editing." />
            )}
          </Card>

          {/* Clip list */}
          {clips.length > 0 && (
            <Card className="flex-1 p-3">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">Clips ({clips.length})</h3>
              <div className="space-y-1.5">
                {clips.map((clip, i) => (
                  <div key={clip.id} className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.02] p-2">
                    <span className="grid h-6 w-6 place-items-center rounded-md bg-accent/10 text-[10px] text-accent">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-ink">{clip.name}</div>
                      <div className="text-[9px] text-muted/60">{clip.duration.toFixed(1)}s</div>
                    </div>
                    <button onClick={() => setTrimClip(clip)}
                      className="rounded-lg px-2 py-1 text-[10px] text-muted hover:bg-white/10 hover:text-ink">Trim</button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* RIGHT: Timeline + Captions */}
        <div className="flex flex-1 flex-col gap-3">
          {/* Timeline */}
          <Card className="p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Timeline — {totalDuration.toFixed(1)}s</span>
              <div className="flex gap-1">
                <Button variant="ghost" icon="add" className="py-1 text-[10px]" onClick={() => setShowAddCaption(true)}>Caption</Button>
              </div>
            </div>
            <div className="relative space-y-1">
              {/* Ruler */}
              <div className="relative h-4">
                {[0, 1, 2, 3, 4, 5, 10, 15, 20, 30].filter(t => t <= totalDuration).map(t => (
                  <span key={t} className="absolute text-[8px] text-muted/40" style={{ left: `${(t / totalDuration) * 100}%` }}>{t}s</span>
                ))}
              </div>
              {/* Track rows */}
              {tracks.map(track => (
                <div key={track.id} className="relative h-8 rounded-md bg-black/30">
                  {/* Track label */}
                  <span className="absolute -left-14 top-1/2 -translate-y-1/2 text-[9px] text-muted/60 w-12 text-right pr-2">{track.label}</span>
                  {/* Clip blocks */}
                  {track.type === 'video' ? (
                    (track.clips as VideoClip[]).map((clip, i) => {
                      const w = (clip.duration / totalDuration) * 100;
                      const l = 0;
                      return (
                        <div key={clip.id}
                          draggable
                          onDragStart={e => { e.dataTransfer.setData('clip', String(i)); }}
                          onDragOver={e => { e.preventDefault(); (e.currentTarget as HTMLElement).style.opacity = '0.5'; }}
                          onDragLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                          onDrop={e => {
                            e.preventDefault();
                            (e.currentTarget as HTMLElement).style.opacity = '1';
                            const fromIdx = parseInt(e.dataTransfer.getData('clip'));
                            if (isNaN(fromIdx) || fromIdx === i) return;
                            const reordered = [...clips];
                            const [moved] = reordered.splice(fromIdx, 1);
                            reordered.splice(i, 0, moved);
                            setClips(reordered);
                          }}
                          className="absolute top-1 h-6 rounded border border-white/10 px-1.5 flex items-center cursor-grab active:cursor-grabbing hover:opacity-80 transition-all"
                          style={{ left: `${l}%`, width: `${Math.max(w, 5)}%`, background: track.colour + '44' }}
                          onClick={() => { setTrimClip(clip); }}>
                          <span className="truncate text-[9px] font-medium text-white">{clip.name}</span>
                        </div>
                      );
                    })
                  ) : (
                    (track.clips as VideoCaption[]).map((c, i) => {
                      const w = ((c.end - c.start) / totalDuration) * 100;
                      const l = (c.start / totalDuration) * 100;
                      return (
                        <div key={c.id}
                          draggable
                          onDragStart={e => { e.dataTransfer.setData('text/plain', String(i)); }}
                          onDragOver={e => { e.preventDefault(); (e.currentTarget as HTMLElement).style.opacity = '0.5'; }}
                          onDragLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
                          onDrop={e => {
                            e.preventDefault();
                            (e.currentTarget as HTMLElement).style.opacity = '1';
                            const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                            if (isNaN(fromIdx) || fromIdx === i) return;
                            const reordered = [...captions];
                            const [moved] = reordered.splice(fromIdx, 1);
                            reordered.splice(i, 0, moved);
                            setCaptions(reordered);
                          }}
                          className="absolute top-1 h-6 rounded border border-white/20 px-1 flex items-center cursor-grab active:cursor-grabbing hover:opacity-80 transition-all"
                          style={{ left: `${l}%`, width: `${Math.max(w, 3)}%`, background: track.colour + '66' }}
                          onClick={() => { setEditCaption({ ...c }); setEditCaptionIdx(i); }}
                          title={`${c.start.toFixed(1)}s → ${c.end.toFixed(1)}s: ${c.text}`}>
                          <span className="truncate text-[8px] text-white">{c.text}</span>
                        </div>
                      );
                    })
                  )}
                  {/* Scrubber */}
                  <div className="absolute top-0 h-full w-0.5 bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)] z-10"
                    style={{ left: `${(scrubTime / totalDuration) * 100}%` }} />
                </div>
              ))}
            </div>
          </Card>

          {/* Captions table */}
          <Card className="flex-1 p-3">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">Captions ({captions.length})</h3>
            {captions.length === 0 ? (
              <div className="flex h-20 items-center justify-center text-[11px] text-muted/50">
                No captions — click "Caption" above to add one.
              </div>
            ) : (
              <div className="max-h-40 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/8 text-left text-[9px] uppercase tracking-wider text-muted">
                      <th className="w-8 py-1 pr-1 font-semibold">#</th>
                      <th className="w-14 py-1 pr-1 font-semibold">Start</th>
                      <th className="w-14 py-1 pr-1 font-semibold">End</th>
                      <th className="py-1 pr-1 font-semibold">Text</th>
                      <th className="w-8 py-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {captions.map((c, i) => (
                      <tr key={c.id} onClick={() => { setEditCaption({ ...c }); setEditCaptionIdx(i); }}
                        className="cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.03]">
                        <td className="py-1 pr-1 font-mono text-muted/70">{i + 1}</td>
                        <td className="py-1 pr-1 font-mono text-muted">{c.start.toFixed(1)}s</td>
                        <td className="py-1 pr-1 font-mono text-muted">{c.end.toFixed(1)}s</td>
                        <td className="truncate py-1 pr-1 text-ink">{c.text}</td>
                        <td className="py-1">
                          <button onClick={e => { e.stopPropagation(); removeCaption(i); }}
                            className="grid h-4 w-4 place-items-center rounded text-muted/30 hover:bg-rose/10 hover:text-rose">
                            <Icon name="close" size={10} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Output preview */}
          {renderUrl && (
            <Card className="p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icon name="check_circle" size={16} className="text-emerald" />
                  <span className="text-xs text-ink">Render ready</span>
                </div>
                <a href={renderUrl} download="render.mp4"
                  className="rounded-lg bg-accent/10 px-3 py-1 text-xs text-accent hover:bg-accent/20 transition-all">
                  Download MP4
                </a>
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* ── Trim modal ──────────────────────────────────────────────────── */}
      <Modal open={!!trimClip} onClose={() => setTrimClip(null)} title="Trim Clip" width="max-w-sm">
        {trimClip && (
          <div className="space-y-3">
            <p className="text-xs text-muted">{trimClip.name} — {trimClip.duration.toFixed(1)}s total</p>
            <div className="space-y-2">
              <div>
                <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">Start ({trimClip.trimStart.toFixed(1)}s)</label>
                <input type="range" min={0} max={trimClip.duration} step={0.1} value={trimClip.trimStart}
                  onChange={e => setTrimClip({ ...trimClip, trimStart: Number(e.target.value) })}
                  className="w-full h-1.5 rounded-full bg-white/10 appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent" />
              </div>
              <div>
                <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">End ({trimClip.trimEnd.toFixed(1)}s)</label>
                <input type="range" min={0} max={trimClip.duration} step={0.1} value={trimClip.trimEnd}
                  onChange={e => setTrimClip({ ...trimClip, trimEnd: Number(e.target.value) })}
                  className="w-full h-1.5 rounded-full bg-white/10 appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent" />
              </div>
              <p className="text-[10px] text-muted/60">Duration: {(trimClip.trimEnd - trimClip.trimStart).toFixed(1)}s</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setTrimClip(null)}>Cancel</Button>
              <Button variant="primary" onClick={applyTrim}>Apply Trim</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Add caption modal ───────────────────────────────────────────── */}
      <Modal open={showAddCaption} onClose={() => setShowAddCaption(false)} title="Add Caption" width="max-w-sm">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">Start (s)</label>
              <Input type="number" min={0} max={30} step={0.1} value={captionDraft.start}
                onChange={e => setCaptionDraft(c => ({ ...c, start: Number(e.target.value) }))} />
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">End (s)</label>
              <Input type="number" min={0} max={30} step={0.1} value={captionDraft.end}
                onChange={e => setCaptionDraft(c => ({ ...c, end: Number(e.target.value) }))} />
            </div>
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">Text</label>
            <Input value={captionDraft.text} onChange={e => setCaptionDraft(c => ({ ...c, text: e.target.value }))} placeholder="Caption text…" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">Position</label>
              <Select value={captionDraft.position} onChange={e => setCaptionDraft(c => ({ ...c, position: e.target.value as any }))}>
                <option value="top">Top</option>
                <option value="middle">Middle</option>
                <option value="bottom">Bottom</option>
              </Select>
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">Font size</label>
              <Select value={captionDraft.fontSize} onChange={e => setCaptionDraft(c => ({ ...c, fontSize: Number(e.target.value) }))}>
                {[16, 18, 20, 24, 28, 32, 36].map(s => <option key={s} value={s}>{s}px</option>)}
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setShowAddCaption(false)}>Cancel</Button>
            <Button variant="primary" onClick={addCaption}>Add</Button>
          </div>
        </div>
      </Modal>

      {/* ── Edit caption modal ──────────────────────────────────────────── */}
      <Modal open={!!editCaption} onClose={() => setEditCaption(null)} title="Edit Caption" width="max-w-sm">
        {editCaption && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">Start (s)</label>
                <Input type="number" min={0} max={30} step={0.1} value={editCaption.start}
                  onChange={e => setEditCaption(c => ({ ...c!, start: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">End (s)</label>
                <Input type="number" min={0} max={30} step={0.1} value={editCaption.end}
                  onChange={e => setEditCaption(c => ({ ...c!, end: Number(e.target.value) }))} />
              </div>
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">Text</label>
              <Input value={editCaption.text} onChange={e => setEditCaption(c => ({ ...c!, text: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">Position</label>
                <Select value={editCaption.position} onChange={e => setEditCaption(c => ({ ...c!, position: e.target.value as any }))}>
                  <option value="top">Top</option>
                  <option value="middle">Middle</option>
                  <option value="bottom">Bottom</option>
                </Select>
              </div>
              <div>
                <label className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-muted">Font size</label>
                <Select value={editCaption.fontSize} onChange={e => setEditCaption(c => ({ ...c!, fontSize: Number(e.target.value) }))}>
                  {[16, 18, 20, 24, 28, 32, 36].map(s => <option key={s} value={s}>{s}px</option>)}
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setEditCaption(null)}>Cancel</Button>
              <Button variant="primary" onClick={updateCaption}>Save</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
