// Max Gleam stock control (/inventory).
//
// One table, sorted so anything that needs buying floats to the top. A line
// at or below its minimum is drawn in rose — that is the whole point of the
// page, so nothing else on it is allowed to be red.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Icon, Button, Card, Badge, Input, Select, Modal, EmptyState, SkeletonList,
  Stat, useToast,
} from '../components/ui';
import { api, timeAgo } from '../lib/api';
import type { InventoryItem, InventoryResponse } from '../lib/types';

type Filter = 'all' | 'low' | 'ok';

const CATEGORY_ICON: Record<string, string> = {
  chemicals: 'science',
  consumables: 'inventory_2',
  equipment: 'build',
  ppe: 'health_and_safety',
  spares: 'settings',
  other: 'category',
};

export default function Inventory() {
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [ordering, setOrdering] = useState<InventoryItem | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setError(false);
    try {
      setData(await api.inventory());
    } catch (err) {
      setError(true);
      toast(err instanceof Error ? err.message : 'Could not load stock', 'danger');
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const items = useMemo(() => {
    const list = (data?.items || []).filter(i => {
      if (filter === 'low' && !i.low) return false;
      if (filter === 'ok' && i.low) return false;
      if (category && i.category !== category) return false;
      if (search && !i.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    // Anything needing attention first; the rest alphabetically.
    return [...list].sort((a, b) =>
      Number(b.out) - Number(a.out) || Number(b.low) - Number(a.low)
      || a.name.localeCompare(b.name));
  }, [data, filter, category, search]);

  const summary = data?.summary;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Stock</h1>
          <p className="mt-1 text-sm text-muted">
            Consumables and spares on the Max Gleam vans.
          </p>
        </div>
        <Button icon="add" onClick={() => setAdding(true)}>Add item</Button>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Lines tracked" value={summary?.total ?? 0} icon="inventory_2" delay={0} />
        <Stat label="Below minimum" value={summary?.low ?? 0} icon="warning"
          accent="#F59E0B" delay={60} />
        <Stat label="Out of stock" value={summary?.out ?? 0} icon="error"
          accent="#F43F5E" delay={120} />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg bg-raised p-1">
            {(['all', 'low', 'ok'] as Filter[]).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold capitalize transition-colors
                  ${filter === f ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}>
                {f === 'ok' ? 'In stock' : f === 'low' ? 'Needs ordering' : 'All'}
              </button>
            ))}
          </div>
          <Select value={category} onChange={e => setCategory(e.target.value)}
            className="w-auto min-w-[9rem]">
            <option value="">All categories</option>
            {(data?.categories || []).map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
          <Input placeholder="Search items…" value={search}
            onChange={e => setSearch(e.target.value)} className="max-w-xs flex-1" />
        </div>
      </Card>

      {loading ? <SkeletonList count={6} />
        : error ? (
          <EmptyState icon="cloud_off" title="Couldn't load stock"
            hint="Something went wrong reaching the server."
            action={<Button icon="refresh" onClick={load}>Retry</Button>} />
        ) : !items.length ? (
          <EmptyState icon="inventory_2" title="Nothing here"
            hint={data?.items.length
              ? 'No items match those filters.'
              : 'Add your first stock line to start tracking usage.'} />
        ) : (
          <div className="space-y-2">
            {items.map((item, i) => (
              <ItemRow key={item.id} item={item} delay={i * 40}
                expanded={expanded === item.id}
                onToggle={() => setExpanded(expanded === item.id ? null : item.id)}
                onOrder={() => setOrdering(item)} />
            ))}
          </div>
        )}

      <AddModal open={adding} onClose={() => setAdding(false)}
        categories={data?.categories || []}
        onAdded={() => { setAdding(false); load(); }} />
      <OrderModal item={ordering} onClose={() => setOrdering(null)}
        onOrdered={() => { setOrdering(null); load(); }} />
    </div>
  );
}

// ── One stock line ──────────────────────────────────────────────────────

function ItemRow({ item, delay, expanded, onToggle, onOrder }: {
  item: InventoryItem; delay: number; expanded: boolean;
  onToggle: () => void; onOrder: () => void;
}) {
  return (
    <Card className={`animate-fadeInUp overflow-hidden transition-colors
      ${item.low ? 'border-rose/30 bg-rose/[0.04]' : ''}`}
      style={{ animationDelay: `${delay}ms` }}>
      <div className="flex flex-wrap items-center gap-4 p-4">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl
          ${item.low ? 'bg-rose/15 text-rose' : 'bg-raised text-muted'}`}>
          <Icon name={CATEGORY_ICON[item.category] || 'category'} size={20} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{item.name}</span>
            <Badge tone="neutral">{item.category}</Badge>
            {item.out ? <Badge tone="danger" dot>Out of stock</Badge>
              : item.low ? <Badge tone="warn" dot>Below minimum</Badge> : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
            <span>Min {item.min_quantity} {item.unit}</span>
            {item.supplier && <span>{item.supplier}</span>}
            <span>Used {item.used_30d} in 30d</span>
            <span>
              {item.last_ordered_at
                ? `Ordered ${timeAgo(item.last_ordered_at)}`
                : 'Never ordered'}
            </span>
          </div>
        </div>

        <div className="text-right">
          <div className={`font-display text-2xl font-bold leading-none
            ${item.low ? 'text-rose' : 'text-ink'}`}>
            {item.quantity}
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-wider text-muted">
            {item.unit}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button variant={item.low ? 'primary' : 'secondary'} icon="local_shipping"
            onClick={onOrder}>
            Order
          </Button>
          <Button variant="ghost" icon={expanded ? 'expand_less' : 'expand_more'}
            onClick={onToggle} aria-label="Usage history" />
        </div>
      </div>

      {expanded && (
        <div className="border-t border-white/5 bg-bg/40 p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
            Usage history
          </div>
          {item.recent_usage.length ? (
            <div className="space-y-1.5">
              {item.recent_usage.map(u => (
                <div key={u.id}
                  className="flex flex-wrap items-baseline gap-x-3 text-sm text-muted">
                  <span className="font-mono font-semibold text-accent">
                    −{u.quantity_used}
                  </span>
                  <span className="text-ink">{u.address || 'No job linked'}</span>
                  {u.crew_name && <span>· {u.crew_name}</span>}
                  <span className="ml-auto text-xs">{timeAgo(u.used_at)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">
              Nothing logged against this item yet. The crew app records usage
              as jobs are completed.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Add ─────────────────────────────────────────────────────────────────

function AddModal({ open, onClose, categories, onAdded }: {
  open: boolean; onClose: () => void; categories: string[]; onAdded: () => void;
}) {
  const [form, setForm] = useState({
    name: '', category: 'consumables', quantity: '0', unit: 'unit',
    min_quantity: '0', supplier: '', notes: '',
  });
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.inventoryAdd({
        name: form.name, category: form.category, unit: form.unit,
        quantity: Number(form.quantity) || 0,
        min_quantity: Number(form.min_quantity) || 0,
        supplier: form.supplier || undefined, notes: form.notes || undefined,
      });
      toast(`${form.name} added`, 'ok');
      setForm({ name: '', category: 'consumables', quantity: '0', unit: 'unit',
        min_quantity: '0', supplier: '', notes: '' });
      onAdded();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the item', 'danger');
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add stock item">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input required autoFocus value={form.name} onChange={set('name')}
            placeholder="Squeegee rubbers 14in" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <Select value={form.category} onChange={set('category')}>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Unit">
            <Input value={form.unit} onChange={set('unit')} placeholder="bottle" />
          </Field>
          <Field label="Quantity in stock">
            <Input type="number" min={0} value={form.quantity} onChange={set('quantity')} />
          </Field>
          <Field label="Reorder at">
            <Input type="number" min={0} value={form.min_quantity}
              onChange={set('min_quantity')} />
          </Field>
        </div>
        <Field label="Supplier">
          <Input value={form.supplier} onChange={set('supplier')}
            placeholder="Optional" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!form.name.trim()}>
            Add item
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Order ───────────────────────────────────────────────────────────────

function OrderModal({ item, onClose, onOrdered }: {
  item: InventoryItem | null; onClose: () => void; onOrdered: () => void;
}) {
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // Default the order to whatever brings the line back above its minimum.
  useEffect(() => {
    if (item) {
      const gap = item.min_quantity * 2 - item.quantity;
      setQuantity(String(gap > 0 ? gap : item.min_quantity || 1));
    }
  }, [item]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!item) return;
    setBusy(true);
    try {
      const r = await api.inventoryOrder(item.id, Number(quantity) || 0);
      toast(r.received
        ? `${item.name} — ${r.received} ${item.unit} booked in`
        : `${item.name} marked as ordered`, 'ok');
      onOrdered();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not log the order', 'danger');
    } finally { setBusy(false); }
  }

  return (
    <Modal open={!!item} onClose={onClose} title={item ? `Order ${item.name}` : 'Order'}>
      {item && (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-muted">
            {item.quantity} {item.unit} in stock, reorder point {item.min_quantity}.
          </p>
          <Field label={`Quantity received (${item.unit})`}>
            <Input type="number" min={0} autoFocus value={quantity}
              onChange={e => setQuantity(e.target.value)} />
          </Field>
          <p className="text-xs text-muted">
            Leave at 0 to just stamp the line as ordered without booking stock in.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={busy} icon="local_shipping">Log order</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
