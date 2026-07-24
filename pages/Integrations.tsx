// Integrations — bridge / connection management. Connect external platforms so
// their agents and capabilities appear inside AGENT OS.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Card, Button, Badge, Toggle, Input, Modal, EmptyState, SkeletonList, useToast, Icon,
} from '../components/ui';
import { api, timeAgo } from '../lib/api';
import type { BridgesResponse, Connection } from '../lib/types';

// ── Per-platform presentation (icon + accent colour) ─────────────────────
export type PlatformStyle = { icon: string; accent: string };
export const PLATFORM_STYLE: Record<string, PlatformStyle> = {
  hermes:     { icon: 'hub',           accent: '#38BDF8' }, // sky
  chatgpt:    { icon: 'forum',         accent: '#22C55E' }, // emerald
  fal:        { icon: 'image',         accent: '#F59E0B' }, // amber
  claude_sdk: { icon: 'auto_awesome',  accent: '#A78BFA' }, // violet
  kimi:       { icon: 'rocket_launch', accent: '#19C3E6' }, // accent
  omi:        { icon: 'graphic_eq',    accent: '#F472B6' }, // pink — wearable
  gemini:     { icon: 'smart_toy',     accent: '#4285F4' }, // google blue
};
export const styleFor = (platform: string): PlatformStyle =>
  PLATFORM_STYLE[platform] || { icon: 'extension', accent: '#7B8DA8' };

// Platforms that need an API key (hermes + omi need nothing).
const NEEDS_KEY: Record<string, boolean> = {
  hermes: false, chatgpt: true, fal: true, claude_sdk: true, kimi: true, omi: false, gemini: true,
};

// Platform-specific model presets for the dropdown
const PLATFORM_MODELS: Record<string, { label: string; value: string }[]> = {
  gemini: [
    { label: 'Gemini 2.0 Flash (fast, default)', value: 'gemini-2.0-flash' },
    { label: 'Gemini 2.5 Pro (deep reasoning)', value: 'gemini-2.5-pro' },
    { label: 'Gemini 2.0 Flash Lite (cheapest)', value: 'gemini-2.0-flash-lite' },
  ],
  chatgpt: [
    { label: 'GPT-4o (balanced)', value: 'gpt-4o' },
    { label: 'GPT-4o Mini (fast, cheap)', value: 'gpt-4o-mini' },
    { label: 'GPT-4.1 (reasoning)', value: 'gpt-4.1' },
    { label: 'GPT-4.1 Mini', value: 'gpt-4.1-mini' },
    { label: 'GPT-4.1 Nano (cheapest)', value: 'gpt-4.1-nano' },
    { label: 'o3 (heavy reasoning)', value: 'o3' },
    { label: 'o4 Mini (reasoning)', value: 'o4-mini' },
  ],
  claude_sdk: [
    { label: 'Claude Sonnet 4 (balanced)', value: 'claude-sonnet-4' },
    { label: 'Claude Opus 4 (max quality)', value: 'claude-opus-4' },
    { label: 'Claude Haiku 3.5 (fast)', value: 'claude-3-5-haiku' },
  ],
  fal: [
    { label: 'FLUX.1 Dev (quality)', value: 'fal-ai/flux/dev' },
    { label: 'FLUX.1 Schnell (fast)', value: 'fal-ai/flux/schnell' },
    { label: 'FLUX Pro 1.1', value: 'fal-ai/flux-pro/v1.1' },
    { label: 'FLUX Realism', value: 'fal-ai/flux-realism' },
  ],
  kimi: [
    { label: 'Kimi k2.6 (default)', value: 'kimi-k2.6' },
  ],
};

// last_status → Badge tone
type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'violet';
const statusTone = (s: string): BadgeTone =>
  s === 'connected' ? 'ok' : s === 'error' ? 'danger' : 'neutral';

// Icon tile shared by connected + available cards.
function PlatformTile({ platform, size = 44 }: { platform: string; size?: number }) {
  const st = styleFor(platform);
  return (
    <div className="grid shrink-0 place-items-center rounded-xl"
      style={{ width: size, height: size, background: `${st.accent}1a`, color: st.accent }}>
      <Icon name={st.icon} size={Math.round(size * 0.5)} />
    </div>
  );
}

export default function Integrations() {
  const toast = useToast();
  const [data, setData] = useState<BridgesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<Record<number, boolean>>({}); // per-connection action lock

  // Add-connection modal state
  const [addPlatform, setAddPlatform] = useState<string | null>(null);
  const [form, setForm] = useState<{ label: string; api_key: string; model: string }>(
    { label: '', api_key: '', model: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setError(false);
    try {
      const res = await api.bridges();
      setData(res);
    } catch {
      toast('Failed to load integrations', 'danger');
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const connections = data?.connections || [];
  const available = data?.available || [];

  const setLock = (id: number, v: boolean) =>
    setBusy(b => ({ ...b, [id]: v }));

  // ── Actions ────────────────────────────────────────────────────────────
  const toggleEnabled = async (c: Connection) => {
    setLock(c.id, true);
    try {
      await api.updateBridge(c.id, { enabled: !c.enabled });
      await load();
    } catch {
      toast(`Could not update ${c.label}`, 'danger');
    } finally {
      setLock(c.id, false);
    }
  };

  const testConnection = async (c: Connection) => {
    setLock(c.id, true);
    try {
      const res = await api.testBridge(c.id);
      const r = res.result || {};
      const tone: BadgeTone = r.status === 'connected' ? 'ok'
        : r.status === 'error' ? 'danger' : 'warn';
      toast(`${c.label}: ${r.status || 'unknown'}${r.detail ? ` — ${r.detail}` : ''}`, tone);
      await load();
    } catch {
      toast(`Test failed for ${c.label}`, 'danger');
    } finally {
      setLock(c.id, false);
    }
  };

  const removeConnection = async (c: Connection) => {
    if (!window.confirm(`Remove ${c.label}? Its agents and capabilities will disappear from AGENT OS.`)) return;
    setLock(c.id, true);
    try {
      await api.deleteBridge(c.id);
      toast(`Removed ${c.label}`, 'ok');
      await load();
    } catch {
      toast(`Could not remove ${c.label}`, 'danger');
    } finally {
      setLock(c.id, false);
    }
  };

  const openAdd = (platform: string, defaultLabel: string) => {
    setForm({ label: defaultLabel, api_key: '', model: '' });
    setAddPlatform(platform);
  };

  const submitAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!addPlatform) return;
    const config: Record<string, string> = {};
    if (form.api_key.trim()) config.api_key = form.api_key.trim();
    if (form.model.trim()) config.model = form.model.trim();
    setSaving(true);
    try {
      await api.addBridge({
        platform: addPlatform,
        label: form.label.trim() || undefined,
        config,
      });
      toast(`Connected ${form.label.trim() || addPlatform}`, 'ok');
      setAddPlatform(null);
      await load();
    } catch {
      toast('Could not add connection', 'danger');
    } finally {
      setSaving(false);
    }
  };

  const addMeta = useMemo(
    () => available.find(a => a.platform === addPlatform)?.meta,
    [available, addPlatform]);

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header ─────────────────────────────────────────────────────────── */}
      <div className="animate-fadeInUp">
        <h1 className="font-display text-2xl font-bold text-ink">Integrations</h1>
        <p className="mt-1 text-sm text-muted">
          Connect external platforms — their agents and capabilities appear inside AGENT OS.
        </p>
      </div>

      {loading ? (
        <SkeletonList count={4} />
      ) : error ? (
        <EmptyState icon="cloud_off"
          title="Couldn't load integrations"
          hint="Something went wrong reaching the server."
          action={<Button icon="refresh" onClick={load}>Retry</Button>} />
      ) : (
        <>
          {/* Connected ─────────────────────────────────────────────────── */}
          <section className="space-y-3">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
              Connected
            </h2>
            {connections.length === 0 ? (
              <div className="animate-fadeInUp">
                <EmptyState icon="power" accent="#22C55E" large
                  title="Connect your first platform"
                  hint="Bring an external tool into AGENT OS as a live integration — its agents and capabilities appear instantly.">
                  <div className="mt-4 flex flex-wrap justify-center gap-3">
                    {['hub', 'forum', 'image', 'auto_awesome', 'rocket_launch', 'graphic_eq'].map((ico, i) => {
                      const colours = ['#38BDF8', '#22C55E', '#F59E0B', '#A78BFA', '#19C3E6', '#F472B6'];
                      return (
                        <span key={ico}
                          className="grid h-10 w-10 place-items-center rounded-xl text-lg"
                          style={{ background: `${colours[i]}1a`, color: colours[i] }}>
                          <Icon name={ico} size={22} />
                        </span>
                      );
                    })}
                  </div>
                </EmptyState>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {connections.map((c, i) => {
                  const locked = !!busy[c.id];
                  return (
                    <Card key={c.id} className="flex flex-col p-4 animate-fadeInUp"
                      style={{ animationDelay: `${i * 60}ms` }}>
                      <div className="flex items-start gap-3">
                        <PlatformTile platform={c.platform} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-display font-semibold text-ink">
                            {c.label || c.meta.label}
                          </div>
                          <div className="truncate text-xs text-muted">{c.meta.label}</div>
                        </div>
                        <Badge tone={statusTone(c.last_status)} dot>
                          {c.last_status || 'unknown'}
                        </Badge>
                      </div>

                      <p className="mt-3 text-sm text-muted">{c.meta.blurb}</p>

                      <div className="mt-3 flex items-center gap-1 text-[11px] text-muted/70">
                        <Icon name="schedule" size={14} />
                        Last sync {timeAgo(c.last_sync_at)}
                      </div>

                      <div className="mt-3 flex items-center justify-between border-t border-white/10 pt-3">
                        <div className="flex items-center gap-2 text-xs text-muted">
                          <Toggle checked={c.enabled} disabled={locked}
                            onChange={() => toggleEnabled(c)} />
                          {c.enabled ? 'Enabled' : 'Disabled'}
                        </div>
                        <div className="flex gap-1.5">
                          <Button variant="ghost" icon="bolt" loading={locked}
                            onClick={() => testConnection(c)}>Test</Button>
                          <Button variant="danger" icon="delete" disabled={locked}
                            onClick={() => removeConnection(c)}>Remove</Button>
                        </div>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {/* Available ─────────────────────────────────────────────────── */}
          {available.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
                Available platforms
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {available.map((a, i) => (
                  <Card key={a.platform} hover className="flex flex-col p-4 animate-fadeInUp"
                    style={{ animationDelay: `${i * 60}ms` }}>
                    <div className="flex items-center gap-3">
                      <PlatformTile platform={a.platform} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-display font-semibold text-ink">{a.meta.label}</div>
                        <div className="truncate text-xs text-muted">{a.meta.kind}</div>
                      </div>
                    </div>
                    <p className="mt-3 flex-1 text-sm text-muted">{a.meta.blurb}</p>
                    <div className="mt-3">
                      <Button variant="primary" icon="add" className="w-full"
                        onClick={() => openAdd(a.platform, a.meta.label)}>Add</Button>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* Add-connection modal ─────────────────────────────────────────────── */}
      <Modal open={addPlatform !== null} onClose={() => setAddPlatform(null)}
        title={addMeta ? `Connect ${addMeta.label}` : 'Connect platform'}>
        {addPlatform && (
          <form onSubmit={submitAdd} className="space-y-4">
            <div className="flex items-center gap-3">
              <PlatformTile platform={addPlatform} size={40} />
              <p className="text-sm text-muted">{addMeta?.blurb}</p>
            </div>

            <label className="block space-y-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">Label</span>
              <Input value={form.label} placeholder={addMeta?.label || 'Connection name'}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
            </label>

            {NEEDS_KEY[addPlatform] ? (
              <>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">API key</span>
                  <Input type="password" value={form.api_key} placeholder="sk-…" autoComplete="off"
                    onChange={e => setForm(f => ({ ...f, api_key: e.target.value }))} />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Model <span className="font-normal text-muted/60">(optional)</span>
                  </span>
                  {PLATFORM_MODELS[addPlatform] ? (
                    <select value={form.model || PLATFORM_MODELS[addPlatform][0].value}
                      onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                      className="block w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-ink outline-none transition focus:border-accent focus:ring-1 focus:ring-accent [&>option]:bg-[#0B1826]">
                      <option value="">Auto (platform default)</option>
                      {PLATFORM_MODELS[addPlatform].map(m => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </select>
                  ) : (
                    <Input value={form.model} placeholder="default"
                      onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
                  )}
                </label>
              </>
            ) : (
              <p className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-muted">
                No API key required — {addMeta?.label || 'this platform'} connects to your local
                session history and vault automatically.
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setAddPlatform(null)}>Cancel</Button>
              <Button type="submit" variant="primary" icon="link" loading={saving}>Connect</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
