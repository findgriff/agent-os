// AGENT OS — global settings page.
import React, { useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { api } from '../lib/api';
import {
  Button, Card, EmptyState, Icon, Input, Textarea, useToast,
} from '../components/ui';
import type { Memory } from '../lib/types';

const ACCENTS: Array<{ name: string; hex: string }> = [
  { name: 'Teal', hex: '#19C3E6' },
  { name: 'Sky', hex: '#38BDF8' },
  { name: 'Violet', hex: '#A78BFA' },
  { name: 'Amber', hex: '#F59E0B' },
  { name: 'Emerald', hex: '#22C55E' },
];
const ACCENT_KEY = 'agentos_accent';

function SectionHead({ title, desc, icon }:
  { title: string; desc: string; icon: string }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent">
        <Icon name={icon} size={20} />
      </div>
      <div className="min-w-0">
        <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
        <p className="text-sm text-muted">{desc}</p>
      </div>
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-black/20 px-3 py-2">
      <span className="text-sm text-muted">{label}</span>
      <span className="truncate text-sm font-medium text-ink">{value}</span>
    </div>
  );
}

export default function Settings() {
  const { user, tenants, logout } = useApp();
  const toast = useToast();

  // ── Change password ────────────────────────────────────────────────────
  const [pw, setPw] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  const changePassword = async () => {
    if (pw.length < 8) { toast('Password must be at least 8 characters', 'warn'); return; }
    if (pw !== pwConfirm) { toast('Passwords do not match', 'warn'); return; }
    setSavingPw(true);
    try {
      await api.setPassword(pw);
      setPw(''); setPwConfirm('');
      toast('Password updated', 'ok');
    } catch (e) {
      toast('Could not update password', 'danger');
    } finally {
      setSavingPw(false);
    }
  };

  // ── Vault & memory ─────────────────────────────────────────────────────
  const [syncing, setSyncing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importText, setImportText] = useState('');
  const importFieldId = React.useId();

  const syncVault = async () => {
    setSyncing(true);
    try {
      const res = await api.vaultSync();
      toast(`Synced ${res.synced} memories`, 'ok');
    } catch (e) {
      toast('Vault sync failed', 'danger');
    } finally {
      setSyncing(false);
    }
  };

  const exportMemories = async () => {
    setExporting(true);
    try {
      const res = await api.vaultMemories();
      const blob = new Blob([JSON.stringify(res.memories, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'agent-os-memories.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast(`Exported ${res.memories.length} memories`, 'ok');
    } catch (e) {
      toast('Export failed', 'danger');
    } finally {
      setExporting(false);
    }
  };

  const importMemories = () => {
    try {
      const parsed = JSON.parse(importText);
      const list: Array<Partial<Memory>> = Array.isArray(parsed) ? parsed : [parsed];
      const valid = list.filter(m => m && typeof m.topic === 'string' && typeof m.fact === 'string');
      toast(`Paste parsed: ${valid.length} memories (import via agent drawer)`, 'info');
    } catch (e) {
      toast('Could not parse JSON', 'danger');
    }
  };

  // ── Theme accent ───────────────────────────────────────────────────────
  const [accent, setAccent] = useState<string>(ACCENTS[0].hex);
  useEffect(() => {
    const saved = localStorage.getItem(ACCENT_KEY);
    if (saved) {
      setAccent(saved);
      document.documentElement.style.setProperty('--accent', saved);
    }
  }, []);
  const pickAccent = (hex: string) => {
    setAccent(hex);
    document.documentElement.style.setProperty('--accent', hex);
    localStorage.setItem(ACCENT_KEY, hex);
    toast('Accent updated', 'ok');
  };

  return (
    <div className="p-4 md:p-6 max-w-3xl space-y-6">
      <header className="animate-fadeInUp">
        <h1 className="font-display text-2xl font-bold text-ink">Settings</h1>
        <p className="text-sm text-muted">Manage your profile, projects, memory and appearance.</p>
      </header>

      {/* 1. Profile */}
      <Card className="p-5 animate-fadeInUp" style={{ animationDelay: '40ms' }}>
        <SectionHead icon="person" title="Profile"
          desc="Your account details and password." />
        <div className="space-y-2">
          <KeyValue label="Name" value={user?.name ?? '—'} />
          <KeyValue label="Email" value={user?.email ?? '—'} />
          <KeyValue label="Role" value={user?.role ?? '—'} />
        </div>
        <div className="mt-5 border-t border-white/10 pt-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">Change password</h3>
          <div className="space-y-3">
            <Input type="password" placeholder="New password (min 8 chars)"
              value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" />
            <Input type="password" placeholder="Confirm new password"
              value={pwConfirm} onChange={e => setPwConfirm(e.target.value)} autoComplete="new-password" />
            <Button variant="primary" icon="lock_reset" loading={savingPw}
              onClick={changePassword}
              disabled={!pw || !pwConfirm}>Change password</Button>
          </div>
        </div>
      </Card>

      {/* 2. Projects */}
      <Card className="p-5 animate-fadeInUp" style={{ animationDelay: '80ms' }}>
        <SectionHead icon="folder_managed" title="Projects"
          desc="Overview of the projects you have access to." />
        <div className="space-y-2">
          {tenants.length === 0 ? (
            <EmptyState icon="folder_managed" accent="#7B8DA8" title="No projects yet"
              hint="Projects you're granted access to will appear here." />
          ) : tenants.map(t => (
            <div key={t.id}
              className="flex items-center justify-between gap-3 rounded-xl bg-black/20 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="h-3 w-3 shrink-0 rounded-full"
                  style={{ background: t.brand_colour }} />
                <span className="truncate text-sm font-medium text-ink">{t.name}</span>
              </div>
              <span className="shrink-0 text-xs text-muted">
                {t.agent_count} agent{t.agent_count === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* 3. Vault & Memory */}
      <Card className="p-5 animate-fadeInUp" style={{ animationDelay: '120ms' }}>
        <SectionHead icon="database" title="Vault & Memory"
          desc="Sync the collective vault, export or paste memories." />
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon="sync" loading={syncing} onClick={syncVault}>
              Sync vault now
            </Button>
            <Button variant="secondary" icon="download" loading={exporting} onClick={exportMemories}>
              Export memories
            </Button>
          </div>
          <div>
            <label htmlFor={importFieldId} className="mb-1.5 block text-sm font-medium text-ink">Import memories</label>
            <p className="mb-2 text-xs text-muted">
              Paste memory JSON to preview. Import is advisory — add memories individually via the agent drawer.
            </p>
            <Textarea id={importFieldId} rows={4} placeholder='[{"topic":"...","fact":"..."}]'
              value={importText} onChange={e => setImportText(e.target.value)} />
            <div className="mt-2">
              <Button variant="ghost" icon="upload" onClick={importMemories}
                disabled={!importText.trim()}>Parse & preview</Button>
            </div>
          </div>
        </div>
      </Card>

      {/* 4. Theme */}
      <Card className="p-5 animate-fadeInUp" style={{ animationDelay: '160ms' }}>
        <SectionHead icon="palette" title="Theme"
          desc="Choose the accent colour used across glows and highlights." />
        <div className="flex flex-wrap gap-3">
          {ACCENTS.map(a => {
            const active = a.hex.toLowerCase() === accent.toLowerCase();
            return (
              <button key={a.hex} type="button" onClick={() => pickAccent(a.hex)}
                title={a.name}
                className={`grid h-11 w-11 place-items-center rounded-full transition-all active:scale-95
                  ${active ? 'ring-2 ring-offset-2 ring-offset-surface' : 'ring-0 hover:scale-105'}`}
                style={{ background: a.hex, boxShadow: active ? `0 0 16px ${a.hex}66` : undefined,
                  ...(active ? { ['--tw-ring-color' as any]: a.hex } : {}) }}>
                {active && <Icon name="check" size={20} className="text-black/70" />}
              </button>
            );
          })}
        </div>
      </Card>

      {/* 5. Session */}
      <Card className="p-5 animate-fadeInUp" style={{ animationDelay: '200ms' }}>
        <SectionHead icon="logout" title="Session"
          desc="Sign out of AGENT OS on this device." />
        <Button variant="danger" icon="logout" onClick={() => logout()}>Sign out</Button>
      </Card>
    </div>
  );
}
