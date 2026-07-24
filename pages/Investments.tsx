// Investments Dashboard — live stock tracker
// AGENT OS design system: dark theme, glassmorphism, teal accents
import { useEffect, useState, useCallback } from 'react';
import { Card, Stat, SkeletonList, EmptyState, Icon, Button } from '../components/ui';
import { useApp } from '../lib/store';
import { api, apiReq, timeAgo } from '../lib/api';
import type { InvestmentData, InvestmentList, InvestmentNews } from '../lib/types';

const ALL_TICKERS = ["ARR","DX","NLY","AGNC","HTGC","STWD","TWO","BXMT","ARCC","PBR","INFY","SMCI","SE","NKE","BABA","PDD","KWEB","PSEC","TCEHY","HDB","IBN","ITUB","JD","BBD"];
const HIGH_DIV = ["ARR","DX","NLY","AGNC","HTGC","STWD","TWO","BXMT","ARCC","PBR"];
const FLOOR = ["INFY","SMCI","SE","NKE","BABA","PDD","KWEB","PSEC"];
const EMERGING = ["TCEHY","BABA","HDB","PBR","IBN","ITUB","INFY","JD","BBD"];

function PriceChange({ pct }: { pct: number }) {
  if (pct === 0) return <span className="text-white/50">—</span>;
  const isUp = pct > 0;
  return (
    <span className={`flex items-center gap-1 text-sm ${isUp ? 'text-accent' : 'text-rose'}`}>
      <span className="text-xs">{isUp ? '▲' : '▼'}</span>
      {Math.abs(pct).toFixed(2)}%
    </span>
  );
}

function CountryFlag({ country }: { country: string }) {
  const flags: Record<string, string> = {
    'China': '🇨🇳', 'India': '🇮🇳', 'Brazil': '🇧🇷', 'Singapore': '🇸🇬',
    'United States': '🇺🇸', 'US': '🇺🇸', 'Ireland': '🇮🇪', 'Uruguay': '🇺🇾',
  };
  return <span className="mr-1.5">{flags[country] || '🌐'}</span>;
}

function InvestmentCard({ d, showYield, showFloor, showPE, showCountry }: {
  d: InvestmentData; showYield?: boolean; showFloor?: boolean; showPE?: boolean; showCountry?: boolean;
}) {
  if (d.error) return null;
  return (
    <div className="bg-[#14141F]/80 backdrop-blur-xl border border-white/5 rounded-2xl p-4
      hover:-translate-y-0.5 hover:border-white/10 hover:shadow-[0_10px_28px_-10px_rgba(25,195,230,0.25)]
      transition-all duration-200 ease-out cursor-default group">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {showCountry && <CountryFlag country={d.country} />}
          <span className="text-white/90 font-semibold text-sm tracking-wider">{d.ticker}</span>
        </div>
        <PriceChange pct={d.change_pct} />
      </div>
      <div className="text-white/50 text-xs truncate mb-3">{d.name}</div>
      <div className="flex items-baseline gap-2">
        <span className="text-white text-lg font-bold">${d.price.toFixed(2)}</span>
        {showYield && d.dividend_yield_pct > 0 && (
          <span className="text-accent text-xs font-medium bg-accent/10 px-2 py-0.5 rounded-full">
            {d.dividend_yield_pct.toFixed(1)}%
          </span>
        )}
        {showFloor && (
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            d.pct_from_52w_high < -30 ? 'bg-rose/10 text-rose' :
            d.pct_from_52w_high < -15 ? 'bg-amber/10 text-amber' :
            'bg-accent/10 text-accent'
          }`}>
            {d.pct_from_52w_high.toFixed(0)}%
          </span>
        )}
        {showPE && d.pe_ratio > 0 && (
          <span className="text-white/40 text-xs">P/E {d.pe_ratio.toFixed(1)}</span>
        )}
      </div>
      <div className="text-white/30 text-[10px] mt-2">{d.sector}</div>
    </div>
  );
}

function SectionHeader({ title, subtitle, count }: { title: string; subtitle: string; count: number }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div>
        <h2 className="text-white text-lg font-semibold">{title}</h2>
        <p className="text-white/40 text-xs mt-0.5">{subtitle}</p>
      </div>
      <span className="text-white/30 text-xs bg-white/5 px-2.5 py-1 rounded-full">{count} stocks</span>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {[1,2,3,4,5,6,7,8].map(i => (
        <div key={i} className="bg-[#14141F]/50 border border-white/5 rounded-2xl p-4 animate-pulse">
          <div className="h-3 bg-white/5 rounded w-16 mb-3" />
          <div className="h-2.5 bg-white/5 rounded w-24 mb-4" />
          <div className="h-5 bg-white/5 rounded w-14" />
        </div>
      ))}
    </div>
  );
}

export default function Investments() {
  const [prices, setPrices] = useState<Record<string, InvestmentData>>({});
  const [news, setNews] = useState<InvestmentNews[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [portfolioError, setPortfolioError] = useState(false);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [portfolios, setPortfolios] = useState<any[]>([]);
  const [selectedPortfolio, setSelectedPortfolio] = useState<string | null>(null);
  const [portfolioSummary, setPortfolioSummary] = useState<any>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await apiReq<{ prices: InvestmentData[] }>('GET', `/api/investments/prices?tickers=${ALL_TICKERS.join(',')}`);
      const map: Record<string, InvestmentData> = {};
      for (const d of res.prices) map[d.ticker] = d;
      setPrices(map);
    } catch { setError(true); }
    try {
      const res = await apiReq<{ news: InvestmentNews[] }>('GET', `/api/investments/news?tickers=${ALL_TICKERS.slice(0,5).join(',')}`);
      setNews(res.news.slice(0, 10));
    } catch { /* ignore */ }
    // Load portfolios
    try {
      const res = await apiReq<{ portfolios: any[] }>('GET', '/api/portfolios');
      if (res.portfolios?.length > 0) {
        setPortfolios(res.portfolios);
        setSelectedPortfolio(res.portfolios[0].id);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Stats
  const allData = Object.values(prices).filter(d => !d.error);
  const avgYield = allData.reduce((s, d) => s + d.dividend_yield_pct, 0) / (allData.length || 1);
  const maxYield = Math.max(...allData.map(d => d.dividend_yield_pct), 0);
  const totalMcap = allData.reduce((s, d) => s + d.market_cap, 0);

  const addToWatchlist = () => {
    const t = searchInput.trim().toUpperCase();
    if (t && !watchlist.includes(t)) setWatchlist(prev => [...prev, t]);
    setSearchInput('');
  };

  // Load portfolio summary when selected
  const loadPortfolioSummary = useCallback(() => {
    if (!selectedPortfolio) return;
    setPortfolioError(false);
    apiReq<{ summary: any }>('GET', `/api/portfolios/${selectedPortfolio}`)
      .then(res => setPortfolioSummary(res.summary))
      .catch(() => { setPortfolioSummary(null); setPortfolioError(true); });
  }, [selectedPortfolio]);

  useEffect(() => { loadPortfolioSummary(); }, [loadPortfolioSummary]);

  return (
    <div className="relative p-6 max-w-7xl mx-auto space-y-8">
      {/* Ambient wash — teal market glow from the top */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[440px]
        bg-[radial-gradient(ellipse_70%_60%_at_50%_-12%,rgba(25,195,230,0.09),transparent_65%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[440px]
        bg-[radial-gradient(ellipse_45%_45%_at_90%_-10%,rgba(167,139,250,0.06),transparent_60%)]" />

      {/* Header */}
      <div className="relative flex items-center justify-between animate-fadeInUp">
        <div>
          <h1 className="text-2xl font-bold text-white">Investments</h1>
          <p className="text-white/40 text-sm mt-1">Live prices, dividends & market data</p>
        </div>
        <Button variant="secondary" icon="refresh" loading={loading} onClick={fetchAll}>Refresh</Button>
      </div>

      {/* Stats bar — icon + number + label */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Tracked', icon: 'monitoring', accent: '#FFFFFF', value: String(allData.length) },
          { label: 'Avg Yield', icon: 'percent', accent: '#19C3E6', value: `${avgYield.toFixed(1)}%` },
          { label: 'Top Yield', icon: 'workspace_premium', accent: '#22C55E', value: `${maxYield.toFixed(1)}%` },
          { label: 'Market Cap', icon: 'public', accent: '#A78BFA', value: `$${(totalMcap / 1e9).toFixed(0)}B` },
        ].map((s, i) => (
          <div key={s.label}
            className="group bg-[#14141F]/80 backdrop-blur-xl border border-white/5 rounded-2xl p-4 animate-fadeInUp
              transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-white/10 hover:shadow-[0_10px_32px_-10px_rgba(25,195,230,0.25)]"
            style={{ animationDelay: `${i * 80}ms` }}>
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-transform duration-200 group-hover:scale-110 group-hover:-rotate-6"
                style={{ background: `${s.accent}1a`, color: s.accent === '#FFFFFF' ? 'rgba(255,255,255,0.8)' : s.accent,
                  boxShadow: `0 0 20px -10px ${s.accent}66` }}>
                <Icon name={s.icon} size={19} />
              </span>
              <div className="min-w-0">
                <div className="text-lg font-bold leading-tight tabular-nums"
                  style={{ color: s.accent === '#FFFFFF' ? '#fff' : s.accent }}>{s.value}</div>
                <div className="text-white/40 text-xs truncate">{s.label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Load error */}
      {error && !loading && (
        <Card className="p-6 animate-fadeInUp">
          <EmptyState icon="cloud_off" title="Couldn't load market data"
            hint="Something went wrong reaching the server."
            action={<Button icon="refresh" loading={loading} onClick={fetchAll}>Retry</Button>} />
        </Card>
      )}

      {/* Watchlist search */}
      <div className="flex gap-2 animate-fadeInUp" style={{ animationDelay: '160ms' }}>
        <input
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addToWatchlist()}
          placeholder="Add ticker to watchlist (e.g. AAPL)"
          className="flex-1 bg-[#14141F]/80 border border-white/10 rounded-xl px-4 py-2.5
            text-white text-sm placeholder-white/30 outline-none focus:border-accent/50 transition-colors"
        />
        <button onClick={addToWatchlist}
          className="bg-accent/10 border border-accent/30 text-accent text-sm
            px-4 py-2.5 rounded-xl hover:bg-accent/20 hover:shadow-[0_0_24px_-6px_rgba(25,195,230,0.6)] transition-all duration-200 ease-out">
          + Add
        </button>
      </div>

      {/* Portfolio Tracker */}
      {portfolios.length > 0 && (
        <div className="bg-[#14141F]/80 backdrop-blur-xl border border-white/5 rounded-2xl p-5 animate-fadeInUp
          transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-white/10 hover:shadow-[0_10px_32px_-10px_rgba(25,195,230,0.2)]"
          style={{ animationDelay: '220ms' }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-white text-lg font-semibold">📊 Portfolio Tracker</h2>
              <p className="text-white/40 text-xs mt-0.5">Live P&L tracking</p>
            </div>
            <select
              value={selectedPortfolio || ''}
              onChange={e => setSelectedPortfolio(e.target.value)}
              className="bg-[#0A0A0F] border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs outline-none"
            >
              {portfolios.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {portfolioSummary ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div>
                  <div className="text-white/40 text-xs">Total Value</div>
                  <div className="text-white text-lg font-bold">${(portfolioSummary.total_value || 0).toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                </div>
                <div>
                  <div className="text-white/40 text-xs">Total Cost</div>
                  <div className="text-white text-lg font-bold">${(portfolioSummary.total_cost || 0).toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                </div>
                <div>
                  <div className="text-white/40 text-xs">Total P&amp;L</div>
                  <div className={`text-lg font-bold ${(portfolioSummary.total_pl || 0) >= 0 ? 'text-accent' : 'text-rose'}`}>
                    {(portfolioSummary.total_pl || 0) >= 0 ? '+' : ''}${(portfolioSummary.total_pl || 0).toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}
                  </div>
                </div>
                <div>
                  <div className="text-white/40 text-xs">Return</div>
                  <div className={`text-lg font-bold ${(portfolioSummary.total_pl_pct || 0) >= 0 ? 'text-accent' : 'text-rose'}`}>
                    {(portfolioSummary.total_pl_pct || 0) >= 0 ? '+' : ''}{(portfolioSummary.total_pl_pct || 0).toFixed(2)}%
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                {portfolioSummary.holdings?.map((h: any) => (
                  <div key={h.ticker} className="flex items-center justify-between bg-[#0A0A0F]/50 rounded-xl px-3 py-2 text-sm transition-colors duration-200 hover:bg-white/[0.07]">
                    <div className="flex items-center gap-3">
                      <span className="text-white/90 font-semibold w-12">{h.ticker}</span>
                      <span className="text-white/40 text-xs">{h.shares}sh @ ${h.avg_price?.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-white/60 text-xs">${h.current_price?.toFixed(2)}</span>
                      <span className={`text-xs font-medium w-24 text-right ${(h.pl || 0) >= 0 ? 'text-accent' : 'text-rose'}`}>
                        {(h.pl || 0) >= 0 ? '+' : ''}${(h.pl || 0).toLocaleString(undefined, {minimumFractionDigits:2,maximumFractionDigits:2})}
                        <br/>
                        <span className="text-[10px]">({(h.pl_pct || 0) >= 0 ? '+' : ''}{(h.pl_pct || 0).toFixed(2)}%)</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : portfolioError ? (
            <EmptyState icon="cloud_off" title="Couldn't load portfolio"
              hint="Something went wrong reaching the server."
              action={<Button icon="refresh" onClick={loadPortfolioSummary}>Retry</Button>} />
          ) : (
            <div className="space-y-2">
              {[0, 1, 2].map(i => (
                <div key={i} className="skeleton h-10 rounded-xl" style={{ animationDelay: `${i * 120}ms` }} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Custom watchlist */}
      {watchlist.length > 0 && (
        <div className="animate-fadeInUp">
          <SectionHeader title="📋 My Watchlist" subtitle="Custom tickers you're tracking" count={watchlist.length} />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {loading ? <SkeletonGrid /> :
              watchlist.map(t => {
                const d = prices[t] as InvestmentData | undefined;
                return d ? <InvestmentCard key={t} d={d} showYield showPE /> :
                <div key={t} className="skeleton border border-white/5 rounded-2xl p-4
                  flex items-center justify-center text-white/30 text-sm">
                  {t}
                </div>;
              })}
          </div>
        </div>
      )}

      {/* Section 1: High Dividend */}
      <div className="animate-fadeInUp" style={{ animationDelay: '280ms' }}>
        <SectionHeader title="💰 High Dividend Yield" subtitle="REITs, BDCs & high-yield equities" count={HIGH_DIV.length} />
        {loading ? <SkeletonGrid /> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {HIGH_DIV.map(t => prices[t] && <InvestmentCard key={t} d={prices[t]} showYield />)}
          </div>
        )}
      </div>

      {/* Section 2: Floor Price */}
      <div className="animate-fadeInUp" style={{ animationDelay: '360ms' }}>
        <SectionHeader title="📉 Near 52-Week Low" subtitle="Beaten down — potential value plays" count={FLOOR.length} />
        {loading ? <SkeletonGrid /> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {FLOOR.map(t => prices[t] && <InvestmentCard key={t} d={prices[t]} showFloor showYield />)}
          </div>
        )}
      </div>

      {/* Section 3: Emerging Markets */}
      <div className="animate-fadeInUp" style={{ animationDelay: '440ms' }}>
        <SectionHeader title="🌏 Emerging Markets" subtitle="China, India, Brazil via ADRs" count={EMERGING.length} />
        {loading ? <SkeletonGrid /> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {EMERGING.map(t => prices[t] && <InvestmentCard key={t} d={prices[t]} showYield showPE showCountry />)}
          </div>
        )}
      </div>

      {/* News Feed */}
      {news.length > 0 && (
        <div className="animate-fadeInUp" style={{ animationDelay: '520ms' }}>
          <SectionHeader title="📰 Latest News" subtitle="Recent headlines across tracked stocks" count={news.length} />
          <div className="space-y-2">
            {news.map((n, i) => (
              <a key={i} href={n.link} target="_blank" rel="noopener noreferrer"
                className="block bg-[#14141F]/50 border border-white/5 rounded-xl p-3
                  hover:bg-[#14141F]/80 hover:border-white/10 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_-10px_rgba(25,195,230,0.2)]
                  transition-all duration-200 ease-out group">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="text-accent/70 text-xs font-medium">{n.ticker}</span>
                    <div className="text-white/80 text-sm mt-0.5 group-hover:text-white transition-colors">{n.title}</div>
                    <div className="text-white/30 text-[10px] mt-1">{n.publisher}</div>
                  </div>
                  <span className="text-white/20 text-xs shrink-0 mt-1">↗</span>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
