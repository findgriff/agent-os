import { useState, useEffect } from 'react';
import { Button, Card, EmptyState, Icon, useToast } from '../components/ui';
import { api } from '../lib/api';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

interface Agent {
  id: number;
  name: string;
}

export default function SearchPage() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [agentMode, setAgentMode] = useState(false);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [history, setHistory] = useState<string[]>([]);

  useEffect(() => {
    api.agents().then(d => setAgents(d.agents || [])).catch(() => {});
  }, []);

  const search = async () => {
    if (!query.trim()) { toast('Enter a search query', 'warn'); return; }
    setSearching(true);
    try {
      const q = query.trim();
      const res = (agentMode && agentId)
        ? await api.searchAgents(q, agentId)
        : await api.searchQuery(q);
      setResults(res.results || []);
      setHistory(h => [q, ...h.slice(0, 19)]);
      toast(`Found ${(res.results || []).length} results`, 'ok');
    } catch { toast('Search failed', 'danger'); }
    finally { setSearching(false); }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="border-b border-white/6 bg-surface/60 px-4 py-3">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-center gap-3">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-sky/10 text-sky">
              <Icon name="search" size={18} />
            </div>
            <div className="flex-1">
              <div className="relative">
                <input value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="Search the web…"
                  className="w-full rounded-xl border border-white/10 bg-black/30 px-4 py-2.5 text-sm text-ink placeholder:text-muted/60 focus:border-accent/50 focus:outline-none"
                  onKeyDown={e => e.key === 'Enter' && search()}
                />
                <button onClick={search} disabled={searching}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-blue/20 p-1.5 text-blue hover:bg-blue/30 transition-all disabled:opacity-50">
                  <Icon name={searching ? 'progress_activity' : 'search'} size={16} className={searching ? 'animate-spin' : ''} />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setAgentMode(v => !v)}
                className={`rounded-lg border px-2 py-1.5 text-[10px] transition-all ${agentMode ? 'border-accent/50 bg-accent/10 text-ink' : 'border-white/10 text-muted'}`}>
                <span className="flex items-center gap-1">
                  <Icon name="smart_toy" size={12} />
                  {agentMode ? 'Agent Mode ON' : 'Agent Mode'}
                </span>
              </button>
            </div>
          </div>
          {agentMode && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted">
              <span>Searching as:</span>
              <select value={agentId || ''} onChange={e => setAgentId(e.target.value ? Number(e.target.value) : null)}
                className="rounded border border-white/10 bg-black/30 px-2 py-1 text-xs text-ink">
                <option value="">Select agent…</option>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <span className="text-muted/60">Results save as agent memory</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* History sidebar */}
        {history.length > 0 && (
          <div className="w-48 shrink-0 overflow-y-auto border-r border-white/6 bg-surface/40 p-3">
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted/70">Recent</h2>
            {history.map((q, i) => (
              <button key={i} onClick={() => { setQuery(q); }}
                className="mb-1 block w-full truncate rounded px-2 py-1 text-left text-xs text-muted hover:bg-white/5 hover:text-ink">
                {q}
              </button>
            ))}
          </div>
        )}

        {/* Results */}
        <div className="flex-1 overflow-y-auto p-4">
          {results.length === 0 ? (
            <div className="grid h-full place-items-center">
              <EmptyState icon="search" accent="#38BDF8" large
                title="Search the web"
                hint="Type a query and press Enter. Results save as agent memories when in Agent Mode." />
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-3">
              {results.map((r, i) => (
                <Card key={i} className="p-3">
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-ink hover:text-accent transition-colors">
                    {r.title}
                  </a>
                  <div className="mt-0.5 text-[11px] text-muted/60 truncate">{r.url}</div>
                  {r.snippet && <div className="mt-1 text-xs text-muted/80 line-clamp-2">{r.snippet}</div>}
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
