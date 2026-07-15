// Kanban — a five-column agent task board with native drag-and-drop, AI
// auto-assign, client-side filtering, and a full edit drawer. Reads/writes
// via api.kanbanTasks / createKanbanTask / updateKanbanTask / deleteKanbanTask
// / autoAssignTask, and api.agents for the assignee picker + filter.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Icon, Button, Badge, Input, Textarea, Select, Modal, Drawer,
  EmptyState, SkeletonList, useToast, useCountUp,
} from '../components/ui';
import { Avatar } from '../components/Avatar';
import { api, timeAgo } from '../lib/api';
import { useApp } from '../lib/store';
import type { KanbanTask, KanbanStatus, Priority, Agent } from '../lib/types';

// ── Board config ────────────────────────────────────────────────────────────
type ColMeta = { id: KanbanStatus; label: string; colour: string; icon: string };
const COLUMNS: ColMeta[] = [
  { id: 'backlog',     label: 'Backlog',     colour: '#7B8DA8', icon: 'inbox' },
  { id: 'todo',        label: 'To Do',       colour: '#38BDF8', icon: 'radio_button_unchecked' },
  { id: 'in_progress', label: 'In Progress', colour: '#F59E0B', icon: 'bolt' },
  { id: 'review',      label: 'Review',      colour: '#A78BFA', icon: 'visibility' },
  { id: 'done',        label: 'Done',        colour: '#22C55E', icon: 'check_circle' },
];
const STATUS_META: Record<KanbanStatus, ColMeta> =
  COLUMNS.reduce((m, c) => { m[c.id] = c; return m; }, {} as Record<KanbanStatus, ColMeta>);
const STATUS_ORDER = COLUMNS.map(c => c.id);

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low'];
const PRIORITY_TONE = { urgent: 'danger', high: 'warn', medium: 'info', low: 'neutral' } as const;
const PRIORITY_COLOUR: Record<Priority, string> = {
  urgent: '#F43F5E', high: '#F59E0B', medium: '#38BDF8', low: '#7B8DA8',
};

// ── Small helpers ───────────────────────────────────────────────────────────
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const nowSec = () => Math.floor(Date.now() / 1000);
const toDateInput = (ts: number | null): string => {
  if (!ts) return '';
  const d = new Date(ts * 1000);   // local time, to match fmtDate + the overdue check
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fromDateInput = (str: string): number | null =>
  str ? Math.floor(new Date(str + 'T00:00:00').getTime() / 1000) : null;   // local midnight, not UTC
const fmtDate = (ts: number): string =>
  new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ════════════════════════════════════════════════════════════════════════════
export default function Kanban() {
  const { selectedTenant } = useApp();
  const toast = useToast();

  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  // filters (client-side)
  const [filterAgent, setFilterAgent] = useState<number | 'all'>('all');
  const [filterPriority, setFilterPriority] = useState<Priority | 'all'>('all');
  const [filterLabel, setFilterLabel] = useState<string>('all');

  // overlays
  const [openId, setOpenId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createStatus, setCreateStatus] = useState<KanbanStatus>('backlog');

  // drag + async state
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<KanbanStatus | null>(null);
  const [assigning, setAssigning] = useState<Record<number, boolean>>({});

  const load = async () => {
    setLoading(true);
    try {
      const t = await api.kanbanTasks({ tenant_id: selectedTenant ?? undefined });
      setTasks(t.tasks || []);
    } catch {
      toast('Failed to load the board', 'danger');
    }
    try {
      const a = await api.agents(selectedTenant ?? undefined);
      setAgents(a.agents || []);
    } catch { /* agents are optional for the board to render */ }
    setLoading(false);
  };

  // Silent re-fetch used to recover after a failed optimistic mutation.
  const reload = async () => {
    try {
      const t = await api.kanbanTasks({ tenant_id: selectedTenant ?? undefined });
      setTasks(t.tasks || []);
    } catch { /* ignore */ }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [selectedTenant]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const labels = useMemo(() => {
    const s = new Set<string>();
    tasks.forEach(t => (t.labels || []).forEach(l => s.add(l)));
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [tasks]);

  const filtered = useMemo(() => tasks.filter(t => {
    if (filterAgent !== 'all' && t.assigned_agent_id !== filterAgent) return false;
    if (filterPriority !== 'all' && t.priority !== filterPriority) return false;
    if (filterLabel !== 'all' && !(t.labels || []).includes(filterLabel)) return false;
    return true;
  }), [tasks, filterAgent, filterPriority, filterLabel]);

  const grouped = useMemo(() => {
    const map: Record<KanbanStatus, KanbanTask[]> =
      { backlog: [], todo: [], in_progress: [], review: [], done: [] };
    filtered.forEach(t => { if (map[t.status]) map[t.status].push(t); });
    STATUS_ORDER.forEach(k => map[k].sort((a, b) => (a.position - b.position) || (a.created_at - b.created_at)));
    return map;
  }, [filtered]);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const dayStart = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000);
  }, []);
  const now = nowSec();
  const overdueCount = tasks.filter(t => t.due_date != null && t.due_date < now && t.status !== 'done').length;
  const doneTodayCount = tasks.filter(t => t.status === 'done' && t.updated_at >= dayStart).length;
  const totalC = useCountUp(tasks.length);
  const overdueC = useCountUp(overdueCount);
  const doneC = useCountUp(doneTodayCount);

  const filtersActive = filterAgent !== 'all' || filterPriority !== 'all' || filterLabel !== 'all';
  const openTask = openId != null ? tasks.find(t => t.id === openId) || null : null;

  // ── Mutations ───────────────────────────────────────────────────────────────
  const applyTask = (updated: KanbanTask) =>
    setTasks(ts => ts.map(t => (t.id === updated.id ? updated : t)));

  const moveTask = async (id: number, status: KanbanStatus) => {
    const cur = tasks.find(t => t.id === id);
    if (!cur || cur.status === status) return;
    const snapshot = tasks;
    setTasks(ts => ts.map(t => (t.id === id ? { ...t, status } : t))); // optimistic
    try {
      const res = await api.updateKanbanTask(id, { status });
      applyTask(res.task);
    } catch {
      setTasks(snapshot);
      toast('Could not move task', 'danger');
      reload();
    }
  };

  const autoAssign = async (id: number) => {
    setAssigning(a => ({ ...a, [id]: true }));
    try {
      const res = await api.autoAssignTask(id);
      applyTask(res.task);
      if (res.agent) toast(`Assigned to ${res.agent.name}: ${res.reason}`, 'ok');
      else toast(res.reason || 'No suitable agent found', 'warn');
    } catch {
      toast('Auto-assign failed', 'danger');
    }
    setAssigning(a => ({ ...a, [id]: false }));
  };

  const openCreate = (status: KanbanStatus = 'backlog') => {
    setCreateStatus(status);
    setCreateOpen(true);
  };

  const clearFilters = () => { setFilterAgent('all'); setFilterPriority('all'); setFilterLabel('all'); };

  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div className="flex h-full flex-col">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className="shrink-0 space-y-3 border-b border-white/6 bg-surface/30 p-4 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 animate-fadeInUp">
            <div className="grid h-11 w-11 place-items-center rounded-2xl"
              style={{ background: '#F59E0B1a', color: '#F59E0B', boxShadow: '0 0 26px -6px #F59E0B99' }}>
              <Icon name="dashboard" size={24} />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold leading-tight text-ink">Kanban</h1>
              <p className="text-xs text-muted">
                {tasks.length} task{tasks.length === 1 ? '' : 's'} · {agents.length} agent{agents.length === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatPill icon="dashboard_customize" label="Total" value={totalC} accent="#38BDF8" />
            <StatPill icon="warning" label="Overdue" value={overdueC} accent="#F43F5E" />
            <StatPill icon="task_alt" label="Done today" value={doneC} accent="#22C55E" />
            <Button variant="primary" icon="add" onClick={() => openCreate('backlog')}
              style={{ background: '#F59E0B', color: '#1c1204', boxShadow: '0 0 20px rgba(245,158,11,0.3)' }}>
              New task
            </Button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted">
            <Icon name="filter_list" size={16} /> Filter
          </span>
          <Select value={filterAgent === 'all' ? 'all' : String(filterAgent)}
            onChange={e => setFilterAgent(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">All agents</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.real_name || a.name}</option>)}
          </Select>
          <Select value={filterPriority} onChange={e => setFilterPriority(e.target.value as Priority | 'all')}>
            <option value="all">All priorities</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{cap(p)}</option>)}
          </Select>
          <Select value={filterLabel} onChange={e => setFilterLabel(e.target.value)}>
            <option value="all">All labels</option>
            {labels.map(l => <option key={l} value={l}>{l}</option>)}
          </Select>
          {filtersActive && (
            <Button variant="ghost" icon="close" onClick={clearFilters} className="px-2 py-1 text-xs">Clear</Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Badge tone="neutral">{filtered.length}/{tasks.length} shown</Badge>
            <Button variant="ghost" icon="refresh" onClick={load} loading={loading} title="Refresh" />
          </div>
        </div>
      </div>

      {/* ── Board ────────────────────────────────────────────────────────── */}
      {loading ? (
        <BoardSkeleton />
      ) : tasks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState icon="dashboard" accent="#F59E0B" large
            title="No active boards"
            hint="Create your first task, then drag it across Backlog → Done as your agents work through it."
            action={
              <Button variant="primary" icon="add" onClick={() => openCreate('backlog')}
                style={{ background: '#F59E0B', color: '#1c1204' }}>New task</Button>
            } />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="flex h-full gap-3 p-4 md:gap-4 md:px-6">
            {COLUMNS.map((col, ci) => {
              const items = grouped[col.id];
              const isOver = dragOverCol === col.id;
              return (
                <section key={col.id}
                  onDragOver={e => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dragOverCol !== col.id) setDragOverCol(col.id);
                  }}
                  onDragLeave={e => {
                    const r = e.relatedTarget as Node | null;
                    if (!e.currentTarget.contains(r)) setDragOverCol(prev => (prev === col.id ? null : prev));
                  }}
                  onDrop={e => {
                    e.preventDefault();
                    const id = Number(e.dataTransfer.getData('text/plain')) || dragId;
                    setDragOverCol(null); setDragId(null);
                    if (id) moveTask(id, col.id);
                  }}
                  className="flex h-full min-w-[264px] flex-1 flex-col rounded-2xl border border-white/6 bg-white/[0.015] p-2.5 transition-all animate-fadeInUp"
                  style={{ animationDelay: `${ci * 60}ms`, ...(isOver ? { boxShadow: `inset 0 0 0 1.5px ${col.colour}`, background: `${col.colour}0d` } : {}) }}>
                  {/* Column header */}
                  <div className="mb-2.5 flex shrink-0 items-center justify-between gap-2 px-1">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: col.colour, boxShadow: `0 0 8px ${col.colour}` }} />
                      <span className="font-display text-sm font-semibold text-ink">{col.label}</span>
                      <span className="rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
                        style={{ background: `${col.colour}1a`, color: col.colour }}>{items.length}</span>
                    </div>
                    <button type="button" title={`Add to ${col.label}`} onClick={() => openCreate(col.id)}
                      className="grid h-6 w-6 place-items-center rounded-lg text-muted transition-colors hover:bg-white/10 hover:text-ink">
                      <Icon name="add" size={16} />
                    </button>
                  </div>

                  {/* Column body */}
                  <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-0.5 pb-1">
                    {items.length === 0 ? (
                      <div className={`mt-1 flex h-24 flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-center transition-colors
                        ${isOver ? 'border-white/25' : 'border-white/8'}`}>
                        <Icon name={col.icon} size={20} style={{ color: `${col.colour}99` }} />
                        <span className="text-[11px] text-muted/60">{isOver ? 'Release to drop' : 'No tasks'}</span>
                      </div>
                    ) : items.map((t, i) => (
                      <TaskCard key={t.id} task={t} index={i}
                        dragging={dragId === t.id} assigning={!!assigning[t.id]}
                        canLeft={ci > 0} canRight={ci < COLUMNS.length - 1}
                        onOpen={() => setOpenId(t.id)}
                        onMove={dir => moveTask(t.id, COLUMNS[ci + dir].id)}
                        onAutoAssign={() => autoAssign(t.id)}
                        onDragStart={() => setDragId(t.id)}
                        onDragEnd={() => { setDragId(null); setDragOverCol(null); }} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Detail drawer ────────────────────────────────────────────────── */}
      <Drawer open={openId !== null} onClose={() => setOpenId(null)} width="max-w-md">
        {openTask && (
          <TaskDrawer key={openTask.id} task={openTask} agents={agents}
            onClose={() => setOpenId(null)}
            onChange={applyTask}
            onDeleted={id => { setTasks(ts => ts.filter(t => t.id !== id)); setOpenId(null); }} />
        )}
      </Drawer>

      {/* ── Create modal ─────────────────────────────────────────────────── */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New task" width="max-w-lg">
        <CreateForm agents={agents} defaultStatus={createStatus} tenantId={selectedTenant}
          onClose={() => setCreateOpen(false)}
          onCreated={task => { setTasks(ts => [task, ...ts]); setCreateOpen(false); }} />
      </Modal>
    </div>
  );
}

// ── Compact stat pill ───────────────────────────────────────────────────────
function StatPill({ icon, label, value, accent }:
  { icon: string; label: string; value: number; accent: string }) {
  return (
    <div className="glass flex items-center gap-2 rounded-xl px-3 py-1.5">
      <span className="grid h-7 w-7 place-items-center rounded-lg" style={{ background: `${accent}1a`, color: accent }}>
        <Icon name={icon} size={16} />
      </span>
      <span className="font-display text-lg font-bold leading-none tabular-nums text-ink">{value}</span>
      <span className="hidden text-[11px] text-muted sm:inline">{label}</span>
    </div>
  );
}

// ── Small icon button (card actions) ────────────────────────────────────────
function IconBtn({ name, title, onClick, disabled, spin, accent }:
  { name: string; title: string; onClick: () => void; disabled?: boolean; spin?: boolean; accent?: string }) {
  return (
    <button type="button" title={title} disabled={disabled}
      onClick={e => { e.stopPropagation(); onClick(); }}
      className="grid h-7 w-7 place-items-center rounded-lg text-muted transition-colors hover:bg-white/10 hover:text-ink disabled:opacity-25 disabled:hover:bg-transparent"
      style={accent && !disabled ? { color: accent } : undefined}>
      <Icon name={name} size={18} className={spin ? 'animate-spin' : ''} />
    </button>
  );
}

// ── Task card ───────────────────────────────────────────────────────────────
function TaskCard({ task, index, dragging, assigning, canLeft, canRight, onOpen, onMove, onAutoAssign, onDragStart, onDragEnd }:
  { task: KanbanTask; index: number; dragging: boolean; assigning: boolean;
    canLeft: boolean; canRight: boolean; onOpen: () => void; onMove: (dir: -1 | 1) => void;
    onAutoAssign: () => void; onDragStart: () => void; onDragEnd: () => void }) {
  const labels = task.labels || [];
  const overdue = task.due_date != null && task.due_date < nowSec() && task.status !== 'done';
  const hasMeta = labels.length > 0 || task.due_date != null;

  return (
    <div draggable
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(task.id)); onDragStart(); }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`group card cursor-grab rounded-xl border-l-[3px] p-3 transition-all animate-fadeInUp
        hover:-translate-y-0.5 hover:border-white/10 hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.7)]
        active:cursor-grabbing ${dragging ? 'opacity-40' : ''}`}
      style={{ borderLeftColor: PRIORITY_COLOUR[task.priority], animationDelay: `${index * 40}ms` }}>
      {/* Title + priority */}
      <div className="flex items-start justify-between gap-2">
        <div className="line-clamp-2 flex-1 text-sm font-medium leading-snug text-ink">{task.title}</div>
        <Badge tone={PRIORITY_TONE[task.priority]} dot>{cap(task.priority)}</Badge>
      </div>

      {task.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted">{task.description}</p>
      )}

      {/* Labels + due date */}
      {hasMeta && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {labels.slice(0, 3).map(l => (
            <span key={l} className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent/90">{l}</span>
          ))}
          {labels.length > 3 && <span className="text-[10px] text-muted">+{labels.length - 3}</span>}
          {task.due_date != null && (
            <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium
              ${overdue ? 'bg-rose/15 text-rose' : 'bg-white/5 text-muted'}`}>
              <Icon name={overdue ? 'event_busy' : 'event'} size={12} />
              {fmtDate(task.due_date)}{overdue ? ' · overdue' : ''}
            </span>
          )}
        </div>
      )}

      {/* Footer: assignee + actions */}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-white/5 pt-2.5">
        {task.agent ? (
          <span className="flex min-w-0 items-center gap-1.5" title={`Assigned to ${task.agent.name}`}>
            <Avatar size={26} colour={task.agent.colour} initials={task.agent.initials} />
            <span className="truncate text-[11px] text-muted">{task.agent.name}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[11px] text-muted/70" title="Unassigned">
            <span className="grid h-[26px] w-[26px] place-items-center rounded-full border border-dashed border-white/20 text-muted/60">
              <Icon name="person" size={14} />
            </span>
            Unassigned
          </span>
        )}

        <div className="flex items-center gap-0.5">
          <IconBtn name="chevron_left" title="Move left" disabled={!canLeft} onClick={() => onMove(-1)} />
          <IconBtn name={assigning ? 'progress_activity' : 'auto_awesome'} spin={assigning}
            title="Auto-assign best agent" accent="#F59E0B" onClick={onAutoAssign} />
          <IconBtn name="chevron_right" title="Move right" disabled={!canRight} onClick={() => onMove(1)} />
        </div>
      </div>
    </div>
  );
}

// ── Board loading skeleton (column-shaped) ──────────────────────────────────
function BoardSkeleton() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <div className="flex h-full gap-3 p-4 md:gap-4 md:px-6">
        {COLUMNS.map(col => (
          <div key={col.id} className="flex h-full min-w-[264px] flex-1 flex-col rounded-2xl border border-white/6 bg-white/[0.015] p-2.5">
            <div className="mb-3 flex items-center gap-2 px-1">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: col.colour }} />
              <span className="font-display text-sm font-semibold text-muted">{col.label}</span>
            </div>
            <SkeletonList count={3} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Reusable labelled field ─────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">{label}</label>
      {children}
    </div>
  );
}

// ── Label chip editor ───────────────────────────────────────────────────────
function LabelEditor({ value, onChange }: { value: string[]; onChange: (labels: string[]) => void }) {
  const [input, setInput] = useState('');
  const add = () => {
    const v = input.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setInput('');
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map(l => (
          <span key={l} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-accent/70" />
            {l}
            <button type="button" onClick={() => onChange(value.filter(x => x !== l))}
              className="text-muted hover:text-rose"><Icon name="close" size={13} /></button>
          </span>
        ))}
        {value.length === 0 && <span className="text-xs text-muted/60">No labels yet</span>}
      </div>
      <div className="mt-2 flex gap-2">
        <Input value={input} placeholder="Add a label…" onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button type="button" variant="secondary" icon="add" onClick={add}>Add</Button>
      </div>
    </div>
  );
}

// ── Assignee picker (shared by drawer + create) ─────────────────────────────
function AssigneeSelect({ agents, value, onChange }:
  { agents: Agent[]; value: number | null; onChange: (id: number | null) => void }) {
  return (
    <Select value={value === null ? '' : String(value)} className="w-full flex-1"
      onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">Unassigned</option>
      {agents.map(a => <option key={a.id} value={a.id}>{a.real_name || a.name}</option>)}
    </Select>
  );
}

// ── Detail / edit drawer ────────────────────────────────────────────────────
function TaskDrawer({ task, agents, onClose, onChange, onDeleted }:
  { task: KanbanTask; agents: Agent[]; onClose: () => void;
    onChange: (t: KanbanTask) => void; onDeleted: (id: number) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [status, setStatus] = useState<KanbanStatus>(task.status);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [assignee, setAssignee] = useState<number | null>(task.assigned_agent_id);
  const [labelList, setLabelList] = useState<string[]>(task.labels || []);
  const [dueStr, setDueStr] = useState(toDateInput(task.due_date));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [assigningLocal, setAssigningLocal] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const meta = STATUS_META[status];
  const selectedAgent = agents.find(a => a.id === assignee) || null;

  const save = async () => {
    if (!title.trim()) { toast('Title is required', 'warn'); return; }
    setSaving(true);
    try {
      const res = await api.updateKanbanTask(task.id, {
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        status,
        priority,
        assigned_agent_id: assignee,
        labels: labelList,
        due_date: fromDateInput(dueStr),
      });
      onChange(res.task);
      toast('Task saved', 'ok');
    } catch {
      toast('Could not save task', 'danger');
    }
    setSaving(false);
  };

  const doAutoAssign = async () => {
    setAssigningLocal(true);
    try {
      const res = await api.autoAssignTask(task.id);
      setAssignee(res.task.assigned_agent_id);
      onChange(res.task);
      if (res.agent) toast(`Assigned to ${res.agent.name}: ${res.reason}`, 'ok');
      else toast(res.reason || 'No suitable agent found', 'warn');
    } catch {
      toast('Auto-assign failed', 'danger');
    }
    setAssigningLocal(false);
  };

  const del = async () => {
    setDeleting(true);
    try {
      await api.deleteKanbanTask(task.id);
      toast('Task deleted', 'ok');
      onDeleted(task.id);
    } catch {
      toast('Could not delete task', 'danger');
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-white/10 p-5">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl"
          style={{ background: `${meta.colour}1a`, color: meta.colour }}>
          <Icon name={meta.icon} size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg font-bold leading-tight text-ink">Edit task</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={PRIORITY_TONE[priority]} dot>{cap(priority)}</Badge>
            <span className="text-[11px] text-muted">{meta.label} · #{task.id}</span>
          </div>
        </div>
        <button onClick={onClose} className="text-muted hover:text-ink"><Icon name="close" /></button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <Field label="Title">
          <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Task title" />
        </Field>
        <Field label="Description">
          <Textarea value={description} rows={4} onChange={e => setDescription(e.target.value)}
            placeholder="Add more detail…" className="resize-none" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <Select value={status} onChange={e => setStatus(e.target.value as KanbanStatus)} className="w-full">
              {COLUMNS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={e => setPriority(e.target.value as Priority)} className="w-full">
              {PRIORITIES.map(p => <option key={p} value={p}>{cap(p)}</option>)}
            </Select>
          </Field>
        </div>

        <Field label="Assignee">
          <div className="flex items-center gap-2">
            {selectedAgent
              ? <Avatar size={30} colour={selectedAgent.avatar_colour} initials={selectedAgent.avatar_initials} />
              : <span className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full border border-dashed border-white/20 text-muted/60"><Icon name="person" size={16} /></span>}
            <AssigneeSelect agents={agents} value={assignee} onChange={setAssignee} />
            <Button variant="secondary" icon="auto_awesome" loading={assigningLocal}
              onClick={doAutoAssign} title="Let AI pick the best agent">Auto</Button>
          </div>
        </Field>

        <Field label="Labels">
          <LabelEditor value={labelList} onChange={setLabelList} />
        </Field>

        <Field label="Due date">
          <div className="flex items-center gap-2">
            <Input type="date" value={dueStr} onChange={e => setDueStr(e.target.value)} className="flex-1" />
            {dueStr && <Button variant="ghost" icon="close" onClick={() => setDueStr('')} title="Clear due date" />}
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/8 pt-3 text-[11px] text-muted/70">
          <span className="inline-flex items-center gap-1"><Icon name="schedule" size={13} /> Created {timeAgo(task.created_at)}</span>
          <span className="inline-flex items-center gap-1"><Icon name="update" size={13} /> Updated {timeAgo(task.updated_at)}</span>
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between gap-2 border-t border-white/10 p-4">
        {confirmDel ? (
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-xs text-muted">Delete this task?</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setConfirmDel(false)}>Cancel</Button>
              <Button variant="danger" icon="delete" loading={deleting} onClick={del}>Delete</Button>
            </div>
          </div>
        ) : (
          <>
            <Button variant="ghost" icon="delete" className="text-rose hover:bg-rose/10"
              onClick={() => setConfirmDel(true)}>Delete</Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <Button variant="primary" icon="save" loading={saving} onClick={save}>Save</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Create form (inside modal) ──────────────────────────────────────────────
function CreateForm({ agents, defaultStatus, tenantId, onClose, onCreated }:
  { agents: Agent[]; defaultStatus: KanbanStatus; tenantId: number | null;
    onClose: () => void; onCreated: (t: KanbanTask) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<KanbanStatus>(defaultStatus);
  const [priority, setPriority] = useState<Priority>('medium');
  const [assignee, setAssignee] = useState<number | null>(null);
  const [labelList, setLabelList] = useState<string[]>([]);
  const [dueStr, setDueStr] = useState('');
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!title.trim()) { toast('Title is required', 'warn'); return; }
    setSaving(true);
    try {
      const res = await api.createKanbanTask({
        title: title.trim(),
        description: description.trim() || undefined,
        status,
        priority,
        assigned_agent_id: assignee ?? undefined,
        labels: labelList,
        due_date: fromDateInput(dueStr) ?? undefined,
        tenant_id: tenantId ?? undefined,
      });
      onCreated(res.task);
      toast('Task created', 'ok');
    } catch {
      toast('Could not create task', 'danger');
    }
    setSaving(false);
  };

  return (
    <div className="max-h-[72vh] space-y-4 overflow-y-auto pr-0.5">
      <Field label="Title">
        <Input autoFocus value={title} onChange={e => setTitle(e.target.value)}
          placeholder="What needs doing?"
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) create(); }} />
      </Field>
      <Field label="Description">
        <Textarea value={description} rows={3} onChange={e => setDescription(e.target.value)}
          placeholder="Optional detail…" className="resize-none" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <Select value={status} onChange={e => setStatus(e.target.value as KanbanStatus)} className="w-full">
            {COLUMNS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={e => setPriority(e.target.value as Priority)} className="w-full">
            {PRIORITIES.map(p => <option key={p} value={p}>{cap(p)}</option>)}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Assignee">
          <AssigneeSelect agents={agents} value={assignee} onChange={setAssignee} />
        </Field>
        <Field label="Due date">
          <Input type="date" value={dueStr} onChange={e => setDueStr(e.target.value)} className="w-full" />
        </Field>
      </div>

      <Field label="Labels">
        <LabelEditor value={labelList} onChange={setLabelList} />
      </Field>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="add" loading={saving} onClick={create}
          style={{ background: '#F59E0B', color: '#1c1204' }}>Create task</Button>
      </div>
    </div>
  );
}
