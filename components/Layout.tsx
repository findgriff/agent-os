// App shell: left icon-nav sidebar + top bar (project switcher + user menu).
// Also hosts the connected-integrations rail (opens a per-bridge ChatPanel)
// and focus mode, which collapses the chrome so a page fills the screen.
// The sidebar can be collapsed to icon-only mode (persisted per browser).
import { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Icon } from './ui';
import { Logo } from './Logo';
import { ChatPanel } from './ChatPanel';
import { useApp } from '../lib/store';
import { styleFor } from '../pages/Integrations';
import type { Connection } from '../lib/types';

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', colour: '#19C3E6', end: true },
  { to: '/agents', label: 'Agents', icon: 'smart_toy', colour: '#38BDF8' },
  { to: '/mission-control', label: 'Mission Control', icon: 'radar', colour: '#F59E0B' },
  { to: '/galaxy', label: 'Memory Galaxy', icon: 'auto_awesome', colour: '#A78BFA' },
  { to: '/studio', label: 'Studio', icon: 'palette', colour: '#C084FC' },
  { to: '/pipelines', label: 'Pipelines', icon: 'account_tree', colour: '#22C55E' },
  { to: '/kanban', label: 'Kanban', icon: 'view_kanban', colour: '#F59E0B' },
  { to: '/war-room', label: 'War Room', icon: 'groups', colour: '#EF4444' },
  { to: '/gallery', label: 'Gallery', icon: 'photo_library', colour: '#C084FC' },
  { to: '/leads', label: 'Leads', icon: 'person_search', colour: '#38BDF8' },
  { to: '/email', label: 'Email', icon: 'mail', colour: '#14B8A6' },
  { to: '/apollo', label: 'Apollo', icon: 'mic', colour: '#EF4444' },
  { to: '/oracle', label: 'Oracle', icon: 'travel_explore', colour: '#A78BFA' },
  { to: '/search', label: 'Search', icon: 'search', colour: '#38BDF8' },
  { to: '/integrations', label: 'Integrations', icon: 'hub', colour: '#22C55E' },
  { to: '/settings', label: 'Settings', icon: 'settings', colour: '#7B8DA8' },
];

const dotColour = (s?: string) =>
  s === 'connected' ? '#22C55E' : s === 'error' ? '#F43F5E' : '#7B8DA8';

const SIDEBAR_KEY = 'agentos_sidebar_collapsed';

export function Layout({ children }: { children: React.ReactNode }) {
  const { tenants, selectedTenant, setSelectedTenant, user, logout,
    bridges, isFocused, toggleFocus } = useApp();
  const [projOpen, setProjOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [chat, setChat] = useState<Connection | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
  });
  const nav = useNavigate();
  const location = useLocation();
  const current = tenants.find(t => t.id === selectedTenant);
  const connected = bridges.filter(b => b.enabled);

  const toggleSidebar = () => setCollapsed(c => {
    const next = !c;
    try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  // Below lg the sidebar is always icon-only; the toggle only matters on desktop.
  const wide = !collapsed;

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-ink">
      {/* Sidebar — hidden entirely in focus mode */}
      {!isFocused && (
        <aside className={`flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-white/6 bg-surface/60 py-4 transition-[width] duration-200
          ${wide ? 'lg:w-60 lg:items-stretch lg:px-3' : 'lg:w-[76px]'}`}>
          <div className={`mb-4 flex justify-center ${wide ? 'lg:justify-start lg:px-2' : ''}`}>
            <Logo showText={false} className={wide ? 'lg:hidden' : ''} />
            {wide && <div className="hidden lg:block"><Logo /></div>}
          </div>
          <nav className="flex flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden">
            {NAV.map(n => (
              <NavLink key={n.to} to={n.to} end={n.end} title={n.label}
                className={({ isActive }) =>
                  `group relative flex items-center gap-3 rounded-xl px-3 py-2.5 transition-all duration-200
                   ${isActive ? 'bg-white/6 text-ink' : 'text-muted hover:translate-x-0.5 hover:bg-white/4 hover:text-ink'}`}>
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <>
                        <span className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full"
                          style={{ background: n.colour, boxShadow: `0 0 10px ${n.colour}` }} />
                        <span className="pointer-events-none absolute inset-x-2 bottom-0 h-px rounded-full"
                          style={{ background: `linear-gradient(90deg, transparent, ${n.colour}66, transparent)`,
                            boxShadow: `0 1px 8px ${n.colour}55` }} />
                      </>
                    )}
                    <Icon name={n.icon} size={22} fill={isActive}
                      className="shrink-0 transition-transform duration-200 group-hover:scale-110"
                      style={{
                        color: isActive ? n.colour : undefined,
                        filter: isActive ? `drop-shadow(0 0 6px ${n.colour}88)` : undefined,
                      } as any} />
                    <span className={`hidden text-sm font-medium ${wide ? 'lg:inline' : ''}`}>{n.label}</span>
                  </>
                )}
              </NavLink>
            ))}

            {/* ── Connected integrations ─────────────────────────────── */}
            {connected.length > 0 && (
              <>
                <div className="my-2 border-t border-white/6" />
                {wide && (
                  <div className="hidden px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted/60 lg:block">
                    Integrations
                  </div>
                )}
                {connected.map(b => {
                  const st = styleFor(b.platform);
                  return (
                    <button key={b.id} onClick={() => setChat(b)}
                      title={b.label || b.meta.label}
                      className="group relative flex items-center gap-3 rounded-xl px-3 py-2 text-muted transition-all duration-200 hover:translate-x-0.5 hover:bg-white/4 hover:text-ink">
                      <span className="relative shrink-0 transition-transform duration-200 group-hover:scale-110">
                        <Icon name={st.icon} size={20} style={{ color: st.accent } as any} />
                        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-surface"
                          style={{ background: dotColour(b.last_status),
                            boxShadow: `0 0 6px ${dotColour(b.last_status)}` }} />
                      </span>
                      <span className={`hidden truncate text-[13px] font-medium ${wide ? 'lg:inline' : ''}`}>
                        {b.label || b.meta.label}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </nav>

          {/* Collapse toggle + version */}
          <div className={`hidden pt-3 lg:flex ${wide ? 'items-center justify-between px-3' : 'justify-center'}`}>
            {wide && <span className="text-[10px] text-muted/60">v1.0 · HQ</span>}
            <button onClick={toggleSidebar}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-all duration-200 hover:bg-white/6 hover:text-accent">
              <Icon name={collapsed ? 'right_panel_open' : 'left_panel_close'} size={18} />
            </button>
          </div>
        </aside>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className={`flex shrink-0 items-center justify-between gap-3 border-b border-white/6 bg-surface/40 px-4 backdrop-blur transition-all
          ${isFocused ? 'h-11' : 'h-16'}`}>
          {/* Project switcher (+ mobile back button) */}
          <div className="flex min-w-0 items-center gap-1.5">
            {!isFocused && location.pathname !== '/' && (
              <button onClick={() => nav(-1)} title="Back"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-white/5 hover:text-ink lg:hidden">
                <Icon name="arrow_back" size={20} />
              </button>
            )}
          <div className="relative">
            <button onClick={() => setProjOpen(o => !o)}
              className="glass flex items-center gap-2 rounded-xl px-3 py-2 text-sm hover:bg-white/8">
              <span className="h-2.5 w-2.5 rounded-full"
                style={{ background: current?.brand_colour || '#19C3E6', boxShadow: `0 0 8px ${current?.brand_colour || '#19C3E6'}` }} />
              <span className="font-medium">{current ? current.name : 'All Projects'}</span>
              <Icon name="expand_more" size={18} className="text-muted" />
            </button>
            {projOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setProjOpen(false)} />
                <div className="absolute z-20 mt-2 w-60 glass-raised rounded-xl p-1.5 shadow-2xl animate-fadeInUp">
                  <button onClick={() => { setSelectedTenant(null); setProjOpen(false); }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-white/6">
                    <Icon name="grid_view" size={18} className="text-accent" /> All Projects
                  </button>
                  {tenants.map(t => (
                    <button key={t.id} onClick={() => { setSelectedTenant(t.id); setProjOpen(false); }}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-white/6">
                      <span className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.brand_colour }} />
                        {t.name}
                      </span>
                      <span className="text-xs text-muted">{t.agent_count}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          </div>

          <div className="flex items-center gap-1">
            {/* Focus mode toggle */}
            <button onClick={toggleFocus}
              title={isFocused ? 'Exit focus mode' : 'Enter focus mode'}
              className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-sm text-muted hover:bg-white/5 hover:text-ink">
              <Icon name={isFocused ? 'close_fullscreen' : 'center_focus_strong'} size={20} />
              <span className="hidden md:inline">{isFocused ? 'Exit focus' : 'Focus'}</span>
            </button>

            {/* User menu */}
            <div className="relative">
              <button onClick={() => setUserOpen(o => !o)}
                className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-white/5">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-accent to-violet text-xs font-bold text-[#04222b]">
                  {(user?.name || 'A').slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden text-sm sm:inline">{user?.name}</span>
                <Icon name="expand_more" size={18} className="text-muted" />
              </button>
              {userOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setUserOpen(false)} />
                  <div className="absolute right-0 z-20 mt-2 w-52 glass-raised rounded-xl p-1.5 shadow-2xl animate-fadeInUp">
                    <div className="px-3 py-2 text-xs text-muted">{user?.email}</div>
                    <button onClick={() => { setUserOpen(false); nav('/settings'); }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-white/6">
                      <Icon name="settings" size={18} /> Settings
                    </button>
                    <button onClick={logout}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose hover:bg-rose/10">
                      <Icon name="logout" size={18} /> Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* keyed on route so every page enters with a fade-in-up transition */}
        <main key={location.pathname} className="grid-bg flex-1 overflow-y-auto animate-pageFade">
          {children}
        </main>
      </div>

      {/* Floating exit-focus button */}
      {isFocused && (
        <button onClick={toggleFocus}
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full glass-raised px-4 py-2.5 text-sm text-ink shadow-2xl transition-all hover:bg-white/10 animate-fadeInUp">
          <Icon name="close_fullscreen" size={18} className="text-accent" /> Exit focus
        </button>
      )}

      {/* Per-integration chat drawer */}
      <ChatPanel connection={chat} open={!!chat} onClose={() => setChat(null)} />
    </div>
  );
}
