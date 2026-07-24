// Workspace Gallery — a gorgeous asset library for everything the fleet makes.
// Smart-folder sidebar, server-side filters (type/agent/model/project/search),
// client-side date filter, grid + list views, type-coloured gradient
// placeholders, a rich preview modal and an "add to workspace" composer.
import { useState, useEffect, useMemo } from 'react';
import {
  Icon, Button, Card, Badge, Input, Select, Modal,
  EmptyState, SkeletonList, useToast, Stat, useCountUp,
} from '../components/ui';
import { Avatar } from '../components/Avatar';
import { useApp } from '../lib/store';
import { api, timeAgo } from '../lib/api';
import type { WorkspaceItem, WorkspaceStats, Agent } from '../lib/types';

// ── Type metadata → icon + brand colour + labels ───────────────────────────
type TypeMeta = { icon: string; colour: string; label: string; plural: string };
const TYPE_META: Record<string, TypeMeta> = {
  image:    { icon: 'image',       colour: '#C084FC', label: 'Image',    plural: 'Images' },
  document: { icon: 'description', colour: '#38BDF8', label: 'Document', plural: 'Documents' },
  post:     { icon: 'tag',         colour: '#F59E0B', label: 'Post',     plural: 'Posts' },
  code:     { icon: 'code',        colour: '#22C55E', label: 'Code',     plural: 'Snippets' },
  video:    { icon: 'movie',       colour: '#F43F5E', label: 'Video',    plural: 'Videos' },
  design:   { icon: 'palette',     colour: '#A78BFA', label: 'Design',   plural: 'Designs' },
};
const TYPE_ORDER = ['image', 'document', 'post', 'code', 'video', 'design'];
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Item');
function typeMeta(type: string): TypeMeta {
  return TYPE_META[type] || { icon: 'draft', colour: '#7B8DA8', label: cap(type), plural: cap(type) };
}

type View = 'grid' | 'list';
type DateFilter = 'all' | 'today' | 'week' | 'month';
const DATE_OPTS: Array<{ id: DateFilter; label: string }> = [
  { id: 'all', label: 'Any time' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
];

export default function Gallery() {
  const { selectedTenant } = useApp();
  const toast = useToast();

  // Data
  const [items, setItems] = useState<WorkspaceItem[]>([]);   // filtered (server) result
  const [facets, setFacets] = useState<WorkspaceItem[]>([]); // unfiltered tenant set → folders/options
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [itemsError, setItemsError] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  // Filters (server) + view/date (client)
  const [type, setType] = useState('');
  const [agentId, setAgentId] = useState('');
  const [model, setModel] = useState('');
  const [project, setProject] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [view, setView] = useState<View>('grid');

  // UI
  const [preview, setPreview] = useState<WorkspaceItem | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const refresh = () => setReloadKey(k => k + 1);

  // Debounce the search box into the committed query.
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Facets + stats + agents — refetched only per tenant (stable folders/options).
  useEffect(() => {
    let ignore = false;
    const t = selectedTenant ?? undefined;
    api.workspace({ tenant_id: t }).then(r => { if (!ignore) setFacets(r.items || []); }).catch(() => {});
    api.workspaceStats(t)
      .then(s => { if (!ignore) { setStats(s); setStatsError(false); } })
      .catch(() => { if (!ignore) { setStats(null); setStatsError(true); } });
    api.agents(t).then(a => { if (!ignore) setAgents(a.agents || []); }).catch(() => {});
    return () => { ignore = true; };
  }, [selectedTenant, reloadKey]);

  // Filtered items — refetched whenever a server filter changes.
  useEffect(() => {
    let ignore = false;
    setLoading(true);
    api.workspace({
      tenant_id: selectedTenant ?? undefined,
      type: type || undefined,
      agent_id: agentId ? Number(agentId) : undefined,
      model: model || undefined,
      project: project || undefined,
      q: q || undefined,
    })
      .then(r => { if (!ignore) { setItems(r.items || []); setItemsError(false); } })
      .catch(() => { if (!ignore) { setItems([]); setItemsError(true); toast('Could not load the gallery', 'danger'); } })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTenant, type, agentId, model, project, q, reloadKey]);

  // ── Derived option/folder lists (from the unfiltered facet set) ──────────
  const typeFolders = useMemo(() => {
    const by = stats?.by_type || {};
    const keys = Object.keys(by);
    const ordered = [
      ...TYPE_ORDER.filter(t => (by[t] || 0) > 0),
      ...keys.filter(k => !TYPE_ORDER.includes(k) && (by[k] || 0) > 0),
    ];
    return ordered.map(t => ({ type: t, count: by[t], ...typeMeta(t) }));
  }, [stats]);

  const projectFolders = useMemo(() => {
    const map = new Map<string, number>();
    facets.forEach(i => { if (i.project) map.set(i.project, (map.get(i.project) || 0) + 1); });
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  }, [facets]);

  const modelOptions = useMemo(
    () => Array.from(new Set(facets.map(i => i.model).filter((m): m is string => !!m))).sort(),
    [facets],
  );

  const topTypes = useMemo(
    () => Object.entries(stats?.by_type || {}).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 3),
    [stats],
  );

  // Client-side date filter.
  const displayed = useMemo(() => {
    if (dateFilter === 'all') return items;
    const now = Date.now() / 1000;
    let cutoff = 0;
    if (dateFilter === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); cutoff = d.getTime() / 1000; }
    else if (dateFilter === 'week') cutoff = now - 7 * 86400;
    else if (dateFilter === 'month') cutoff = now - 30 * 86400;
    return items.filter(i => i.created_at >= cutoff);
  }, [items, dateFilter]);

  const anyFilter = !!(type || agentId || model || project || q || dateFilter !== 'all');
  const clearAll = () => {
    setType(''); setAgentId(''); setModel(''); setProject('');
    setSearchInput(''); setQ(''); setDateFilter('all');
  };

  // ── Mutations ────────────────────────────────────────────────────────────
  const doDelete = async (item: WorkspaceItem) => {
    setItems(prev => prev.filter(i => i.id !== item.id));
    setFacets(prev => prev.filter(i => i.id !== item.id));
    setPreview(p => (p && p.id === item.id ? null : p));
    try {
      await api.deleteWorkspaceItem(item.id);
      setStats(s => s ? {
        total: Math.max(0, s.total - 1),
        by_type: { ...s.by_type, [item.type]: Math.max(0, (s.by_type[item.type] || 0) - 1) },
      } : s);
      toast('Asset deleted', 'ok');
    } catch {
      toast('Delete failed — restoring', 'danger');
      refresh();
    }
  };

  const subtitle = stats
    ? `${stats.total.toLocaleString()} asset${stats.total === 1 ? '' : 's'} across the workspace`
    : "Your fleet's creative output, all in one place";

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between animate-fadeInUp">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl"
              style={{ background: '#C084FC1a', color: '#C084FC', boxShadow: '0 0 24px -6px #C084FC66' }}>
              <Icon name="photo_library" size={24} />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold text-ink">Gallery</h1>
              <p className="text-sm text-muted">{subtitle}</p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="glass" icon="add" onClick={() => setAddOpen(true)}>Add asset</Button>
            <Button variant="secondary" icon="refresh" loading={loading} onClick={refresh}>Refresh</Button>
          </div>
        </div>

        {/* Stat tiles */}
        {stats ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <CountStat label="Total assets" value={stats.total} icon="photo_library" accent="#C084FC" delay={0} />
            {topTypes.map(([t, c], i) => {
              const m = typeMeta(t);
              return <CountStat key={t} label={m.plural} value={c} icon={m.icon} accent={m.colour} delay={(i + 1) * 80} />;
            })}
          </div>
        ) : statsError ? (
          <Card glass className="flex items-center justify-between gap-3 p-4">
            <div className="flex min-w-0 items-center gap-2 text-sm text-muted">
              <Icon name="error" size={18} className="shrink-0 text-rose" />
              <span className="truncate">Couldn't load workspace stats.</span>
            </div>
            <Button variant="secondary" icon="refresh" loading={loading} onClick={refresh} className="shrink-0">Retry</Button>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-[76px] animate-pulse rounded-2xl bg-white/5" style={{ animationDelay: `${i * 80}ms` }} />
            ))}
          </div>
        )}
      </div>

      {/* ── Body: folders + main ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Smart folders */}
        <aside className="lg:w-60 lg:shrink-0">
          <Card glass className="p-2 lg:sticky lg:top-6">
            <FolderButton active={!type && !project} icon="grid_view" label="All items"
              count={facets.length} colour="#C084FC" onClick={() => { setType(''); setProject(''); }} />

            <div className="px-2.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted/70">Types</div>
            {typeFolders.length === 0 && <div className="px-2.5 py-1 text-xs text-muted/60">No types yet</div>}
            {typeFolders.map(f => (
              <FolderButton key={f.type} active={type === f.type} icon={f.icon} label={f.plural}
                count={f.count} colour={f.colour} onClick={() => setType(t => (t === f.type ? '' : f.type))} />
            ))}

            {projectFolders.length > 0 && (
              <>
                <div className="px-2.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted/70">Projects</div>
                <div className="max-h-56 space-y-0.5 overflow-y-auto">
                  {projectFolders.map(f => (
                    <FolderButton key={f.name} active={project === f.name} icon="folder" label={f.name}
                      count={f.count} colour="#38BDF8" onClick={() => setProject(p => (p === f.name ? '' : f.name))} />
                  ))}
                </div>
              </>
            )}
          </Card>
        </aside>

        {/* Main column */}
        <div className="min-w-0 flex-1 space-y-4">
          {/* Toolbar */}
          <Card glass className="flex flex-col gap-2.5 p-3">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
                  <Icon name="search" size={18} />
                </span>
                <Input value={searchInput} onChange={e => setSearchInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') setQ(searchInput.trim()); }}
                  placeholder="Search titles, tags, descriptions…" className="pl-8" />
              </div>
              <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/30 p-1">
                {(['grid', 'list'] as View[]).map(v => (
                  <button key={v} onClick={() => setView(v)} aria-label={`${v} view`}
                    className={`grid h-8 w-8 place-items-center rounded-lg transition-all
                      ${view === v ? 'bg-white/10 text-ink' : 'text-muted hover:text-ink'}`}>
                    <Icon name={v === 'grid' ? 'grid_view' : 'view_list'} size={18} />
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Select value={type} onChange={e => setType(e.target.value)} aria-label="Type">
                <option value="">Any type</option>
                {TYPE_ORDER.map(t => <option key={t} value={t}>{typeMeta(t).label}</option>)}
              </Select>
              <Select value={agentId} onChange={e => setAgentId(e.target.value)} aria-label="Agent">
                <option value="">Any agent</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.real_name || a.name}</option>)}
              </Select>
              <Select value={model} onChange={e => setModel(e.target.value)} aria-label="Model">
                <option value="">Any model</option>
                {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
              </Select>
              <Select value={project} onChange={e => setProject(e.target.value)} aria-label="Project">
                <option value="">Any project</option>
                {projectFolders.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </Select>
              <Select value={dateFilter} onChange={e => setDateFilter(e.target.value as DateFilter)} aria-label="Date">
                {DATE_OPTS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
              </Select>
              {anyFilter && (
                <Button variant="ghost" icon="close" onClick={clearAll} className="px-2 py-1 text-xs">Clear</Button>
              )}
              <span className="ml-auto shrink-0 text-xs text-muted">
                {displayed.length} shown
              </span>
            </div>
          </Card>

          {/* Results */}
          {loading ? (
            view === 'grid' ? <SkeletonGrid /> : <SkeletonList count={6} />
          ) : itemsError ? (
            <EmptyState icon="cloud_off" title="Couldn't load the gallery"
              hint="Something went wrong fetching your assets. Check your connection and try again."
              action={<Button variant="secondary" icon="refresh" loading={loading} onClick={refresh}>Retry</Button>} />
          ) : displayed.length === 0 ? (
            facets.length === 0 ? (
              <EmptyState icon="photo_library" accent="#C084FC" large
                title="No assets yet"
                hint="Everything your agents produce — images, docs, posts, code, video and designs — lands here. Add one to get started.">
                <Button variant="primary" icon="add" onClick={() => setAddOpen(true)}
                  style={{ background: '#C084FC', boxShadow: '0 0 24px rgba(192,132,252,0.35)' }}>
                  Add your first asset
                </Button>
              </EmptyState>
            ) : (
              <EmptyState icon="search_off" title="No matching assets"
                hint="Try a different folder, filter or search term."
                action={<Button variant="secondary" icon="close" onClick={clearAll}>Clear filters</Button>} />
            )
          ) : view === 'grid' ? (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
              {displayed.map((item, i) => (
                <GridCard key={item.id} item={item} index={i}
                  onOpen={() => setPreview(item)} onDelete={() => doDelete(item)} />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {displayed.map((item, i) => (
                <ListRow key={item.id} item={item} index={i}
                  onOpen={() => setPreview(item)} onDelete={() => doDelete(item)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Preview modal ────────────────────────────────────────────────── */}
      <Modal open={!!preview} onClose={() => setPreview(null)} width="max-w-2xl">
        {preview && <PreviewBody key={preview.id} item={preview} onClose={() => setPreview(null)} onDelete={doDelete} />}
      </Modal>

      {/* ── Add-to-workspace modal ───────────────────────────────────────── */}
      {addOpen && (
        <AddItemModal
          agents={agents}
          tenantId={selectedTenant}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); refresh(); }}
        />
      )}
    </div>
  );
}

// ── Stat with eased count-up ───────────────────────────────────────────────
function CountStat({ label, value, icon, accent, delay }:
  { label: string; value: number; icon: string; accent: string; delay: number }) {
  const n = useCountUp(value);
  return <Stat label={label} value={n.toLocaleString()} icon={icon} accent={accent} delay={delay} />;
}

// ── Thumbnail with graceful placeholder fallback ───────────────────────────
function Thumb({ item, iconSize = 40 }: { item: WorkspaceItem; iconSize?: number }) {
  const [broken, setBroken] = useState(false);
  const src = item.thumbnail || item.url;
  const m = typeMeta(item.type);
  if (!src || broken) {
    return (
      <div className="relative grid h-full w-full place-items-center overflow-hidden"
        style={{ background: `linear-gradient(150deg, ${m.colour}30, ${m.colour}0a 55%, #0D1520)` }}>
        <div className="pointer-events-none absolute inset-0"
          style={{ background: `radial-gradient(circle at 50% 38%, ${m.colour}2e, transparent 70%)` }} />
        <Icon name={m.icon} size={iconSize} style={{ color: m.colour }} className="relative opacity-90" />
      </div>
    );
  }
  return (
    <img src={src} alt={item.title} loading="lazy" onError={() => setBroken(true)}
      className="h-full w-full object-cover" />
  );
}

// ── Type chip (brand-coloured) ─────────────────────────────────────────────
function TypeChip({ type, className = '' }: { type: string; className?: string }) {
  const m = typeMeta(type);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold backdrop-blur ${className}`}
      style={{ color: m.colour, borderColor: `${m.colour}55`, background: `${m.colour}22` }}>
      <Icon name={m.icon} size={12} /> {m.label}
    </span>
  );
}

// ── Generic meta chip (model / project) ────────────────────────────────────
function MetaChip({ icon, text }: { icon: string; text: string }) {
  return (
    <span className="inline-flex max-w-[8.5rem] items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-muted">
      <Icon name={icon} size={11} className="shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}

// ── Delete affordance (shared) ─────────────────────────────────────────────
function DeleteBtn({ onDelete, className = '' }: { onDelete: () => void; className?: string }) {
  return (
    <button onClick={e => { e.stopPropagation(); onDelete(); }} aria-label="Delete asset"
      className={`grid place-items-center rounded-lg bg-black/50 text-white/80 backdrop-blur transition-all hover:bg-rose/80 hover:text-white ${className}`}>
      <Icon name="delete" size={16} />
    </button>
  );
}

// ── Grid card ──────────────────────────────────────────────────────────────
function GridCard({ item, index, onOpen, onDelete }:
  { item: WorkspaceItem; index: number; onOpen: () => void; onDelete: () => void }) {
  const tags = item.tags || [];
  return (
    <Card hover onClick={onOpen} style={{ animationDelay: `${index * 45}ms` }}
      className="group relative cursor-pointer overflow-hidden p-0 animate-fadeInUp">
      <div className="relative aspect-[4/3] overflow-hidden">
        <Thumb item={item} iconSize={44} />
        <div className="absolute left-2 top-2"><TypeChip type={item.type} /></div>
        <DeleteBtn onDelete={onDelete}
          className="absolute right-2 top-2 h-8 w-8 opacity-0 group-hover:opacity-100" />
      </div>
      <div className="p-3">
        <div className="truncate font-display text-sm font-semibold text-ink" title={item.title}>{item.title}</div>
        {(item.model || item.project) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {item.model && <MetaChip icon="model_training" text={item.model} />}
            {item.project && <MetaChip icon="folder" text={item.project} />}
          </div>
        )}
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Avatar size={20} colour={item.agent_colour} initials={item.agent_initials ?? undefined} ring={false} />
            <span className="truncate text-[11px] text-muted">{item.agent_name || 'System'}</span>
          </div>
          <span className="shrink-0 text-[11px] text-muted/70">{timeAgo(item.created_at)}</span>
        </div>
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.slice(0, 3).map(t => (
              <span key={t} className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted">#{t}</span>
            ))}
            {tags.length > 3 && <span className="text-[10px] text-muted/60">+{tags.length - 3}</span>}
          </div>
        )}
      </div>
    </Card>
  );
}

// ── List row ───────────────────────────────────────────────────────────────
function ListRow({ item, index, onOpen, onDelete }:
  { item: WorkspaceItem; index: number; onOpen: () => void; onDelete: () => void }) {
  return (
    <Card hover onClick={onOpen} style={{ animationDelay: `${index * 30}ms` }}
      className="group flex cursor-pointer items-center gap-3 p-2.5 animate-fadeInUp">
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg">
        <Thumb item={item} iconSize={20} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-sm font-semibold text-ink">{item.title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
          <TypeChip type={item.type} />
          {item.project && <span className="truncate">{item.project}</span>}
        </div>
      </div>
      {item.model && <div className="hidden md:block"><MetaChip icon="model_training" text={item.model} /></div>}
      <div className="hidden w-32 min-w-0 items-center gap-1.5 sm:flex">
        <Avatar size={18} colour={item.agent_colour} initials={item.agent_initials ?? undefined} ring={false} />
        <span className="truncate text-[11px] text-muted">{item.agent_name || 'System'}</span>
      </div>
      <span className="hidden w-16 shrink-0 text-right text-[11px] text-muted/70 lg:block">{timeAgo(item.created_at)}</span>
      <DeleteBtn onDelete={onDelete} className="h-8 w-8 shrink-0 opacity-0 group-hover:opacity-100" />
    </Card>
  );
}

// ── Folder button ──────────────────────────────────────────────────────────
function FolderButton({ active, icon, label, count, colour, onClick }:
  { active: boolean; icon: string; label: string; count: number; colour: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-all
        ${active ? 'bg-white/10 text-ink' : 'text-muted hover:bg-white/5 hover:text-ink'}`}>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
        style={{ background: `${colour}1f`, color: colour }}>
        <Icon name={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={`shrink-0 rounded-full px-1.5 text-[11px] ${active ? 'bg-white/15 text-ink' : 'bg-white/5 text-muted'}`}>{count}</span>
    </button>
  );
}

// ── Meta row (preview) ─────────────────────────────────────────────────────
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted/70">{label}</div>
      <div className="mt-0.5 truncate text-sm text-ink">{value}</div>
    </div>
  );
}

// ── Preview body ───────────────────────────────────────────────────────────
function PreviewBody({ item, onClose, onDelete }:
  { item: WorkspaceItem; onClose: () => void; onDelete: (item: WorkspaceItem) => void }) {
  const tags = item.tags || [];
  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-xl">
        <div className="aspect-video w-full"><Thumb item={item} iconSize={68} /></div>
        <div className="absolute left-2.5 top-2.5"><TypeChip type={item.type} /></div>
        <button onClick={onClose} aria-label="Close"
          className="absolute right-2.5 top-2.5 grid h-8 w-8 place-items-center rounded-lg bg-black/50 text-white/80 backdrop-blur transition-colors hover:text-white">
          <Icon name="close" size={18} />
        </button>
      </div>

      <div>
        <h3 className="font-display text-lg font-bold leading-tight text-ink">{item.title}</h3>
        {item.description && <p className="mt-1.5 text-sm text-muted">{item.description}</p>}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetaRow label="Type" value={typeMeta(item.type).label} />
        <MetaRow label="Model" value={item.model || '—'} />
        <MetaRow label="Project" value={item.project || '—'} />
        <MetaRow label="Created" value={timeAgo(item.created_at)} />
      </div>

      <div className="flex items-center gap-2.5">
        <Avatar size={34} colour={item.agent_colour} initials={item.agent_initials ?? undefined} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">{item.agent_name || 'System'}</div>
          <div className="text-[11px] text-muted">Creator</div>
        </div>
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map(t => <Badge key={t} tone="violet">#{t}</Badge>)}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-white/10 pt-4">
        <Button variant="danger" icon="delete" onClick={() => onDelete(item)}>Delete</Button>
        {item.url && (
          <Button variant="primary" icon="open_in_new"
            style={{ background: '#C084FC', boxShadow: '0 0 20px rgba(192,132,252,0.3)' }}
            onClick={() => window.open(item.url, '_blank', 'noopener')}>
            Open
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Add-to-workspace composer ──────────────────────────────────────────────
function AddItemModal({ agents, tenantId, onClose, onSaved }:
  { agents: Agent[]; tenantId: number | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [type, setType] = useState('image');
  const [project, setProject] = useState('');
  const [model, setModel] = useState('');
  const [tags, setTags] = useState('');
  const [url, setUrl] = useState('');
  const [agentId, setAgentId] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) { toast('A title is required', 'warn'); return; }
    setSaving(true);
    try {
      await api.saveWorkspaceItem({
        type,
        title: title.trim(),
        description: description.trim() || undefined,
        url: url.trim() || undefined,
        thumbnail: url.trim() || undefined,
        model: model.trim() || undefined,
        project: project.trim() || undefined,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        agent_id: agentId ? Number(agentId) : undefined,
        tenant_id: tenantId ?? undefined,
      });
      toast('Asset added to workspace', 'ok');
      onSaved();
    } catch {
      toast('Could not save the asset', 'danger');
      setSaving(false);
    }
  };

  const fieldCls = 'mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted';
  const textareaCls =
    'w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm text-ink placeholder:text-muted/60 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 resize-none';

  return (
    <Modal open onClose={onClose} title="Add to workspace" width="max-w-lg">
      <div className="space-y-3">
        <div>
          <label className={fieldCls}>Title</label>
          <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Launch hero banner" autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={fieldCls}>Type</label>
            <Select value={type} onChange={e => setType(e.target.value)} className="w-full">
              {TYPE_ORDER.map(t => <option key={t} value={t}>{typeMeta(t).label}</option>)}
            </Select>
          </div>
          <div>
            <label className={fieldCls}>Project</label>
            <Input value={project} onChange={e => setProject(e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={fieldCls}>Model</label>
            <Input value={model} onChange={e => setModel(e.target.value)} placeholder="Optional" />
          </div>
          <div>
            <label className={fieldCls}>Agent</label>
            <Select value={agentId} onChange={e => setAgentId(e.target.value)} className="w-full">
              <option value="">Unassigned</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.real_name || a.name}</option>)}
            </Select>
          </div>
        </div>
        <div>
          <label className={fieldCls}>URL</label>
          <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://… (used as the thumbnail)" />
        </div>
        <div>
          <label className={fieldCls}>Tags</label>
          <Input value={tags} onChange={e => setTags(e.target.value)} placeholder="comma, separated, tags" />
        </div>
        <div>
          <label className={fieldCls}>Description</label>
          <textarea value={description} rows={2} onChange={e => setDescription(e.target.value)}
            placeholder="Optional notes about this asset…" className={textareaCls} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="add" loading={saving} onClick={save}
            style={{ background: '#C084FC', boxShadow: '0 0 20px rgba(192,132,252,0.3)' }}>
            Add asset
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Loading skeleton grid ──────────────────────────────────────────────────
function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-white/6 bg-white/[0.03]">
          <div className="aspect-[4/3] animate-pulse bg-white/5" style={{ animationDelay: `${i * 60}ms` }} />
          <div className="space-y-2 p-3">
            <div className="h-3 w-2/3 animate-pulse rounded bg-white/5" />
            <div className="h-2 w-1/2 animate-pulse rounded bg-white/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
