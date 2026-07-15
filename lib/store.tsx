// Global app state: authed user, the tenant list, the currently selected
// project (null = All projects / HQ view), the live bridge/integration list
// (polled), and focus-mode UI state.
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, clearToken } from './api';
import type { User, Tenant, Connection } from './types';

interface AppState {
  user: User | null;
  tenants: Tenant[];
  selectedTenant: number | null;      // null => all projects
  setSelectedTenant: (id: number | null) => void;
  refreshTenants: () => Promise<void>;
  setUser: (u: User | null) => void;
  logout: () => void;

  // integrations / bridges — polled every 30s while authed
  bridges: Connection[];
  refreshBridges: () => Promise<void>;

  // focus mode — collapses chrome so a page fills the screen
  isFocused: boolean;
  toggleFocus: () => void;
  setFocused: (v: boolean) => void;
}

const Ctx = createContext<AppState>(null as any);
export const useApp = () => useContext(Ctx);

export function AppProvider({ user: initialUser, children }:
  { user: User | null; children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(initialUser);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<number | null>(null);
  const [bridges, setBridges] = useState<Connection[]>([]);
  const [isFocused, setIsFocused] = useState(false);

  const refreshTenants = useCallback(async () => {
    try { setTenants((await api.tenants()).tenants); } catch { /* ignore */ }
  }, []);

  const refreshBridges = useCallback(async () => {
    try { setBridges((await api.bridges()).connections || []); } catch { /* ignore */ }
  }, []);

  useEffect(() => { if (user) refreshTenants(); }, [user, refreshTenants]);

  // Poll bridges every 30s while authenticated (and immediately on login).
  useEffect(() => {
    if (!user) { setBridges([]); return; }
    refreshBridges();
    const id = setInterval(refreshBridges, 30_000);
    return () => clearInterval(id);
  }, [user, refreshBridges]);

  const toggleFocus = useCallback(() => setIsFocused(f => !f), []);
  const setFocused = useCallback((v: boolean) => setIsFocused(v), []);

  const logout = useCallback(() => {
    clearToken();
    // Force a full page reload so all React state is wiped and the app
    // boots fresh — the boot sequence sees there's no token and shows Login.
    window.location.href = '/';
  }, []);

  return (
    <Ctx.Provider value={{ user, tenants, selectedTenant, setSelectedTenant,
      refreshTenants, setUser, logout, bridges, refreshBridges,
      isFocused, toggleFocus, setFocused }}>
      {children}
    </Ctx.Provider>
  );
}
