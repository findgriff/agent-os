// Workflow Pipelines — a visual, node-based automation builder. Left rail lists
// saved pipelines; the main stage is a connected-step flow you can run on demand;
// the bottom holds a run-history table with per-step drill-down. Talks to
// /api/pipelines (+ /run, /runs) and /api/agents for the agent-step picker.
import { useState, useEffect, useMemo, useCallback, useId, cloneElement, isValidElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import {
  Icon, Button, Card, Badge, Toggle, Textarea, Input, Select,
  Modal, Drawer, EmptyState, SkeletonList, useToast, Stat, useCountUp,
} from '../components/ui';
import { Avatar } from '../components/Avatar';
import { Sparkline } from '../components/Sparkline';
import { useApp } from '../lib/store';
import { api, timeAgo } from '../lib/api';
import type { Pipeline, PipelineStep, PipelineRun, PipelineRunStep, Agent } from '../lib/types';

// ── Step-type registry (icon + accent per backend step behaviour) ──────────
type StepMeta = { type: string; label: string; icon: string; colour: string; blurb: string };
const STEP_TYPES: StepMeta[] = [
  { type: 'agent',     label: 'Agent',     icon: 'smart_toy',     colour: '#38BDF8', blurb: 'Run one of your agents.' },
  { type: 'generate',  label: 'Generate',  icon: 'auto_awesome',  colour: '#A78BFA', blurb: 'An LLM generation step.' },
  { type: 'notify',    label: 'Notify',    icon: 'notifications', colour: '#F59E0B', blurb: 'Send a notification out.' },
  { type: 'delay',     label: 'Delay',     icon: 'schedule',      colour: '#7B8DA8', blurb: 'Pause for a duration.' },
  { type: 'condition', label: 'Condition', icon: 'fork_right',    colour: '#22C55E', blurb: 'Branch on an expression.' },
  { type: 'transform', label: 'Transform', icon: 'sync_alt',      colour: '#19C3E6', blurb: 'Reshape the payload.' },
];
const stepMeta = (type: string): StepMeta =>
  STEP_TYPES.find(s => s.type === type) ||
  { type, label: type, icon: 'extension', colour: '#7B8DA8', blurb: '' };

const stepLabel = (s: PipelineStep): string =>
  s.label || (s.config?.label as string) || stepMeta(s.type).label;

const previewText = (s: PipelineStep): string => {
  switch (s.type) {
    case 'generate':  return s.config?.prompt ? String(s.config.prompt) : 'LLM generation';
    case 'notify':    return s.config?.channel ? `→ ${s.config.channel}` : 'Send a notification';
    case 'delay':     return `Wait ${s.config?.seconds ?? 0}s`;
    case 'condition': return s.config?.expr ? String(s.config.expr) : 'Branch on condition';
    case 'transform': return 'Reshape the payload';
    default:          return stepMeta(s.type).blurb || 'Custom step';
  }
};

// ── Status → Badge tone ────────────────────────────────────────────────────
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'violet';
const RUN_TONE: Record<string, Tone> = { success: 'ok', error: 'danger', partial: 'warn', running: 'info' };
const runTone = (s: string | null | undefined): Tone => (s && RUN_TONE[s]) ? RUN_TONE[s] : 'neutral';

const fmtDuration = (r: PipelineRun): string => {
  if (!r.finished_at) return r.status === 'running' ? 'running…' : '—';
  const s = Math.max(0, Math.round(r.finished_at - r.started_at));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

const FEATURE = '#22C55E';

// ════════════════════════════════════════════════════════════════════════════
export default function Pipelines() {
  const { selectedTenant } = useApp();
  const toast = useToast();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Pipeline | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);

  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const [editor, setEditor] = useState<{ mode: 'add' | 'edit'; position: number; step?: PipelineStep } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Pipeline | null>(null);
  const [openRun, setOpenRun] = useState<PipelineRun | null>(null);

  // ── Loaders ──────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await api.pipelines(selectedTenant ?? undefined);
      setPipelines(res.pipelines || []);
    } catch {
      setPipelines([]);
      setError(true);
      toast('Failed to load pipelines', 'danger');
    }
    setLoading(false);
  }, [selectedTenant, toast]);

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoading(true);
    setDetailError(false);
    try {
      const res = await api.pipeline(id);
      setDetail(res.pipeline);
      setPipelines(prev => prev.map(x => (x.id === id ? { ...x, ...res.pipeline } : x)));
    } catch {
      setDetailError(true);
      toast('Failed to load pipeline', 'danger');
    }
    setDetailLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let alive = true;
    api.agents(selectedTenant ?? undefined)
      .then(r => { if (alive) setAgents(r.agents || []); })
      .catch(() => { if (alive) setAgents([]); });
    return () => { alive = false; };
  }, [selectedTenant]);

  // Auto-select the first pipeline (or keep a still-valid selection).
  useEffect(() => {
    if (loading) return;
    if (pipelines.length === 0) { if (selectedId !== null) setSelectedId(null); return; }
    if (selectedId == null || !pipelines.some(p => p.id === selectedId)) {
      setSelectedId(pipelines[0].id);
    }
  }, [pipelines, loading, selectedId]);

  useEffect(() => {
    if (selectedId == null) { setDetail(null); return; }
    loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => { setNameDraft(detail?.name ?? ''); }, [detail?.id]); // eslint-disable-line

  // ── Mutations ────────────────────────────────────────────────────────────
  const createPipeline = async () => {
    setCreating(true);
    try {
      const res = await api.createPipeline({
        name: 'Untitled pipeline', tenant_id: selectedTenant ?? undefined, enabled: true, steps: [],
      });
      setPipelines(prev => [res.pipeline, ...prev]);
      setSelectedId(res.pipeline.id);
      setDetail(res.pipeline);
      toast('Pipeline created', 'ok');
    } catch {
      toast('Could not create pipeline', 'danger');
    }
    setCreating(false);
  };

  const toggleEnabled = (p: Pipeline) => {
    const next = !p.enabled;
    setPipelines(prev => prev.map(x => (x.id === p.id ? { ...x, enabled: next } : x)));
    setDetail(d => (d && d.id === p.id ? { ...d, enabled: next } : d));
    api.updatePipeline(p.id, { enabled: next }).catch(() => {
      toast('Could not update pipeline', 'danger');
      setPipelines(prev => prev.map(x => (x.id === p.id ? { ...x, enabled: !next } : x)));
      setDetail(d => (d && d.id === p.id ? { ...d, enabled: !next } : d));
    });
  };

  const commitRename = async () => {
    if (!detail) return;
    const name = nameDraft.trim();
    if (!name || name === detail.name) { setNameDraft(detail.name); return; }
    setPipelines(prev => prev.map(x => (x.id === detail.id ? { ...x, name } : x)));
    setDetail(d => (d ? { ...d, name } : d));
    try { await api.updatePipeline(detail.id, { name }); }
    catch { toast('Could not rename pipeline', 'danger'); }
  };

  const doDelete = async () => {
    const p = confirmDelete;
    if (!p) return;
    setDeleting(true);
    try {
      await api.deletePipeline(p.id);
      setPipelines(prev => prev.filter(x => x.id !== p.id));
      if (selectedId === p.id) { setSelectedId(null); setDetail(null); }
      toast('Pipeline deleted', 'ok');
      setConfirmDelete(null);
    } catch {
      toast('Could not delete pipeline', 'danger');
    }
    setDeleting(false);
  };

  // Persist a new step list (re-index positions 0..n, PATCH, reconcile).
  const persistSteps = async (id: number, next: PipelineStep[]) => {
    const reindexed = next.map((s, i) => ({ ...s, position: i }));
    setDetail(d => (d && d.id === id ? { ...d, steps: reindexed } : d));
    setPipelines(prev => prev.map(x => (x.id === id ? { ...x, steps: reindexed } : x)));
    try {
      const res = await api.updatePipeline(id, { steps: reindexed });
      setDetail(d => (d && d.id === id ? { ...res.pipeline, runs: res.pipeline.runs ?? d.runs } : d));
      setPipelines(prev => prev.map(x => (x.id === id ? { ...x, ...res.pipeline } : x)));
    } catch {
      toast('Could not save steps', 'danger');
      loadDetail(id);
    }
  };

  const openAdd = (position: number) => setEditor({ mode: 'add', position });
  const openEdit = (index: number) => {
    if (detail) setEditor({ mode: 'edit', position: index, step: detail.steps[index] });
  };
  const onEditorSave = (step: PipelineStep) => {
    if (!detail) return;
    const cur = detail.steps ?? [];
    const ed = editor;
    let next: PipelineStep[];
    if (ed && ed.mode === 'edit') next = cur.map((s, i) => (i === ed.position ? step : s));
    else { const pos = ed?.position ?? cur.length; next = [...cur.slice(0, pos), step, ...cur.slice(pos)]; }
    setEditor(null);
    persistSteps(detail.id, next);
  };
  const onDelete = (index: number) => {
    if (!detail) return;
    persistSteps(detail.id, (detail.steps ?? []).filter((_, i) => i !== index));
  };
  const onMove = (index: number, dir: -1 | 1) => {
    if (!detail) return;
    const cur = [...(detail.steps ?? [])];
    const j = index + dir;
    if (j < 0 || j >= cur.length) return;
    [cur[index], cur[j]] = [cur[j], cur[index]];
    persistSteps(detail.id, cur);
  };

  const runPipeline = async () => {
    if (!detail) return;
    if ((detail.steps ?? []).length === 0) { toast('Add at least one step first', 'warn'); return; }
    setRunning(true);
    try {
      const { run } = await api.runPipeline(detail.id);
      toast(
        `Run ${run.status} — ${run.result?.ok ?? 0}/${run.result?.total ?? (detail.steps ?? []).length} steps ok`,
        runTone(run.status),
      );
      setOpenRun(run);
      await loadDetail(detail.id);
    } catch {
      toast('Run failed', 'danger');
    }
    setRunning(false);
  };

  // ── Derived ──────────────────────────────────────────────────────────────
  const totalPipelines = pipelines.length;
  const enabledCount = pipelines.filter(p => p.enabled).length;
  const totalRuns = pipelines.reduce((a, p) => a + (p.run_count || 0), 0);
  const cTotal = useCountUp(totalPipelines);
  const cEnabled = useCountUp(enabledCount);
  const cRuns = useCountUp(totalRuns);

  const steps = detail?.steps ?? [];
  const runs = detail?.runs ?? [];
  const runSeries = useMemo(
    () => (runs.length ? [...runs].reverse().map(r => r.result?.ok ?? 0) : []),
    [runs],
  );

  const showBuilder = !!detail && !(detailLoading && detail.id !== selectedId);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between animate-fadeInUp">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl"
            style={{ background: `${FEATURE}1a`, color: FEATURE, boxShadow: `0 0 28px -8px ${FEATURE}` }}>
            <Icon name="account_tree" size={24} />
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold text-ink">Pipelines</h1>
            <p className="text-sm text-muted">
              {totalPipelines} workflow{totalPipelines === 1 ? '' : 's'} · {enabledCount} live · {totalRuns} total runs
            </p>
          </div>
        </div>
        <Button variant="secondary" icon="refresh" loading={loading} onClick={() => load()}>Refresh</Button>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Pipelines" value={cTotal} icon="account_tree" accent={FEATURE} />
        <Stat label="Enabled" value={cEnabled} icon="bolt" accent="#38BDF8" delay={80} />
        <Stat label="Total runs" value={cRuns} icon="play_circle" accent="#A78BFA" delay={160} />
      </div>

      {/* Body */}
      {loading ? (
        <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
          <SkeletonList count={5} />
          <SkeletonList count={3} />
        </div>
      ) : error ? (
        <Card className="p-6">
          <EmptyState icon="cloud_off" title="Couldn't load pipelines"
            hint="Something went wrong reaching the server."
            action={<Button icon="refresh" onClick={() => load()}>Retry</Button>} />
        </Card>
      ) : pipelines.length === 0 ? (
        <Card className="p-6">
          <EmptyState large icon="account_tree" accent={FEATURE}
            title="No pipelines yet"
            hint="Chain agents, generation, notifications and logic into an automated workflow you can run on demand."
            action={
              <Button variant="primary" icon="add" loading={creating} onClick={createPipeline}
                style={{ background: FEATURE, color: '#04220f', boxShadow: `0 0 22px ${FEATURE}59` }}>
                Create your first pipeline
              </Button>
            } />
        </Card>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[20rem_1fr]">
          {/* ── LEFT: pipeline list ─────────────────────────────────────── */}
          <Card glass className="p-3 lg:sticky lg:top-4">
            <div className="mb-3 flex items-center justify-between px-1">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">Your pipelines</div>
              <Button variant="ghost" icon="add" className="px-2 py-1 text-xs" loading={creating} onClick={createPipeline}>
                New
              </Button>
            </div>
            <div className="space-y-2 lg:max-h-[calc(100vh-15rem)] lg:overflow-y-auto lg:pr-1">
              {pipelines.map((p, i) => {
                const active = p.id === selectedId;
                return (
                  <div key={p.id} onClick={() => setSelectedId(p.id)}
                    className={`group relative cursor-pointer rounded-xl border p-3 transition-all animate-fadeInUp
                      ${active
                        ? 'border-emerald/40 bg-emerald/[0.06] shadow-[0_0_20px_-10px_#22C55E]'
                        : 'border-white/8 hover:border-white/15 hover:bg-white/[0.03]'}`}
                    style={{ animationDelay: `${i * 45}ms` }}>
                    {active && (
                      <span className="absolute left-0 top-1/2 h-8 w-1 -translate-y-1/2 rounded-r-full bg-emerald shadow-[0_0_10px_#22C55E]" />
                    )}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-display text-sm font-semibold text-ink">{p.name}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                          <span className="inline-flex items-center gap-1"><Icon name="account_tree" size={12} />{p.steps.length}</span>
                          <span className="opacity-40">·</span>
                          <span className="inline-flex items-center gap-1"><Icon name="history" size={12} />{p.run_count}</span>
                        </div>
                      </div>
                      <div onClick={e => e.stopPropagation()}>
                        <Toggle ariaLabel={p.name} checked={p.enabled} onChange={() => toggleEnabled(p)} />
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted/80">
                        <Icon name="schedule" size={12} />{timeAgo(p.last_run_at)}
                      </span>
                      <div className="flex items-center gap-1">
                        {p.last_status && <Badge tone={runTone(p.last_status)} dot>{p.last_status}</Badge>}
                        <button onClick={e => { e.stopPropagation(); setConfirmDelete(p); }} title="Delete pipeline"
                          className="grid h-6 w-6 place-items-center rounded-lg text-muted/60 opacity-0 transition-all hover:bg-rose/10 hover:text-rose group-hover:opacity-100">
                          <Icon name="delete" size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* ── MAIN: builder + run history ─────────────────────────────── */}
          <div className="min-w-0 space-y-6">
            {detailError && !detail ? (
              <Card className="p-6">
                <EmptyState icon="cloud_off" title="Couldn't load pipeline"
                  hint="Something went wrong reaching the server."
                  action={<Button icon="refresh"
                    onClick={() => selectedId != null && loadDetail(selectedId)}>Retry</Button>} />
              </Card>
            ) : !showBuilder || !detail ? (
              <SkeletonList count={3} />
            ) : (
              <>
                {/* Builder */}
                <Card className="p-4 animate-fadeInUp md:p-5">
                  <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2">
                      <Icon name="account_tree" size={18} className="shrink-0 text-emerald" />
                      <input value={nameDraft} onChange={e => setNameDraft(e.target.value)} onBlur={commitRename}
                        aria-label="Pipeline name"
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        className="min-w-0 flex-1 rounded-lg bg-transparent px-1.5 py-0.5 font-display text-lg font-bold text-ink outline-none transition-colors hover:bg-white/5 focus:bg-white/5 focus:ring-1 focus:ring-emerald/40" />
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <Toggle ariaLabel={detail.name} checked={detail.enabled} onChange={() => toggleEnabled(detail)} />
                        {detail.enabled ? 'Enabled' : 'Disabled'}
                      </div>
                      <button onClick={() => setConfirmDelete(detail)} title="Delete pipeline"
                        className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-rose/10 hover:text-rose">
                        <Icon name="delete" size={18} />
                      </button>
                    </div>
                  </div>

                  {/* Flow */}
                  <div className="flex flex-wrap items-start gap-y-4 rounded-2xl border border-white/5 bg-black/20 p-4">
                    <div className="self-center">
                      <Button variant="primary" icon="play_arrow" loading={running} onClick={runPipeline}
                        style={{ background: FEATURE, color: '#04220f', boxShadow: `0 0 22px ${FEATURE}66` }}>
                        {running ? 'Running…' : 'Run'}
                      </Button>
                    </div>

                    {steps.length === 0 ? (
                      <div className="flex items-center self-center">
                        <Icon name="chevron_right" className="mx-1 text-emerald/30" />
                        <button onClick={() => openAdd(0)}
                          className="flex items-center gap-2 rounded-2xl border border-dashed border-emerald/30 px-4 py-5 text-sm text-muted transition-all hover:border-emerald/60 hover:bg-emerald/5 hover:text-ink">
                          <Icon name="add_circle" className="text-emerald" /> Add first step
                        </button>
                      </div>
                    ) : (
                      <>
                        {steps.map((s, i) => (
                          <Fragment key={i}>
                            <Connector onAdd={() => openAdd(i)} />
                            <StepCard step={s} index={i} total={steps.length} agents={agents}
                              onEdit={openEdit} onDelete={onDelete} onMove={onMove} />
                          </Fragment>
                        ))}
                        <Connector onAdd={() => openAdd(steps.length)} />
                        <div className="grid h-10 w-10 shrink-0 place-items-center self-center rounded-xl border border-white/10 bg-white/5 text-muted/50"
                          title="End of pipeline">
                          <Icon name="flag" size={16} />
                        </div>
                      </>
                    )}
                  </div>

                  {/* Footer meta */}
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/5 pt-3 text-[11px] text-muted">
                    <span className="inline-flex items-center gap-1"><Icon name="account_tree" size={13} />{steps.length} step{steps.length === 1 ? '' : 's'}</span>
                    <span className="inline-flex items-center gap-1"><Icon name="history" size={13} />{detail.run_count} runs</span>
                    <span className="inline-flex items-center gap-1"><Icon name="schedule" size={13} />last run {timeAgo(detail.last_run_at)}</span>
                    {detail.last_status && <Badge tone={runTone(detail.last_status)} dot>{detail.last_status}</Badge>}
                    {detailLoading && <Icon name="progress_activity" size={13} className="animate-spin text-muted/60" />}
                  </div>
                </Card>

                {/* Run history */}
                <Card className="p-4 animate-fadeInUp md:p-5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Icon name="history" size={18} className="text-emerald" />
                      <h2 className="font-display text-base font-semibold text-ink">Run history</h2>
                      <Badge tone="neutral">{runs.length}</Badge>
                    </div>
                    {runSeries.length > 1 && <Sparkline data={runSeries} colour={FEATURE} width={120} height={30} />}
                  </div>

                  {runs.length === 0 ? (
                    <EmptyState icon="play_circle" accent={FEATURE} title="No runs yet"
                      hint="Hit Run to execute this pipeline and see step-by-step results here." />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-white/8 text-left text-[11px] uppercase tracking-wider text-muted">
                            <th className="py-2 pr-3 font-semibold">Started</th>
                            <th className="py-2 pr-3 font-semibold">Status</th>
                            <th className="py-2 pr-3 font-semibold">Steps</th>
                            <th className="py-2 pr-3 font-semibold">Duration</th>
                            <th className="py-2 font-semibold" aria-label="Open" />
                          </tr>
                        </thead>
                        <tbody>
                          {runs.map((r, i) => (
                            <tr key={r.id} onClick={() => setOpenRun(r)}
                              className="group cursor-pointer border-b border-white/5 transition-colors animate-fadeInUp hover:bg-white/[0.03]"
                              style={{ animationDelay: `${i * 35}ms` }}>
                              <td className="py-2.5 pr-3 text-muted">{timeAgo(r.started_at)}</td>
                              <td className="py-2.5 pr-3"><Badge tone={runTone(r.status)} dot>{r.status}</Badge></td>
                              <td className="py-2.5 pr-3">
                                <span className="inline-flex items-center gap-2">
                                  <span className="font-mono text-ink">{r.result?.ok ?? 0}/{r.result?.total ?? 0}</span>
                                  <StepDots run={r} />
                                </span>
                              </td>
                              <td className="py-2.5 pr-3 font-mono text-muted">{fmtDuration(r)}</td>
                              <td className="py-2.5 text-right">
                                <Icon name="chevron_right" size={18}
                                  className="text-muted/40 transition-transform group-hover:translate-x-0.5 group-hover:text-emerald" />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      {/* Step editor modal */}
      <Modal open={!!editor} onClose={() => setEditor(null)}
        title={editor?.mode === 'edit' ? 'Edit step' : 'Add step'} width="max-w-lg">
        {editor && (
          <StepEditor key={`${editor.mode}-${editor.position}`} mode={editor.mode} initial={editor.step}
            agents={agents} onClose={() => setEditor(null)} onSave={onEditorSave} />
        )}
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete pipeline?" width="max-w-sm">
        <p className="text-sm text-muted">
          This permanently removes <span className="font-semibold text-ink">{confirmDelete?.name}</span> and its run history.
          This can’t be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button variant="danger" icon="delete" loading={deleting} onClick={doDelete}>Delete</Button>
        </div>
      </Modal>

      {/* Run detail drawer */}
      <Drawer open={!!openRun} onClose={() => setOpenRun(null)} width="max-w-lg">
        {openRun && <RunDrawerBody run={openRun} onClose={() => setOpenRun(null)} />}
      </Drawer>
    </div>
  );
}

// ── Connector (arrow + insert affordance) ──────────────────────────────────
function Connector({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex shrink-0 items-center self-center">
      <span className="h-[2px] w-4 rounded bg-gradient-to-r from-emerald/40 to-emerald/10" />
      <button onClick={onAdd} title="Insert a step here"
        className="grid h-6 w-6 place-items-center rounded-full border border-emerald/30 bg-bg text-emerald/70 transition-all hover:scale-110 hover:border-emerald/70 hover:text-emerald hover:shadow-[0_0_12px_rgba(34,197,94,0.45)]">
        <Icon name="add" size={14} />
      </button>
      <span className="h-[2px] w-4 rounded bg-gradient-to-r from-emerald/10 to-emerald/40" />
      <Icon name="chevron_right" size={16} className="-ml-0.5 text-emerald/30" />
    </div>
  );
}

// ── Step card ──────────────────────────────────────────────────────────────
function StepCard({ step, index, total, agents, onEdit, onDelete, onMove }: {
  step: PipelineStep; index: number; total: number; agents: Agent[];
  onEdit: (i: number) => void; onDelete: (i: number) => void; onMove: (i: number, dir: -1 | 1) => void;
}) {
  const meta = stepMeta(step.type);
  const isAgent = step.type === 'agent';
  const agent = isAgent ? agents.find(a => a.id === step.config?.agent_id) : undefined;
  return (
    <div className="w-56 shrink-0 animate-fadeInUp" style={{ animationDelay: `${index * 70}ms` }}>
      <Card hover className="p-3">
        <div className="flex items-start gap-2.5">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
            style={{ background: `${meta.colour}1a`, color: meta.colour, boxShadow: `0 0 16px -6px ${meta.colour}` }}>
            <Icon name={meta.icon} size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display text-sm font-semibold text-ink">{stepLabel(step)}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{meta.label}</div>
          </div>
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-white/5 font-mono text-[10px] text-muted">
            {index + 1}
          </span>
        </div>

        <div className="mt-2.5 min-h-[2.25rem] rounded-lg bg-black/20 px-2.5 py-2 text-[11px] text-muted">
          {isAgent ? (
            agent ? (
              <div className="flex items-center gap-2">
                <Avatar size={22} colour={agent.avatar_colour} initials={agent.avatar_initials} />
                <span className="truncate text-ink">{agent.real_name || agent.name}</span>
              </div>
            ) : <span className="italic text-amber/80">No agent selected</span>
          ) : <span className="line-clamp-2 break-words">{previewText(step)}</span>}
 {step.config?.model && (
 <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted/70">
   <Icon name="memory" size={11} />
   <span className="truncate">{step.config.model}</span>
 </div>
 )}
        </div>

        <div className="mt-2.5 flex items-center justify-between border-t border-white/5 pt-2">
          <div className="flex items-center gap-0.5">
            <IconBtn icon="chevron_left" title="Move left" disabled={index === 0} onClick={() => onMove(index, -1)} />
            <IconBtn icon="chevron_right" title="Move right" disabled={index === total - 1} onClick={() => onMove(index, 1)} />
          </div>
          <div className="flex items-center gap-0.5">
            <IconBtn icon="tune" title="Edit step" onClick={() => onEdit(index)} />
            <IconBtn icon="close" title="Delete step" danger onClick={() => onDelete(index)} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function IconBtn({ icon, onClick, disabled, danger, title }: {
  icon: string; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string;
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`grid h-7 w-7 place-items-center rounded-lg text-muted transition-all hover:bg-white/8
        disabled:opacity-30 disabled:hover:bg-transparent ${danger ? 'hover:text-rose' : 'hover:text-ink'}`}>
      <Icon name={icon} size={16} />
    </button>
  );
}

// ── Step editor (type picker + type-specific config) ───────────────────────
function StepEditor({ mode, initial, agents, onSave, onClose }: {
  mode: 'add' | 'edit'; initial?: PipelineStep; agents: Agent[];
  onSave: (s: PipelineStep) => void; onClose: () => void;
}) {
  const toast = useToast();
  const modelFieldId = useId();
  const initAgent = initial?.config?.agent_id;
  const [type, setType] = useState<string>(String(initial?.type ?? 'agent'));
  const [label, setLabel] = useState<string>(String(initial?.label ?? initial?.config?.label ?? ''));
  const [agentId, setAgentId] = useState<number | ''>(typeof initAgent === 'number' ? initAgent : (agents[0]?.id ?? ''));
  const [prompt, setPrompt] = useState<string>(String(initial?.config?.prompt ?? ''));
  const [model, setModel] = useState<string>(String(initial?.config?.model ?? 'deepseek-chat'));
  const [channel, setChannel] = useState<string>(String(initial?.config?.channel ?? ''));
  const [seconds, setSeconds] = useState<string>(String(initial?.config?.seconds ?? 5));
  const [expr, setExpr] = useState<string>(String(initial?.config?.expr ?? ''));

  const meta = stepMeta(type);
  const pickedAgent = agents.find(a => a.id === agentId);

  const submit = () => {
    const config: Record<string, any> = {};
    if (label.trim()) config.label = label.trim();
    if (type === 'agent') {
      if (agentId === '') { toast('Select an agent for this step', 'warn'); return; }
      config.agent_id = Number(agentId);
      config.model = model;
    } else if (type === 'generate') {
   if (!prompt.trim()) { toast('Enter a prompt', 'warn'); return; }
   config.prompt = prompt.trim();
   config.model = model;
    } else if (type === 'notify') {
      config.channel = channel.trim() || 'general';
    } else if (type === 'delay') {
      config.seconds = Math.max(0, Number(seconds) || 0);
    } else if (type === 'condition') {
      if (!expr.trim()) { toast('Enter a condition expression', 'warn'); return; }
      config.expr = expr.trim();
    }
    onSave({ type, config, position: initial?.position ?? 0, label: label.trim() || undefined });
  };

  return (
    <div className="space-y-4">
      {/* Type picker */}
      <div>
        <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">Step type</label>
        <div role="group" aria-label="Step type" className="grid grid-cols-3 gap-2">
          {STEP_TYPES.map(t => {
            const active = type === t.type;
            return (
              <button key={t.type} onClick={() => setType(t.type)}
                className={`flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-xs transition-all active:scale-95
                  ${active ? 'text-ink' : 'text-muted hover:text-ink'}`}
                style={active
                  ? { borderColor: `${t.colour}66`, background: `${t.colour}14`, boxShadow: `0 0 18px -8px ${t.colour}` }
                  : { borderColor: 'rgba(255,255,255,0.08)' }}>
                <span className="grid h-8 w-8 place-items-center rounded-lg"
                  style={{ background: `${t.colour}1a`, color: t.colour }}>
                  <Icon name={t.icon} size={18} />
                </span>
                {t.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-muted/70">{meta.blurb}</p>
      </div>

      {/* Type-specific config */}
      {type === 'agent' && (
        agents.length === 0 ? (
          <div className="rounded-xl border border-amber/25 bg-amber/10 p-3 text-xs text-amber">
            No agents available in this project. Create an agent first.
          </div>
        ) : (
          <Field label="Agent">
            <Select className="w-full" value={agentId === '' ? '' : String(agentId)}
              onChange={e => setAgentId(e.target.value ? Number(e.target.value) : '')}>
              {agents.map(a => <option key={a.id} value={a.id}>{a.real_name || a.name}</option>)}
            </Select>
            {pickedAgent && (
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-black/20 p-2">
                <Avatar size={26} colour={pickedAgent.avatar_colour} initials={pickedAgent.avatar_initials} />
                <div className="min-w-0">
                  <div className="truncate text-sm text-ink">{pickedAgent.real_name || pickedAgent.name}</div>
                  <div className="truncate text-[11px] text-muted">{pickedAgent.role || pickedAgent.slug}</div>
                </div>
              </div>
            )}
          </Field>
        )
      )}
      {type === 'generate' && (
        <Field label="Prompt">
          <Textarea value={prompt} rows={3} onChange={e => setPrompt(e.target.value)}
            placeholder="Write a concise summary of the previous step…" className="resize-none" />
        </Field>
      )}
      {/* Model selector — shown for agent and generate steps */}
      {(type === 'agent' || type === 'generate') && (
        <div className="mt-3">
          <label htmlFor={modelFieldId} className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">
            Brain <span className="font-normal text-muted/60">(LLM)</span>
          </label>
          <select
            id={modelFieldId}
            value={model}
            onChange={e => setModel(e.target.value)}
            className="block w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-base text-ink outline-none transition focus:border-accent focus:ring-1 focus:ring-accent [&>option]:bg-[#0B1826]">
            <optgroup label="DeepSeek">
              <option value="deepseek-chat">DeepSeek V4 Flash (fast)</option>
              <option value="deepseek-reasoner">DeepSeek V4 Pro (reasoning)</option>
            </optgroup>
            <optgroup label="OpenAI">
              <option value="gpt-4o">GPT-4o</option>
              <option value="gpt-4o-mini">GPT-4o Mini</option>
              <option value="o3">o3 (reasoning)</option>
              <option value="o4-mini">o4 Mini</option>
            </optgroup>
            <optgroup label="Gemini">
              <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
              <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
            </optgroup>
            <optgroup label="Claude">
              <option value="claude-sonnet-4">Claude Sonnet 4</option>
              <option value="claude-opus-4">Claude Opus 4</option>
            </optgroup>
          </select>
        </div>
      )}
      {type === 'notify' && (
        <Field label="Channel">
          <Input value={channel} onChange={e => setChannel(e.target.value)} placeholder="e.g. #ops, email, slack" />
        </Field>
      )}
      {type === 'delay' && (
        <Field label="Delay (seconds)">
          <Input type="number" min={0} value={seconds} onChange={e => setSeconds(e.target.value)} placeholder="5" />
        </Field>
      )}
      {type === 'condition' && (
        <Field label="Expression">
          <Input value={expr} onChange={e => setExpr(e.target.value)} placeholder="e.g. result.score > 0.5" className="font-mono" />
        </Field>
      )}
      {type === 'transform' && (
        <p className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-muted">
          Transform steps reshape the payload passed between steps. No extra configuration needed.
        </p>
      )}

      <Field label="Label (optional)">
        <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={meta.label} />
      </Field>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={mode === 'edit' ? 'save' : 'add'} onClick={submit}
          style={{ background: FEATURE, color: '#04220f' }}>
          {mode === 'edit' ? 'Save step' : 'Add step'}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">{label}</label>
      {isValidElement(children) ? cloneElement(children, { id } as { id: string }) : children}
    </div>
  );
}

// ── Run drawer (per-step results) ──────────────────────────────────────────
function RunDrawerBody({ run, onClose }: { run: PipelineRun; onClose: () => void }) {
  const rsteps: PipelineRunStep[] = run.result?.steps ?? [];
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/10 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-display text-lg font-bold text-ink">Run #{run.id}</h3>
              <Badge tone={runTone(run.status)} dot>{run.status}</Badge>
            </div>
            <div className="mt-1 text-xs text-muted">Started {timeAgo(run.started_at)} · {fmtDuration(run)}</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink"><Icon name="close" /></button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Pill icon="check_circle" colour="#22C55E" label={`${run.result?.ok ?? 0} ok`} />
          <Pill icon="error" colour="#F43F5E" label={`${run.result?.errors ?? 0} errors`} />
          <Pill icon="format_list_numbered" colour="#7B8DA8" label={`${run.result?.total ?? rsteps.length} steps`} />
        </div>
        {run.error && (
          <div className="mt-3 rounded-xl border border-rose/25 bg-rose/10 p-3 text-sm text-rose">{run.error}</div>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-5">
        {rsteps.length === 0 ? (
          <EmptyState icon="pending" title="No step output" hint="This run produced no per-step details." />
        ) : (
          rsteps.map((s, i) => {
            const meta = stepMeta(s.type);
            const stTone: Tone = s.status === 'ok' ? 'ok' : s.status === 'error' ? 'danger' : 'neutral';
            return (
              <div key={i} className="rounded-xl border border-white/10 bg-black/20 p-3 animate-fadeInUp"
                style={{ animationDelay: `${i * 45}ms` }}>
                <div className="flex items-center gap-2.5">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
                    style={{ background: `${meta.colour}1a`, color: meta.colour }}>
                    <Icon name={meta.icon} size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-ink">{s.label || meta.label}</div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{s.type}</div>
                  </div>
                  <Badge tone={stTone} dot>{s.status}</Badge>
                </div>
                {s.output && (
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2.5 font-mono text-[11px] text-ink/80">
                    {s.output}
                  </pre>
                )}
                <div className="mt-2 flex items-center gap-1 text-[11px] text-muted/70">
                  <Icon name="timer" size={12} /> {s.ms}ms
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function Pill({ icon, colour, label }: { icon: string; colour: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold"
      style={{ color: colour, borderColor: `${colour}44`, background: `${colour}1a` }}>
      <Icon name={icon} size={13} /> {label}
    </span>
  );
}

// ── Small colour-coded step-status dots for the history table ──────────────
function StepDots({ run }: { run: PipelineRun }) {
  const rsteps = run.result?.steps ?? [];
  const dot = (st: string) => (st === 'ok' ? '#22C55E' : st === 'error' ? '#F43F5E' : '#7B8DA8');
  if (rsteps.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5">
      {rsteps.slice(0, 8).map((s, i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: dot(s.status) }} />
      ))}
    </span>
  );
}
