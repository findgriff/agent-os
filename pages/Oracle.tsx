import { useState, useEffect } from 'react';
import { Button, Card, EmptyState, Icon, useToast } from '../components/ui';
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

export default function Oracle() {
  const toast = useToast();
  const [keywords, setKeywords] = useState('');
  const [scanning, setScanning] = useState(false);
  const [headlines, setHeadlines] = useState<Headline[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [history, setHistory] = useState<Scan[]>([]);
  const [showHistory, setShowHistory] = useState(false);

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
    try {
      const res = await api.oracleHistory();
      setHistory(res.scans || []);
    } catch {}
  };

  useEffect(() => { loadHistory(); }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-white/6 bg-surface/60 px-4 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: '#F59E0B1a', color: '#F59E0B' }}>
          <Icon name="travel_explore" size={18} />
        </div>
        <h1 className="font-display text-base font-bold text-ink">Hermes Oracle</h1>
        <div className="ml-auto flex items-center gap-2">
          <input value={keywords} onChange={e => setKeywords(e.target.value)}
            placeholder="Keywords: AI, business, marketing…"
            className="w-64 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-ink placeholder:text-muted/60 focus:border-accent/50 focus:outline-none"
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
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* History sidebar */}
        {showHistory && (
          <div className="w-56 shrink-0 overflow-y-auto border-r border-white/6 bg-surface/40 p-3">
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted/70">Past Scans</h2>
            {history.map(s => (
              <div key={s.id} className="mb-2 rounded-lg border border-white/8 p-2 text-xs">
                <div className="text-ink font-semibold">{(s.keywords || []).join(', ')}</div>
                <div className="text-muted/70">{s.headline_count} headlines · {new Date(s.created_at * 1000).toLocaleDateString()}</div>
              </div>
            ))}
            {history.length === 0 && <div className="text-xs text-muted/50">No scans yet</div>}
          </div>
        )}

        {/* Main content */}
        <div className="flex-1 overflow-y-auto p-4">
          {headlines.length === 0 && ideas.length === 0 ? (
            <div className="grid h-full place-items-center">
              <EmptyState icon="travel_explore" accent="#F59E0B" large
                title="Search the trends"
                hint="Enter keywords above to scan for trending news and automatically generate content ideas." />
            </div>
          ) : (
            <>
              {/* Headlines grid */}
              <div className="mb-6">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted/70">Trending Headlines</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {headlines.map((h, i) => (
                    <Card key={i} className="p-3" onClick={() => setExpanded(expanded === i ? null : i)}>
                      <div className="flex items-start gap-2">
                        <div className="text-sm text-ink font-semibold leading-snug">{h.title}</div>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted/70">
                        <span className="rounded-full bg-amber/10 px-2 py-0.5 text-amber">{h.source}</span>
                      </div>
                      {expanded === i && h.summary && (
                        <div className="mt-2 text-xs text-muted line-clamp-3">{h.summary}</div>
                      )}
                    </Card>
                  ))}
                </div>
              </div>

              {/* Content ideas */}
              {ideas.length > 0 && (
                <div>
                  <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted/70">AI-Generated Content Ideas</h2>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {ideas.map((idea, i) => (
                      <Card key={i} className="p-3 border border-amber/20">
                        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-amber">Idea {i + 1}</div>
                        <div className="mb-2 text-sm text-ink font-semibold">{idea.suggested_title}</div>
                        <div className="text-xs text-muted/80">{idea.angle}</div>
                        <div className="mt-2 flex gap-1">
                          <Button variant="secondary" icon="account_tree" className="h-6 px-2 text-[10px]">Push to Pipeline</Button>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
