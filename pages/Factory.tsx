import { useState, useEffect } from 'react';
import { Button, Card, Icon, Select, Input, Badge, EmptyState, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import type { Agent } from '../lib/types';

interface Round {
  round: number; score: number; feedback: string;
  work_preview: string; passed: boolean;
}

export default function Factory() {
  const { selectedTenant } = useApp();
  const toast = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [goal, setGoal] = useState('');
  const [builderId, setBuilderId] = useState<number | ''>('');
  const [judgeId, setJudgeId] = useState<number | ''>('');
  const [maxRounds, setMaxRounds] = useState(5);
  const [threshold, setThreshold] = useState(80);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ status: string; rounds: Round[]; final_score: number; final_work?: string } | null>(null);

  useEffect(() => {
    api.agents(selectedTenant ?? undefined).then(r => setAgents(r.agents)).catch(() => {});
  }, [selectedTenant]);

  const run = async () => {
    if (!goal.trim() || !builderId || !judgeId) { toast('Fill in all fields', 'warn'); return; }
    if (builderId === judgeId) { toast('Builder and judge must be different agents', 'warn'); return; }
    setRunning(true); setResult(null);
    try {
      const res = await api.factoryRun({ goal: goal.trim(), builder_agent_id: builderId, judge_agent_id: judgeId, max_rounds: maxRounds, pass_threshold: threshold });
      setResult(res);
      toast(res.status === 'passed' ? `✅ Passed in ${res.rounds.length} rounds!` : 'Hit max rounds', res.status === 'passed' ? 'ok' : 'warn');
    } catch { toast('Factory run failed', 'danger'); }
    finally { setRunning(false); }
  };

  // Separate agents by team
  const revenueAgents = agents.filter(a => JSON.parse((a as any).certificate_json || '{}').team === 'revenue-operations');
  const creativeAgents = agents.filter(a => JSON.parse((a as any).certificate_json || '{}').team === 'creative-systems');

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center gap-3 animate-fadeInUp">
        <div className="grid h-11 w-11 place-items-center rounded-2xl" style={{ background: '#22C55E1a', color: '#22C55E', boxShadow: '0 0 26px -6px #22C55E88' }}>
          <Icon name="precision_manufacturing" size={24} />
        </div>
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Self-Checking Factory</h1>
          <p className="text-sm text-muted">A builder creates. A judge grades. Work loops until it passes quality.</p>
        </div>
      </div>

      {/* Setup form */}
      <Card glass className="p-5 animate-fadeInUp">
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Goal</label>
            <textarea value={goal} onChange={e => setGoal(e.target.value)} rows={2}
              placeholder="e.g. Write a 500-word blog post about AI agents for small businesses..."
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink placeholder:text-muted/60 focus:border-accent/50 focus:outline-none resize-none" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Builder Agent</label>
              <Select value={builderId} onChange={e => setBuilderId(e.target.value ? Number(e.target.value) : '')} className="w-full">
                <option value="">Select builder…</option>
                {revenueAgents.map(a => <option key={a.id} value={a.id}>{a.real_name || a.name} (Revenue & Ops)</option>)}
                {creativeAgents.map(a => <option key={a.id} value={a.id}>{a.real_name || a.name} (Creative & Systems)</option>)}
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Judge Agent</label>
              <Select value={judgeId} onChange={e => setJudgeId(e.target.value ? Number(e.target.value) : '')} className="w-full">
                <option value="">Select judge…</option>
                {creativeAgents.map(a => <option key={a.id} value={a.id}>{a.real_name || a.name} (Creative & Systems)</option>)}
                {revenueAgents.map(a => <option key={a.id} value={a.id}>{a.real_name || a.name} (Revenue & Ops)</option>)}
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <div className="w-32">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Max rounds</label>
              <Select value={maxRounds} onChange={e => setMaxRounds(Number(e.target.value))}>
                {[3,5,10,15,20].map(n => <option key={n} value={n}>{n}</option>)}
              </Select>
            </div>
            <div className="w-32">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">Pass threshold</label>
              <Select value={threshold} onChange={e => setThreshold(Number(e.target.value))}>
                {[60,70,75,80,85,90,95].map(n => <option key={n} value={n}>{n}%</option>)}
              </Select>
            </div>
          </div>

          <Button variant="primary" icon="play_arrow" loading={running} onClick={run}
            className="w-full sm:w-auto"
            style={{ background: '#22C55E', boxShadow: '0 0 20px rgba(34,197,94,0.3)' }}>
            {running ? 'Running…' : 'Start Factory Loop'}
          </Button>
        </div>
      </Card>

      {/* Results */}
      {result && (
        <div className="space-y-4 animate-fadeInUp">
          <div className="flex items-center gap-3">
            <Badge tone={result.status === 'passed' ? 'ok' : 'warn'}>
              {result.status === 'passed' ? 'PASSED' : 'MAX ROUNDS'}
            </Badge>
            <span className="text-sm text-muted">
              Final score: <strong className="text-ink">{result.final_score}/100</strong> · {result.rounds.length} round(s)
            </span>
          </div>

          {/* Round history */}
          {result.rounds.map((r, i) => (
            <Card key={i} glass className={`p-4 ${r.passed ? 'border-green/30' : ''}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-display text-sm font-bold text-ink">Round {r.round}</span>
                  <Badge tone={r.passed ? 'ok' : r.score >= 60 ? 'warn' : 'danger'}>{r.score}/100</Badge>
                </div>
                {r.passed && <Icon name="verified" size={20} style={{ color: '#22C55E' }} />}
              </div>
              {r.feedback && <p className="text-xs text-muted/80 mb-2">{r.feedback}</p>}
              {r.work_preview && (
                <details className="text-xs text-muted/70">
                  <summary className="cursor-pointer hover:text-ink">Preview work</summary>
                  <pre className="mt-1 whitespace-pre-wrap rounded bg-black/20 p-2 text-[10px] leading-relaxed max-h-32 overflow-y-auto">{r.work_preview}</pre>
                </details>
              )}
            </Card>
          ))}

          {/* Final work */}
          {result.final_work && (
            <Card glass className="p-4">
              <h3 className="mb-2 font-display text-sm font-bold text-ink">Final Output</h3>
              <pre className="whitespace-pre-wrap rounded bg-black/20 p-3 text-xs leading-relaxed max-h-64 overflow-y-auto">{result.final_work}</pre>
            </Card>
          )}
        </div>
      )}

      {!result && !running && (
        <Card glass className="p-8 text-center">
          <Icon name="precision_manufacturing" size={48} className="text-muted/20 mx-auto mb-3" />
          <p className="text-sm text-muted/60">Set a goal, pick a builder and a judge, then start the loop. Completed work is saved to the Gallery automatically.</p>
        </Card>
      )}
    </div>
  );
}
