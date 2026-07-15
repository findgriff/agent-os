import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api, getToken } from './lib/api';
import type { User } from './lib/types';
import { AppProvider, useApp } from './lib/store';
import { ToastProvider, Icon } from './components/ui';
import { Layout } from './components/Layout';
import { Logo } from './components/Logo';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Agents from './pages/Agents';
import MissionControl from './pages/MissionControl';
import MemoryGalaxy from './pages/MemoryGalaxy';
import ImageStudio from './pages/ImageStudio';
import Integrations from './pages/Integrations';
import Settings from './pages/Settings';
import Pipelines from './pages/Pipelines';
import Kanban from './pages/Kanban';
import WarRoom from './pages/WarRoom';
import Gallery from './pages/Gallery';
import Leads from './pages/Leads';
import Email from './pages/Email';
import Voice from './pages/Voice';
import VoiceOld from './pages/VoiceOld';
import Oracle from './pages/Oracle';
import SearchPage from './pages/Search';

function Shell() {
  const { user, setUser } = useApp();
  if (!user) return <Login onAuthed={setUser} />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/mission-control" element={<MissionControl />} />
        <Route path="/galaxy" element={<MemoryGalaxy />} />
        <Route path="/studio" element={<ImageStudio />} />
        <Route path="/pipelines" element={<Pipelines />} />
        <Route path="/kanban" element={<Kanban />} />
        <Route path="/war-room" element={<WarRoom />} />
        <Route path="/gallery" element={<Gallery />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/email" element={<Email />} />
        <Route path="/apollo" element={<Voice />} />
        <Route path="/voice" element={<Navigate to="/apollo" replace />} />
        <Route path="/voice-old" element={<VoiceOld />} />
        <Route path="/oracle" element={<Oracle />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    if (!getToken()) { setBooting(false); return; }
    api.me().then(r => setUser(r.user)).catch(() => {}).finally(() => setBooting(false));
  }, []);

  if (booting) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <div className="animate-pulse"><Logo size={44} /></div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AppProvider user={user}>
        <Shell />
      </AppProvider>
    </ToastProvider>
  );
}
