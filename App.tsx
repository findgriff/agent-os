import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
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
import Factory from './pages/Factory';
import WarRoom from './pages/WarRoom';
import Gallery from './pages/Gallery';
import VideoStudio from './pages/VideoStudio';
import Leads from './pages/Leads';
import Email from './pages/Email';
import Voice from './pages/Voice';
import VoiceOld from './pages/VoiceOld';
import Oracle from './pages/Oracle';
import SearchPage from './pages/Search';
import Investments from './pages/Investments';
import CallCenter from './pages/CallCenter';
import PartnerLogin from './pages/PartnerLogin';
import PartnerDashboard from './pages/PartnerDashboard';
import { partnerApi, getPartnerToken, type Partner } from './lib/partnerApi';
import KSHome from './pages/ks/KSHome';
import KSBook from './pages/ks/KSBook';
import KSAccount from './pages/ks/KSAccount';
import KSCoach from './pages/ks/KSCoach';
import SignOff from './pages/mg/SignOff';
import CustomerPortal from './pages/mg/CustomerPortal';
import CustomerPayments from './pages/mg/CustomerPayments';
import CrewApp from './pages/mg/CrewApp';
import Inventory from './pages/Inventory';
import Comms from './pages/Comms';
import Reports from './pages/mg/Reports';
import Marketing from './pages/mg/Marketing';
import Invoices from './pages/mg/Invoices';
import Quotes from './pages/mg/Quotes';
import TimeClock from './pages/mg/TimeClock';
import BookOnline from './pages/mg/BookOnline';
import CrewTracking from './pages/mg/CrewTracking';
import HermesChat from './pages/HermesChat';

// Redirect to the static ops board page (not a React component)
function OpsBoardRedirect() {
  window.location.href = '/ops-board.html';
  return null;
}

// Max Gleam Partner Portal — a separate world from the HQ app. It has its
// own session (maxgleam DB), no AppProvider and no Layout, so a partner
// never sees the AGENT OS chrome and an HQ session never grants access here.
function PartnerPortal() {
  const [partner, setPartner] = useState<Partner | null>(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    if (!getPartnerToken()) { setBooting(false); return; }
    partnerApi.me()
      .then(r => setPartner(r.partner))
      .catch(() => { /* expired token → straight to the login form */ })
      .finally(() => setBooting(false));
  }, []);

  if (booting) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <Icon name="cleaning_services" size={34} className="animate-pulse text-accent" />
      </div>
    );
  }
  if (!partner) return <PartnerLogin onAuthed={setPartner} />;
  return <PartnerDashboard partner={partner} onSignOut={() => setPartner(null)} />;
}

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
        <Route path="/video-studio" element={<VideoStudio />} />
        <Route path="/pipelines" element={<Pipelines />} />
        <Route path="/kanban" element={<Kanban />} />
        <Route path="/war-room" element={<WarRoom />} />
        <Route path="/gallery" element={<Gallery />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/email" element={<Email />} />
        <Route path="/factory" element={<Factory />} />
        <Route path="/apollo" element={<Voice />} />
        <Route path="/voice" element={<Navigate to="/apollo" replace />} />
        <Route path="/voice-old" element={<VoiceOld />} />
        <Route path="/oracle" element={<Oracle />} />
        <Route path="/hermes" element={<HermesChat />} />
        <Route path="/ops-board" element={<OpsBoardRedirect />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/investments" element={<Investments />} />
        <Route path="/call-center" element={<CallCenter />} />
        <Route path="/maxgleam/reports" element={<Reports />} />
        <Route path="/maxgleam/marketing" element={<Marketing />} />
        <Route path="/maxgleam/invoices" element={<Invoices />} />
        <Route path="/maxgleam/quotes" element={<Quotes />} />
        <Route path="/tracking" element={<CrewTracking />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/comms" element={<Comms />} />
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
  const location = useLocation();
  // /partner and /ks are served by the same SPA but bypass the HQ auth gate.
  const isPartnerRoute = location.pathname.startsWith('/partner');
  const isKsRoute = location.pathname === '/ks' || location.pathname.startsWith('/ks/');
  // Max Gleam customer surfaces: the sign-off link from an SMS, and the
  // customer portal. Both are public and must never hit the HQ auth gate.
  // The time clock is a crew surface: subcontractors have no HQ account, so
  // it authenticates with the shared crew code and must bypass the auth gate.
  const isMgRoute = location.pathname.startsWith('/signoff/')
    || location.pathname === '/customer'
    || location.pathname.startsWith('/customer/')
    || location.pathname === '/timeclock'
    // The mobile crew view: signed in with a code texted to the number on
    // the crew list, so it must never hit the HQ auth gate either.
    || location.pathname === '/crew'
    // Self-serve booking: opened by someone who is not a customer yet, so it
    // is the most public surface of the lot.
    || location.pathname === '/book';
  const isPublicRoute = isPartnerRoute || isKsRoute || isMgRoute;

  useEffect(() => {
    if (isPublicRoute) { setBooting(false); return; }
    if (!getToken()) { setBooting(false); return; }
    api.me().then(r => setUser(r.user)).catch(() => {}).finally(() => setBooting(false));
  }, [isPublicRoute]);

  if (isPartnerRoute) {
    return (
      <ToastProvider>
        <PartnerPortal />
      </ToastProvider>
    );
  }

  if (isMgRoute) {
    return (
      /* ToastProvider: the time clock reports every clock-in/out through it. */
      <ToastProvider>
        <Routes>
          <Route path="/signoff/:jobId" element={<SignOff />} />
          <Route path="/customer/login" element={<CustomerPortal />} />
          {/* Must precede the /customer/* catch-all — SumUp redirects here. */}
          <Route path="/customer/payments" element={<CustomerPayments />} />
          <Route path="/customer" element={<Navigate to="/customer/login" replace />} />
          <Route path="/customer/*" element={<Navigate to="/customer/login" replace />} />
          <Route path="/timeclock" element={<TimeClock />} />
          <Route path="/crew" element={<CrewApp />} />
          <Route path="/book" element={<BookOnline />} />
        </Routes>
      </ToastProvider>
    );
  }

  // KS Sports Coaching — public site, its own light theme and sessions.
  if (isKsRoute) {
    return (
      <Routes>
        <Route path="/ks" element={<KSHome />} />
        <Route path="/ks/book" element={<KSBook />} />
        <Route path="/ks/login" element={<KSAccount />} />
        <Route path="/ks/coach" element={<KSCoach />} />
        <Route path="/ks/*" element={<Navigate to="/ks" replace />} />
      </Routes>
    );
  }

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
