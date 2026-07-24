import { useState, useEffect } from 'react';
import { Button, Card, EmptyState, Icon, useToast, Badge } from '../components/ui';
import { api } from '../lib/api';

interface Headline {
  title: string;
  url: string;
  source: string;
  summary: string;
}

interface Idea {
  headline: string;
  angle: string;
  suggested_title: string;
}

interface Scan {
  id: number;
  keywords: string[];
  headline_count: number;
  created_at: number;
}

interface OracleSource {
  id: number;
  name: string;
  url_template: string;
  response_path: string;
  title_field: string;
  url_field: string;
}

export default function Oracle() {
  const toast = useToast();
  const [keywords, setKeywords] = useState('');
  const [scanning, setScanning] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const [headlines, setHeadlines] = useState<Headline[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [history, setHistory] = useState<Scan[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [sources, setSources] = useState<OracleSource[]>([]);
  const [showSources, setShowSources] = useState(false);
  const [srcName, setSrcName] = useState('');
  const [srcUrl, setSrcUrl] = useState('');
  const [srcPath, setSrcPath] = useState('hits');
  const [srcTitle, setSrcTitle] = useState('title');
  const [srcUrlField, setSrcUrlField] = useState('url');

  // Open an article URL in a new tab. window.open is tried first; if a popup
  // blocker swallows it (returns null), fall back to clicking a synthetic
  // <a target="_blank"> element, which browsers treat as a user navigation.
  const openUrl = (url?: string) => {
    if (!url) return;
    const win = window.open(url, '_blank');
    if (win) {
      win.opener = null; // sever opener reference to prevent reverse tabnabbing
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const scan = async () => {
    if (!keywords.trim()) { toast('Enter keywords first', 'warn'); return; }
    setScanning(true);
    try {
      const res = await api.oracleScan(keywords.split(',').map(k => k.trim()));
      setHeadlines(res.headlines || []);
      setIdeas(res.ideas || []);
      toast(`Found ${(res.headlines || []).length} headlines`, 'ok');
      loadHistory();
    } catch { toast('Scan failed', 'danger'); }
    finally { setScanning(false); }
  };

  const loadHistory = async () => {
    try { const res = await api.oracleHistory(); setHistory(res.scans || []); } catch {}
  };

  const loadSources = async () => {
    try { const res = await api.oracleSources(); setSources(res.sources || []); } catch {}
  };

  const addSource = async () => {
    if (!srcName.trim() || !srcUrl.trim()) { toast('Name and URL are required', 'warn'); return; }
    setAddingSource(true);
    try {
      await api.addOracleSource({ name: srcName.trim(), url_template: srcUrl.trim(), response_path: srcPath.trim() || 'hits', title_field: srcTitle.trim() || 'title', url_field: srcUrlField.trim() || 'url' });
      toast('Source added', 'ok');
      setSrcName(''); setSrcUrl(''); setSrcPath('hits'); setSrcTitle('title'); setSrcUrlField('url');
      loadSources();
    } catch { toast('Failed to add source', 'danger'); }
    finally { setAddingSource(false); }
  };

  const deleteSource = async (id: number) => {
    try { await api.deleteOracleSource(id); loadSources(); toast('Source removed', 'ok'); } catch { toast('Failed', 'danger'); }
  };

  useEffect(() => { loadHistory(); loadSources(); }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-white/6 bg-surface/60 px-4 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber/10 text-amber">
          <Icon name="travel_explore" size={18} />
        </div>
        <h1 className="font-display text-base font-bold text-ink">Hermes Oracle</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input value={keywords} onChange={e => setKeywords(e.target.value)}
            placeholder="Keywords: AI, business, marketing…"
            className="w-full sm:w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-ink placeholder:text-muted/60 focus:border-accent/50 focus:outline-none"
            onKeyDown={e => e.key === 'Enter' && scan()}
          />
          <Button variant="primary" icon="auto_awesome" loading={scanning}
            onClick={scan} className="h-8 px-4 text-xs"
            style={{ background: '#F59E0B', boxShadow: '0 0 12px rgba(245,158,11,0.3)' }}>
            Scan
          </Button>
          <button onClick={() => setShowHistory(v => !v)}
            className="rounded border border-white/10 px-2 py-1.5 text-[10px] text-muted hover:text-ink">
            {showHistory ? 'Close History' : 'History'}
          </button>
          <button onClick={() => { setShowSources(v => !v); if (!showSources) loadSources(); }}
            className="rounded border border-white/10 px-2 py-1.5 text-[10px] text-muted hover:text-ink">
            {showSources ? 'Close Sources' : 'Sources'}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Main content */}
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {headlines.length === 0 && ideas.length === 0 ? (
            <EmptyState icon="travel_explore" accent="#F59E0B" large
              title="Scan the web for content ideas"
              hint="Enter keywords above and hit Scan. Results come from Hacker News, Reddit, Dev.to and any custom sources you've added." />
          ) : (
            <>
              {headlines.length > 0 && (
                <Card glass className="p-4">
                  <h2 className="mb-3 font-display text-sm font-bold text-ink">Headlines</h2>
                  <div className="space-y-2">
                    {headlines.map((h, i) => (
                      <div key={i}>
                        <div onClick={() => openUrl(h.url)}
                          className="block rounded-lg border border-white/6 bg-white/[0.02] px-3 py-2 transition-all hover:bg-white/[0.06] hover:border-accent/30 group cursor-pointer">
                          <div className="flex items-start justify-between gap-2">
                            <span className="text-sm font-medium text-ink group-hover:text-accent transition-colors">{h.title}</span>
                            <Icon name="open_in_new" size={14} className="shrink-0 mt-0.5 text-muted/40" />
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
                            <Badge tone="neutral">{h.source}</Badge>
                            {h.summary && <span className="truncate">{h.summary}</span>}
                          </div>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); setExpanded(i === expanded ? null : i); }}
                          className="w-full text-left text-[10px] text-muted/50 hover:text-muted px-1 py-0.5 transition-colors">
                          {expanded === i ? '▲ Less' : '▼ More'}
                        </button>
                        {expanded === i && h.url && (
                          <div className="mx-1 mb-2 rounded-lg border border-white/6 bg-black/20 p-3 max-h-48 overflow-y-auto">
                            <div className="mb-2 flex items-center gap-2">
                              <Icon name="link" size={12} className="text-muted/60" />
                              <span className="truncate text-[10px] text-muted/70">{h.url}</span>
                            </div>
                            {h.summary && <p className="text-xs text-muted/80 leading-relaxed">{h.summary}</p>}
                            <button onClick={(e) => { e.stopPropagation(); openUrl(h.url); }}
                              className="mt-2 inline-flex items-center gap-1 rounded bg-accent/10 px-2 py-1 text-[10px] text-accent hover:bg-accent/20 transition-colors cursor-pointer">
                              <Icon name="open_in_new" size={12} /> Open article
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              )}
              {ideas.length > 0 && (
                <Card glass className="p-4">
                  <h2 className="mb-3 font-display text-sm font-bold text-ink">Content Ideas</h2>
                  <div className="space-y-2">
                    {ideas.map((idea, i) => (
                      <div key={i} className="rounded-lg border border-amber/10 bg-amber/[0.03] px-3 py-2">
                        <div className="text-sm font-medium text-ink">{idea.suggested_title}</div>
                        <div className="mt-0.5 text-[11px] text-muted">{idea.angle}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </>
          )}
        </div>

        {/* Side panel — history or sources */}
        {(showHistory || showSources) && (
          <aside className="w-72 shrink-0 border-l border-white/6 overflow-y-auto p-3 space-y-2">
            {showHistory && (
              <>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted/70">Scan History</h3>
                {history.length === 0 ? <p className="text-xs text-muted/60">No scans yet</p> : history.map(s => (
                  <button key={s.id} onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                    className="w-full rounded-lg border border-white/6 px-2.5 py-2 text-left text-xs transition-colors hover:bg-white/5">
                    <div className="font-medium text-ink">{s.keywords.join(', ')}</div>
                    <div className="text-muted/70">{s.headline_count} headlines</div>
                  </button>
                ))}
              </>
            )}
            {showSources && (
              <>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted/70">Custom Sources</h3>
                <div className="space-y-1.5">
                  <input value={srcName} onChange={e => setSrcName(e.target.value)} placeholder="Source name" className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-xs text-ink" />
                  <input value={srcUrl} onChange={e => setSrcUrl(e.target.value)} placeholder="URL template (use {kw} for keyword)" className="w-full rounded border border-white/10 bg-black/20 px-2 py-1 text-xs text-ink" />
                  <div className="flex gap-1">
                    <input value={srcPath} onChange={e => setSrcPath(e.target.value)} placeholder="JSON path" className="flex-1 rounded border border-white/10 bg-black/20 px-2 py-1 text-[10px] text-ink" title="JSON key for results array (e.g. hits, data.children, articles)" />
                    <input value={srcTitle} onChange={e => setSrcTitle(e.target.value)} placeholder="title field" className="w-16 rounded border border-white/10 bg-black/20 px-1 py-1 text-[10px] text-ink" />
                    <input value={srcUrlField} onChange={e => setSrcUrlField(e.target.value)} placeholder="url field" className="w-16 rounded border border-white/10 bg-black/20 px-1 py-1 text-[10px] text-ink" />
                  </div>
                  <Button variant="primary" icon="add" loading={addingSource} onClick={addSource} className="w-full h-7 text-xs" style={{ background: '#F59E0B' }}>Add Source</Button>
                </div>
                <div className="mt-3 space-y-1">
                  {sources.map(s => (
                    <div key={s.id} className="flex items-center justify-between rounded border border-white/6 px-2 py-1.5">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-ink">{s.name}</div>
                        <div className="truncate text-[9px] text-muted/60">{s.url_template}</div>
                      </div>
                      <button onClick={() => deleteSource(s.id)} className="shrink-0 text-[10px] text-rose/70 hover:text-rose">×</button>
                    </div>
                  ))}
                </div>
                <p className="pt-2 text-[9px] text-muted/50 leading-relaxed">
                  Built-in sources (HN, Reddit, Dev.to) always run. Add any JSON API — use {'{'}kw{'}'} in the URL template for your keyword. Set JSON path to the key containing the results array.
                </p>
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
