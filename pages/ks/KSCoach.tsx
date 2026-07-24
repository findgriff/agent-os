// KS Sports Coaching — coach dashboard.
// Full back-office for Saul & Kellie: sidebar navigation, a Teams-style week
// calendar, student profiles, a lead tracker and a finance overview.
//
// Live vs sample data: the calendar, register, availability, students and
// finance run on the real KS API (attendance marks send REAL texts to parents;
// finance recognises revenue from completed bookings and tracks payments).
// Tabs with no real records yet fall back to seeded samples — badged "Sample
// data" — so coaches can see the finished shape before real data builds up.
// Leads and the route map remain seeded for now.
// Demo calendar sessions carry `demo: true` and expose no actions, so a
// mis-click can never charge or text a real parent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KSShell, KSButton, KSCard, KSInput, KSLabel, KSAlert, KSPill, KSSelect, KSTextarea, Spinner,
  STATUS_PILL, KSMark,
} from './KSKit';
import { Icon } from '../../components/ui';
import {
  ksApi, getCoachToken, setCoachToken, clearCoachToken, dayName, shortDay, isoDate, money,
  type KsAttendanceStatus, type KsBlock, type KsBlockout, type KsBooking,
  type KsChildAttendance, type KsFinance, type KsOutstanding, type KsRoute,
  type KsRouteStop, type KsSchedule,
  type KsService, type KsSkill, type KsStudent,
} from '../../lib/ksApi';

const ORANGE = '#FF6B00';

// ── Navigation ──────────────────────────────────────────────────────────
type CoachTab = 'dashboard' | 'calendar' | 'route' | 'students' | 'leads' | 'finance' | 'settings';

const NAV: { id: CoachTab; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'space_dashboard' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar_month' },
  { id: 'route', label: 'Route', icon: 'route' },
  { id: 'students', label: 'Students', icon: 'groups' },
  { id: 'leads', label: 'Leads', icon: 'person_add' },
  { id: 'finance', label: 'Finance', icon: 'payments' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

// ── Session-type colour coding (calendar + legend) ──────────────────────
type SessionType = 'oneone' | 'group' | 'camp' | 'block';

const TYPE_STYLE: Record<SessionType, {
  chip: string; border: string; text: string; label: string; dot: string;
}> = {
  oneone: { chip: 'bg-orange-100', border: 'border-[#FF6B00]', text: 'text-orange-950', label: '1-to-1', dot: '#FF6B00' },
  group: { chip: 'bg-blue-100', border: 'border-blue-600', text: 'text-blue-950', label: 'Group', dot: '#2563EB' },
  camp: { chip: 'bg-green-100', border: 'border-green-600', text: 'text-green-950', label: 'Camp / club', dot: '#16A34A' },
  block: { chip: 'bg-slate-100', border: 'border-slate-400', text: 'text-slate-500', label: 'Blocked', dot: '#94A3B8' },
};

const typeOfService = (key: string, name: string): SessionType => {
  const s = `${key} ${name}`.toLowerCase();
  if (s.includes('camp') || s.includes('holiday') || s.includes('club')) return 'camp';
  if (s.includes('group') || s.includes('team')) return 'group';
  return 'oneone';
};

// ── Sample data ─────────────────────────────────────────────────────────
// Hardcoded so the Students / Leads / Finance tabs demonstrate the finished
// product immediately. Everything below is fictional.
interface MockStudent {
  id: number; child: string; age: number; sport: string; sessionType: string;
  parent: string; phone: string; email: string; address: string; emergency: string;
  history: { date: string; service: string; time: string }[];
  attendance: { date: string; present: boolean }[];
  notes: { date: string; text: string }[];
}

const MOCK_STUDENTS: MockStudent[] = [
  {
    id: 1, child: 'Alfie Thompson', age: 9, sport: 'Football', sessionType: '1-to-1 Coaching',
    parent: 'Sarah Thompson', phone: '07811 234 567', email: 'sarah.thompson84@gmail.com',
    address: '14 Birch Grove, Warrington WA4 6QT', emergency: 'Mark Thompson (dad) · 07811 765 432',
    history: [
      { date: '13 Jul 2026', service: '1-to-1 Coaching', time: '16:00' },
      { date: '6 Jul 2026', service: '1-to-1 Coaching', time: '16:00' },
      { date: '29 Jun 2026', service: '1-to-1 Coaching', time: '16:00' },
      { date: '22 Jun 2026', service: 'Small Group Coaching', time: '17:30' },
    ],
    attendance: [
      { date: '13 Jul', present: true }, { date: '6 Jul', present: true },
      { date: '29 Jun', present: true }, { date: '22 Jun', present: false },
      { date: '15 Jun', present: true },
    ],
    notes: [
      { date: '13 Jul 2026', text: 'Weak-foot passing much sharper — two-touch drills paying off.' },
      { date: '29 Jun 2026', text: 'Great session. Needs to keep his head up when dribbling at pace.' },
    ],
  },
  {
    id: 2, child: 'Freya Collins', age: 11, sport: 'Tennis', sessionType: '1-to-1 Coaching',
    parent: 'Emma Collins', phone: '07922 118 903', email: 'emma.collins@outlook.com',
    address: '3 Sandy Lane, Lymm WA13 0AF', emergency: 'Gran (Pat Collins) · 01925 754 221',
    history: [
      { date: '16 Jul 2026', service: '1-to-1 Tennis', time: '17:00' },
      { date: '9 Jul 2026', service: '1-to-1 Tennis', time: '17:00' },
      { date: '2 Jul 2026', service: '1-to-1 Tennis', time: '17:00' },
    ],
    attendance: [
      { date: '16 Jul', present: true }, { date: '9 Jul', present: true }, { date: '2 Jul', present: true },
    ],
    notes: [
      { date: '16 Jul 2026', text: 'Serve toss consistent at last. Started slice backhand.' },
    ],
  },
  {
    id: 3, child: 'Oliver Bennett', age: 7, sport: 'Football', sessionType: 'Small Group Coaching',
    parent: 'James Bennett', phone: '07733 445 210', email: 'jbennett.home@gmail.com',
    address: '27 Cherry Tree Close, Stockton Heath WA4 2PL', emergency: 'Lucy Bennett (mum) · 07733 445 211',
    history: [
      { date: '15 Jul 2026', service: 'Small Group Coaching', time: '16:30' },
      { date: '8 Jul 2026', service: 'Small Group Coaching', time: '16:30' },
      { date: '1 Jul 2026', service: 'Small Group Coaching', time: '16:30' },
    ],
    attendance: [
      { date: '15 Jul', present: true }, { date: '8 Jul', present: false }, { date: '1 Jul', present: true },
    ],
    notes: [
      { date: '15 Jul 2026', text: 'Much more confident in 1v1s. Celebrated his first nutmeg all session.' },
    ],
  },
  {
    id: 4, child: 'Maya Patel', age: 12, sport: 'Basketball', sessionType: '1-to-1 Coaching',
    parent: 'Anita Patel', phone: '07480 992 314', email: 'anita.patel@yahoo.co.uk',
    address: '9 Kingsway, Altrincham WA14 1PF', emergency: 'Raj Patel (dad) · 07480 992 315',
    history: [
      { date: '14 Jul 2026', service: '1-to-1 Basketball', time: '17:00' },
      { date: '7 Jul 2026', service: '1-to-1 Basketball', time: '17:00' },
      { date: '30 Jun 2026', service: '1-to-1 Basketball', time: '17:00' },
      { date: '23 Jun 2026', service: '1-to-1 Basketball', time: '17:00' },
    ],
    attendance: [
      { date: '14 Jul', present: true }, { date: '7 Jul', present: true },
      { date: '30 Jun', present: true }, { date: '23 Jun', present: true },
    ],
    notes: [
      { date: '14 Jul 2026', text: 'Left-hand lay-ups now automatic. Free throws 7/10 — new best.' },
      { date: '30 Jun 2026', text: 'Trials for county squad next month; building a shooting plan.' },
    ],
  },
  {
    id: 5, child: 'Charlie Whitfield', age: 8, sport: 'Football', sessionType: '1-to-1 Coaching',
    parent: 'Danielle Whitfield', phone: '07555 660 218', email: 'dani.whitfield@gmail.com',
    address: '41 Moss Road, Northwich CW8 4BY', emergency: 'Pete Whitfield · 07555 660 219',
    history: [
      { date: '17 Jul 2026', service: '1-to-1 Coaching', time: '16:00' },
      { date: '10 Jul 2026', service: '1-to-1 Coaching', time: '16:00' },
    ],
    attendance: [
      { date: '17 Jul', present: true }, { date: '10 Jul', present: false },
    ],
    notes: [
      { date: '17 Jul 2026', text: 'First session back after holiday — energy levels great.' },
    ],
  },
  {
    id: 6, child: 'Isla McGregor', age: 10, sport: 'Tennis', sessionType: 'Small Group Coaching',
    parent: 'Fiona McGregor', phone: '07891 227 405', email: 'fiona.mcgregor@icloud.com',
    address: '5 The Paddock, Knutsford WA16 8DX', emergency: 'Angus McGregor · 07891 227 406',
    history: [
      { date: '12 Jul 2026', service: 'Small Group Tennis', time: '13:30' },
      { date: '5 Jul 2026', service: 'Small Group Tennis', time: '13:30' },
      { date: '28 Jun 2026', service: 'Small Group Tennis', time: '13:30' },
    ],
    attendance: [
      { date: '12 Jul', present: true }, { date: '5 Jul', present: true }, { date: '28 Jun', present: false },
    ],
    notes: [],
  },
  {
    id: 7, child: 'Noah Barker', age: 14, sport: 'Basketball', sessionType: '1-to-1 Coaching',
    parent: 'Steve Barker', phone: '07700 900 412', email: 'steve.barker@btinternet.com',
    address: '18 Greenfield Avenue, Sale M33 4PJ', emergency: 'Claire Barker · 07700 900 413',
    history: [
      { date: '19 Jul 2026', service: '1-to-1 Basketball', time: '10:00' },
      { date: '12 Jul 2026', service: '1-to-1 Basketball', time: '10:00' },
      { date: '5 Jul 2026', service: '1-to-1 Basketball', time: '10:00' },
    ],
    attendance: [
      { date: '19 Jul', present: true }, { date: '12 Jul', present: false }, { date: '5 Jul', present: true },
    ],
    notes: [
      { date: '19 Jul 2026', text: 'Working on explosive first step. Missed last week — chased payment.' },
    ],
  },
  {
    id: 8, child: 'Poppy Sanders', age: 6, sport: 'Football', sessionType: 'Holiday Camp',
    parent: 'Becky Sanders', phone: '07344 518 227', email: 'becky.sanders@gmail.com',
    address: '2 Orchard Way, Frodsham WA6 6SN', emergency: 'Nan (Sue) · 01928 733 190',
    history: [
      { date: '11 Jul 2026', service: 'Holiday Camp', time: '09:00' },
      { date: '4 Jul 2026', service: 'Holiday Camp', time: '09:00' },
    ],
    attendance: [
      { date: '11 Jul', present: true }, { date: '4 Jul', present: true },
    ],
    notes: [
      { date: '11 Jul 2026', text: 'Youngest in the group but joins in everything. Loves the parachute games.' },
    ],
  },
  {
    id: 9, child: 'Ethan Hughes', age: 15, sport: 'Football', sessionType: '1-to-1 Coaching',
    parent: 'Rachel Hughes', phone: '07811 349 902', email: 'rachel.hughes@hotmail.co.uk',
    address: '66 Station Road, Widnes WA8 6QA', emergency: 'Dave Hughes · 07811 349 903',
    history: [
      { date: '15 Jul 2026', service: '1-to-1 Coaching', time: '18:00' },
      { date: '8 Jul 2026', service: '1-to-1 Coaching', time: '18:00' },
      { date: '1 Jul 2026', service: '1-to-1 Coaching', time: '18:00' },
      { date: '24 Jun 2026', service: '1-to-1 Coaching', time: '18:00' },
    ],
    attendance: [
      { date: '15 Jul', present: true }, { date: '8 Jul', present: true },
      { date: '1 Jul', present: true }, { date: '24 Jun', present: true },
    ],
    notes: [
      { date: '15 Jul 2026', text: 'Preparing for academy trial. Set-piece delivery outstanding.' },
    ],
  },
  {
    id: 10, child: 'Grace Ashworth', age: 13, sport: 'Tennis', sessionType: '1-to-1 Coaching',
    parent: 'Karen Ashworth', phone: '07956 002 761', email: 'karen.ashworth@gmail.com',
    address: '12 Beechwood Drive, Chester CH2 1HU', emergency: 'Ian Ashworth · 07956 002 762',
    history: [
      { date: '16 Jul 2026', service: '1-to-1 Tennis', time: '15:30' },
      { date: '9 Jul 2026', service: '1-to-1 Tennis', time: '15:30' },
    ],
    attendance: [
      { date: '16 Jul', present: true }, { date: '9 Jul', present: true },
    ],
    notes: [],
  },
];

interface Lead {
  id: number; parent: string; phone: string; email: string; childAge: number;
  interest: string; source: string; status: 'new' | 'contacted' | 'warm' | 'cold';
  added: string;
}

const MOCK_LEADS: Lead[] = [
  { id: 1, parent: 'Jade Robinson', phone: '07700 118 552', email: 'jade.rob@gmail.com',
    childAge: 8, interest: 'Football', source: 'Website', status: 'new', added: '2026-07-21' },
  { id: 2, parent: 'Tom Fletcher', phone: '07811 990 145', email: 'tom.fletcher@outlook.com',
    childAge: 10, interest: 'Tennis', source: 'Word of mouth', status: 'contacted', added: '2026-07-18' },
  { id: 3, parent: 'Priya Sharma', phone: '07480 776 320', email: 'priya.sharma@yahoo.co.uk',
    childAge: 6, interest: 'Football', source: 'Website', status: 'warm', added: '2026-07-15' },
  { id: 4, parent: 'Danny Mercer', phone: '07922 445 018', email: 'd.mercer@gmail.com',
    childAge: 13, interest: 'Basketball', source: 'Word of mouth', status: 'new', added: '2026-07-20' },
  { id: 5, parent: 'Laura Kennedy', phone: '07555 213 907', email: 'laura.kennedy@icloud.com',
    childAge: 9, interest: 'Football', source: 'Website', status: 'warm', added: '2026-07-10' },
  { id: 6, parent: 'Gareth Owen', phone: '07733 808 264', email: 'gareth.owen@btinternet.com',
    childAge: 11, interest: 'Tennis', source: 'Referral', status: 'cold', added: '2026-06-28' },
];

const LEAD_STATUS: Record<Lead['status'], { label: string; tone: 'orange' | 'blue' | 'green' | 'slate' | 'red' }> = {
  new: { label: 'New', tone: 'orange' },
  contacted: { label: 'Contacted', tone: 'blue' },
  warm: { label: 'Warm', tone: 'green' },
  cold: { label: 'Cold', tone: 'slate' },
};

// Six months of sample finances (pounds). Labels are computed from today so
// the chart always ends on the current month.
const FIN_REVENUE = [820, 1040, 960, 1280, 1520, 1730];
const FIN_SIGNUPS = [2, 3, 2, 4, 3, 5];
const monthLabels = () => {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const m = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    return m.toLocaleDateString('en-GB', { month: 'short' });
  });
};

const MOCK_OUTSTANDING = [
  { student: 'Noah Barker', amount_pence: 3500, due: 'Overdue by 6 days', reason: 'No-show charge — 12 Jul' },
  { student: 'Charlie Whitfield', amount_pence: 2800, due: 'Due Friday', reason: '1-to-1 session — 10 Jul' },
  { student: 'Poppy Sanders', amount_pence: 9000, due: 'Due 1 Aug', reason: 'Summer holiday camp week' },
  { student: 'Maya Patel', amount_pence: 5600, due: 'Due 5 Aug', reason: 'Block of 4 sessions' },
];

// ── Calendar plumbing ───────────────────────────────────────────────────
const DAY_START = 8 * 60;   // 08:00
const DAY_END = 20 * 60;    // 20:00
const HOUR_H = 52;          // px per hour
const GRID_H = ((DAY_END - DAY_START) / 60) * HOUR_H;

const toMins = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};
const minsToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const addDaysISO = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const mondayOf = (iso: string) =>
  addDaysISO(iso, -((new Date(`${iso}T12:00:00`).getDay() + 6) % 7));

function isoWeek(dateISO: string): number {
  const d = new Date(`${dateISO}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);      // Thursday of the week
  const firstThu = new Date(d.getFullYear(), 0, 4);
  firstThu.setDate(firstThu.getDate() - ((firstThu.getDay() + 6) % 7) + 3);
  return 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000));
}

// Decorative day-header weather: deterministic per date, sunnier in summer.
const WEATHER_SET = ['☀️', '🌤️', '⛅', '🌦️', '🌧️'];
function weatherFor(dateISO: string): string {
  const month = Number(dateISO.slice(5, 7)) - 1;
  const gloom = [3, 3, 2, 2, 1, 0, 0, 0, 1, 2, 3, 3][month];
  let h = 0;
  for (let i = 0; i < dateISO.length; i++) h = (h * 31 + dateISO.charCodeAt(i)) >>> 0;
  return WEATHER_SET[Math.min(4, (h % 3) + Math.floor(gloom / 1.5))];
}

function untilLabel(startsAtMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((startsAtMs - nowMs) / 60000));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m} min`;
}

// 30-minute booking start times across the coaching day.
const TIME_OPTIONS = Array.from(
  { length: (DAY_END - DAY_START) / 30 },
  (_, i) => minsToTime(DAY_START + i * 30));

interface CalEvent {
  key: string;
  date: string;
  start: string;
  end: string;
  title: string;
  service: string;
  type: SessionType;
  demo?: boolean;
  booking?: KsBooking;
  block?: KsBlock;
}

// Deterministic demo sessions by weekday, only within ±2 weeks of today so
// far-future weeks show honest emptiness. Demo events expose no actions.
const DEMO_WEEK: Record<number, { start: string; mins: number; type: SessionType; title: string; service: string }[]> = {
  1: [
    { start: '16:00', mins: 60, type: 'oneone', title: 'Alfie Thompson', service: '1-to-1 Coaching' },
    { start: '17:30', mins: 60, type: 'group', title: 'Small group · 4 players', service: 'Small Group Coaching' },
  ],
  2: [{ start: '17:00', mins: 60, type: 'oneone', title: 'Maya Patel', service: '1-to-1 Basketball' }],
  3: [
    { start: '16:30', mins: 60, type: 'group', title: 'Small group · 5 players', service: 'Small Group Coaching' },
    { start: '18:00', mins: 60, type: 'oneone', title: 'Ethan Hughes', service: '1-to-1 Coaching' },
  ],
  4: [{ start: '17:00', mins: 60, type: 'oneone', title: 'Freya Collins', service: '1-to-1 Tennis' }],
  5: [{ start: '16:00', mins: 60, type: 'oneone', title: 'Charlie Whitfield', service: '1-to-1 Coaching' }],
  6: [
    { start: '09:00', mins: 180, type: 'camp', title: 'Holiday camp · 12 players', service: 'Holiday Camp' },
    { start: '13:30', mins: 90, type: 'group', title: 'Small group tennis', service: 'Small Group Tennis' },
  ],
  0: [{ start: '10:00', mins: 60, type: 'oneone', title: 'Noah Barker', service: '1-to-1 Basketball' }],
};

function demoEventsFor(dateISO: string): CalEvent[] {
  const d = new Date(`${dateISO}T12:00:00`);
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diffDays < -7 || diffDays > 14) return [];
  return (DEMO_WEEK[d.getDay()] || []).map((p, i) => ({
    key: `demo-${dateISO}-${i}`,
    date: dateISO,
    start: p.start,
    end: minsToTime(toMins(p.start) + p.mins),
    title: p.title,
    service: p.service,
    type: p.type,
    demo: true,
  }));
}

/** Assign overlapping events to side-by-side lanes (Teams-style). */
function withLanes(events: CalEvent[]) {
  const sorted = [...events].sort((a, b) => toMins(a.start) - toMins(b.start));
  const laneEnds: number[] = [];
  const placed = sorted.map(ev => {
    const s = toMins(ev.start), e = Math.max(toMins(ev.end), s + 20);
    let lane = laneEnds.findIndex(end => end <= s);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(e); }
    else laneEnds[lane] = e;
    return { ev, lane };
  });
  return { placed, laneCount: Math.max(1, laneEnds.length) };
}

// ── Small shared pieces ─────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, accent = ORANGE, delay = 0 }:
  { icon: string; label: string; value: React.ReactNode; sub?: string; accent?: string; delay?: number }) {
  return (
    <div className="animate-fadeInUp rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md"
      style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
          <div className="mt-1 truncate text-2xl font-extrabold tabular-nums text-slate-900">{value}</div>
          {sub && <div className="mt-0.5 truncate text-[11px] text-slate-400">{sub}</div>}
        </div>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
          style={{ background: `${accent}14`, color: accent }}>
          <Icon name={icon} size={19} />
        </span>
      </div>
    </div>
  );
}

function SectionHead({ children, sample, action }:
  { children: React.ReactNode; sample?: boolean; action?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2.5">
      <h2 className="text-lg font-extrabold tracking-tight text-slate-900">{children}</h2>
      {sample && <KSPill tone="slate">Sample data</KSPill>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-2xl bg-slate-200/70 ${className}`} />;
}

function KSModal({ onClose, children, wide }:
  { onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div onClick={e => e.stopPropagation()}
        className={`relative max-h-[88vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl animate-scaleIn sm:rounded-2xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}>
        {children}
      </div>
    </div>
  );
}

function EmptyNote({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-orange-50 text-[#FF6B00]">
        <Icon name={icon} size={24} />
      </span>
      <div className="font-bold text-slate-800">{title}</div>
      {hint && <div className="max-w-xs text-sm text-slate-500">{hint}</div>}
    </div>
  );
}

// ── Attendance register (unchanged behaviour — the SMS side is LIVE) ────
const ATTENDANCE_OPTIONS: { id: KsAttendanceStatus; label: string; hint: string; cls: string }[] = [
  { id: 'attended', label: 'Attended', hint: 'Turned up and trained',
    cls: 'border-green-300 bg-green-50 text-green-800 hover:bg-green-100' },
  { id: 'absent', label: 'No-show', hint: 'Charged in full, parent texted',
    cls: 'border-red-300 bg-red-50 text-red-800 hover:bg-red-100' },
  { id: 'cancelled', label: 'Called off', hint: 'Gave notice, not charged',
    cls: 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100' },
];

const RATINGS = [1, 2, 3, 4, 5];

function SessionRegister({ b, skills, onSaved }:
  { b: KsBooking; skills: KsSkill[]; onSaved: () => void }) {
  const [status, setStatus] = useState<KsAttendanceStatus | ''>('');
  const [attNotes, setAttNotes] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [rating, setRating] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const toggleSkill = (key: string) =>
    setPicked(p => (p.includes(key) ? p.filter(k => k !== key) : [...p, key]));

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const done: string[] = [];
      if (status) {
        const res = await ksApi.markAttendance({
          ref: b.ref, status, child_name: b.child_name, notes: attNotes.trim(),
        });
        done.push(status === 'absent'
          ? `Marked absent — ${money(res.charged_pence)} still payable${
            res.sms === 'sent' || res.sms === 'dry_run' ? ', parent texted' : ''}`
          : `Marked ${status}`);
      }
      // A note with nothing in it is not worth sending to the parent.
      if (picked.length || rating !== null || notes.trim()) {
        await ksApi.saveProgress({
          ref: b.ref, child_name: b.child_name,
          skills: picked, rating, notes: notes.trim(),
        });
        done.push('progress note shared with the parent');
      }
      if (!done.length) { setError('Pick an attendance mark or write a note.'); return; }
      setSaved(done.join(' · '));
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  if (saved) {
    return (
      <div className="mt-3 rounded-xl border border-green-200 bg-green-50 px-3.5 py-3 text-sm font-semibold text-green-800">
        {saved}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-4 rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
      <div>
        <KSLabel>Attendance</KSLabel>
        <div className="grid gap-2 sm:grid-cols-3">
          {ATTENDANCE_OPTIONS.map(o => (
            <button key={o.id} type="button" onClick={() => setStatus(s => (s === o.id ? '' : o.id))}
              className={`rounded-xl border px-3 py-2 text-left transition-colors
                ${status === o.id ? `${o.cls} ring-2 ring-offset-1 ring-current`
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>
              <div className="text-sm font-bold">{o.label}</div>
              <div className="mt-0.5 text-[11px] leading-tight opacity-80">{o.hint}</div>
            </button>
          ))}
        </div>
        {status === 'absent' && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {b.parent_name} will be texted that {money(b.price_pence)} is still payable.
            Use <span className="font-bold">Called off</span> instead if they gave notice.
          </p>
        )}
        {status && (
          <KSInput className="mt-2" value={attNotes} onChange={e => setAttNotes(e.target.value)}
            placeholder="Register note (optional) — e.g. arrived 15 mins late" />
        )}
      </div>

      <div className="border-t border-slate-200 pt-3">
        <KSLabel hint="shared with the parent">Progress note</KSLabel>
        <div className="flex flex-wrap gap-1.5">
          {skills.map(s => (
            <button key={s.key} type="button" onClick={() => toggleSkill(s.key)}
              className={`rounded-full border px-3 py-1 text-xs font-bold transition-colors
                ${picked.includes(s.key)
                  ? 'border-[#FF6B00] bg-[#FF6B00] text-white'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400'}`}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Session</span>
          {RATINGS.map(r => (
            <button key={r} type="button" onClick={() => setRating(v => (v === r ? null : r))}
              aria-label={`${r} out of 5`}
              className={`h-8 w-8 rounded-lg border text-sm font-extrabold transition-colors
                ${rating !== null && r <= rating
                  ? 'border-[#FF6B00] bg-[#FF6B00] text-white'
                  : 'border-slate-300 bg-white text-slate-400 hover:border-slate-400'}`}>
              {r}
            </button>
          ))}
        </div>

        <KSTextarea className="mt-3" rows={3} value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder={`How did ${b.child_name.split(' ')[0]} get on? The parent reads this.`} />
      </div>

      {error && <KSAlert>{error}</KSAlert>}
      <KSButton loading={busy} onClick={save} className="w-full">Save register</KSButton>
    </div>
  );
}

function SessionRow({ b, onToggle, showContact, skills, onSaved }:
  { b: KsBooking; onToggle: (b: KsBooking) => void; showContact?: boolean;
    skills?: KsSkill[]; onSaved?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [register, setRegister] = useState(false);
  const done = b.status === 'completed';
  const cancelled = b.status === 'cancelled';
  // Only a session that has actually kicked off can be marked — registering
  // a no-show before the whistle would charge for a session still to come.
  const started = b.starts_at * 1000 <= Date.now();
  return (
    <div className={`rounded-xl border p-3.5 transition-all duration-200
      ${cancelled ? 'border-slate-200 bg-slate-50 opacity-70'
        : done ? 'border-blue-200 bg-blue-50/50' : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-bold text-slate-900">
              {b.start_time}–{b.end_time}
            </span>
            <KSPill tone={STATUS_PILL[b.status] || 'slate'}>
              {b.status[0].toUpperCase() + b.status.slice(1)}
            </KSPill>
          </div>
          <div className="mt-1 font-bold text-slate-900">
            {b.child_name}
            {b.child_age ? <span className="font-normal text-slate-500"> · age {b.child_age}</span> : null}
          </div>
          <div className="text-sm text-slate-600">{b.service_name}</div>
          {(b.child_school || b.child_experience) && (
            <div className="mt-0.5 text-xs text-slate-500">
              {[b.child_school, b.child_experience].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        {!cancelled && (
          <div className="flex gap-2">
            {started && skills && (
              <KSButton tone={register ? 'ghost' : 'secondary'}
                onClick={() => setRegister(r => !r)}>
                {register ? 'Close' : 'Mark attendance'}
              </KSButton>
            )}
            <KSButton tone={done ? 'secondary' : 'primary'} loading={busy}
              onClick={async () => { setBusy(true); await onToggle(b); setBusy(false); }}>
              {done ? 'Undo' : 'Mark done'}
            </KSButton>
          </div>
        )}
      </div>

      {register && skills && (
        <SessionRegister b={b} skills={skills} onSaved={() => onSaved?.()} />
      )}

      {b.notes && (
        <p className="mt-2.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-bold">Parent note:</span> {b.notes}
        </p>
      )}

      {showContact && !cancelled && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3 text-sm">
          <span className="font-semibold text-slate-700">{b.parent_name}</span>
          {b.parent_phone && (
            <a href={`tel:${b.parent_phone.replace(/\s/g, '')}`}
              className="font-bold text-[#FF6B00] hover:underline">{b.parent_phone}</a>
          )}
          <a href={`mailto:${b.parent_email}`} className="text-slate-500 hover:text-slate-800">
            {b.parent_email}
          </a>
          <span className="ml-auto font-mono text-xs text-slate-400">{b.ref}</span>
        </div>
      )}
    </div>
  );
}

// ── Calendar ────────────────────────────────────────────────────────────
function EventBlock({ ev, lane, laneCount, dayBlocked, onOpen, onCtx }:
  { ev: CalEvent; lane: number; laneCount: number; dayBlocked?: boolean;
    onOpen: (ev: CalEvent) => void; onCtx?: (ev: CalEvent, x: number, y: number) => void }) {
  const st = TYPE_STYLE[ev.type];
  const s = Math.max(toMins(ev.start), DAY_START);
  const e = Math.min(Math.max(toMins(ev.end), s + 25), DAY_END);
  if (e <= DAY_START || s >= DAY_END) return null;
  const top = ((s - DAY_START) / 60) * HOUR_H;
  const height = Math.max(((e - s) / 60) * HOUR_H - 2, 22);
  const durMins = toMins(ev.end) - toMins(ev.start);
  const done = ev.booking?.status === 'completed';
  const cancelled = ev.booking?.status === 'cancelled';
  const interactive = !!ev.booking && !ev.demo;
  // A confirmed booking sitting on a blocked-out day needs rearranging.
  const clashing = dayBlocked && interactive && ev.booking!.status === 'confirmed';
  return (
    <button
      onClick={e2 => { e2.stopPropagation(); onOpen(ev); }}
      onContextMenu={interactive && onCtx
        ? e2 => { e2.preventDefault(); e2.stopPropagation(); onCtx(ev, e2.clientX, e2.clientY); }
        : undefined}
      className={`absolute overflow-hidden rounded-lg border-l-[3px] px-1.5 py-1 text-left shadow-sm
        transition-all duration-200 ease-out hover:z-10 hover:-translate-y-px hover:shadow-md
        ${st.chip} ${st.border} ${st.text} ${cancelled ? 'opacity-45' : done ? 'opacity-75' : ''}
        ${clashing ? 'z-[6] ring-2 ring-red-500' : ''}`}
      style={{
        top, height,
        left: `calc(${(lane * 100) / laneCount}% + 2px)`,
        width: `calc(${100 / laneCount}% - 5px)`,
      }}
      title={`${ev.start}–${ev.end} · ${ev.title}${clashing ? ' — booked on a blocked day!' : ''}`}>
      <div className="truncate text-[10px] font-semibold opacity-75">
        {clashing ? '⚠️ ' : ''}{ev.start}{height > 34 ? `–${ev.end}` : ''}{done ? ' ✓' : ''}
        {ev.booking?.series_ref ? ' ↻' : ''}
      </div>
      <div className="truncate text-[11px] font-bold leading-tight">
        {cancelled ? <s>{ev.title}</s> : ev.title}
      </div>
      {height > 48 && (
        <div className="truncate text-[10px] leading-tight opacity-75">
          {ev.type === 'block' ? (ev.service || 'Unavailable') : `${ev.service} · ${durMins}m`}
        </div>
      )}
    </button>
  );
}

// ── Calendar modals + widgets ───────────────────────────────────────────
function AddBookingModal({ at, students, coaches, services, defaultCoachId, onClose, onDone }: {
  at: { date: string; time: string };
  students: KsStudent[];
  coaches: { id: number; name: string }[];
  services: KsService[];
  defaultCoachId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [studentId, setStudentId] = useState(students[0] ? String(students[0].id) : 'manual');
  const [childName, setChildName] = useState('');
  const [parentName, setParentName] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [parentPhone, setParentPhone] = useState('');
  const [serviceKey, setServiceKey] = useState(services[0]?.key || '1-to-1-coaching');
  const [date, setDate] = useState(at.date);
  const [time, setTime] = useState(at.time);
  const [duration, setDuration] = useState('');
  const [coachId, setCoachId] = useState(String(defaultCoachId));
  const [repeat, setRepeat] = useState('1');
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] =
    useState<{ n: number; skipped: { date: string; reason: string }[] } | null>(null);

  const manual = studentId === 'manual';
  const svc = services.find(s => s.key === serviceKey);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await ksApi.coachCreateBooking({
        service_key: serviceKey, date, start_time: time,
        duration_minutes: duration ? Number(duration) : undefined,
        coach_id: Number(coachId),
        student_id: manual ? undefined : Number(studentId),
        child_name: manual ? childName.trim() : undefined,
        parent_name: manual ? parentName.trim() : undefined,
        parent_email: manual ? parentEmail.trim() : undefined,
        parent_phone: manual ? parentPhone.trim() : undefined,
        repeat_weeks: Number(repeat), notify,
      });
      setDone({ n: res.bookings.length, skipped: res.skipped || [] });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Could not book that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KSModal onClose={onClose}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-extrabold tracking-tight text-slate-900">Add booking</h3>
        <button onClick={onClose} aria-label="Close"
          className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
          <Icon name="close" size={20} />
        </button>
      </div>

      {done ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-800">
            Booked {done.n} session{done.n === 1 ? '' : 's'}.
          </div>
          {done.skipped.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <div className="font-bold">Skipped {done.skipped.length}:</div>
              {done.skipped.map(s => (
                <div key={s.date}>{shortDay(s.date)} — {s.reason}</div>
              ))}
            </div>
          )}
          <KSButton onClick={onClose} className="w-full">Done</KSButton>
        </div>
      ) : (
        <div className="space-y-3.5">
          <div>
            <KSLabel>Student</KSLabel>
            <KSSelect value={studentId} onChange={e => setStudentId(e.target.value)} className="w-full py-2.5">
              {students.map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.age ? ` (age ${s.age})` : ''}</option>
              ))}
              <option value="manual">Someone else — type their details…</option>
            </KSSelect>
          </div>
          {manual && (
            <div className="space-y-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <KSInput value={childName} onChange={e => setChildName(e.target.value)}
                placeholder="Child's full name *" />
              <KSInput value={parentName} onChange={e => setParentName(e.target.value)}
                placeholder="Parent name *" />
              <div className="grid grid-cols-2 gap-2.5">
                <KSInput type="email" value={parentEmail} onChange={e => setParentEmail(e.target.value)}
                  placeholder="Parent email *" />
                <KSInput value={parentPhone} onChange={e => setParentPhone(e.target.value)}
                  placeholder="Parent phone" />
              </div>
            </div>
          )}

          <div>
            <KSLabel>Session type</KSLabel>
            <KSSelect value={serviceKey} onChange={e => setServiceKey(e.target.value)} className="w-full py-2.5">
              {services.map(s => (
                <option key={s.key} value={s.key}>{s.name}{s.minutes ? ` · ${s.minutes}m` : ''}</option>
              ))}
            </KSSelect>
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <KSLabel>Date</KSLabel>
              <KSInput type="date" value={date} onChange={e => setDate(e.target.value)} />
            </div>
            <div>
              <KSLabel>Start</KSLabel>
              <KSSelect value={time} onChange={e => setTime(e.target.value)} className="w-full py-2.5">
                {TIME_OPTIONS.map(t => <option key={t}>{t}</option>)}
              </KSSelect>
            </div>
            <div>
              <KSLabel>Length</KSLabel>
              <KSSelect value={duration} onChange={e => setDuration(e.target.value)} className="w-full py-2.5">
                <option value="">{svc?.minutes ? `${svc.minutes}m (default)` : 'Default'}</option>
                {[45, 60, 90, 120].map(m => <option key={m} value={m}>{m}m</option>)}
              </KSSelect>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <KSLabel>Coach</KSLabel>
              <KSSelect value={coachId} onChange={e => setCoachId(e.target.value)} className="w-full py-2.5">
                {coaches.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </KSSelect>
            </div>
            <div>
              <KSLabel>Repeat</KSLabel>
              <KSSelect value={repeat} onChange={e => setRepeat(e.target.value)} className="w-full py-2.5">
                <option value="1">One-off</option>
                {[4, 6, 8, 10, 12].map(w => (
                  <option key={w} value={w}>Weekly × {w}</option>
                ))}
              </KSSelect>
            </div>
          </div>

          <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-sm text-slate-700">
            <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-[#FF6B00]" />
            <span>
              <span className="font-bold">Text the parent a confirmation.</span>{' '}
              This sends a real SMS (first session only for a weekly series).
            </span>
          </label>

          {error && <KSAlert>{error}</KSAlert>}
          <KSButton onClick={submit} loading={busy} className="w-full">
            {Number(repeat) > 1 ? `Book ${repeat} weekly sessions` : 'Book session'}
          </KSButton>
        </div>
      )}
    </KSModal>
  );
}

function EditBookingModal({ b, coaches, students, onClose, onDone }: {
  b: KsBooking;
  coaches: { id: number; name: string }[];
  students: KsStudent[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [date, setDate] = useState(b.date);
  const [time, setTime] = useState(b.start_time);
  const [coachId, setCoachId] = useState(String(b.coach_id));
  const [childName, setChildName] = useState(b.child_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<'one' | 'series' | null>(null);

  const run = async (patch: Parameters<typeof ksApi.updateBooking>[1]) => {
    setBusy(true);
    setError('');
    try {
      await ksApi.updateBooking(b.id, patch);
      onDone();
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not update that booking.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KSModal onClose={onClose}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-extrabold tracking-tight text-slate-900">Edit booking</h3>
          <div className="text-xs text-slate-500">
            {b.service_name} · <span className="font-mono">{b.ref}</span>
            {b.series_ref && <span> · part of a weekly series</span>}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close"
          className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
          <Icon name="close" size={20} />
        </button>
      </div>

      <div className="space-y-3.5">
        <div>
          <KSLabel>Student</KSLabel>
          <KSInput value={childName} onChange={e => setChildName(e.target.value)}
            list="ks-student-names" placeholder="Child's name" />
          <datalist id="ks-student-names">
            {students.map(s => <option key={s.id} value={s.name} />)}
          </datalist>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <KSLabel>Date</KSLabel>
            <KSInput type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <KSLabel>Start</KSLabel>
            <KSSelect value={time} onChange={e => setTime(e.target.value)} className="w-full py-2.5">
              {TIME_OPTIONS.map(t => <option key={t}>{t}</option>)}
              {!TIME_OPTIONS.includes(time) && <option value={time}>{time}</option>}
            </KSSelect>
          </div>
        </div>
        <div>
          <KSLabel>Coach</KSLabel>
          <KSSelect value={coachId} onChange={e => setCoachId(e.target.value)} className="w-full py-2.5">
            {coaches.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </KSSelect>
        </div>

        {error && <KSAlert>{error}</KSAlert>}
        <KSButton loading={busy} className="w-full"
          onClick={() => run({ date, start_time: time, coach_id: Number(coachId),
            child_name: childName.trim() })}>
          Save changes
        </KSButton>

        <div className="border-t border-slate-100 pt-3">
          {confirming ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-600">
                {confirming === 'series'
                  ? 'Cancel every remaining session in this weekly series?'
                  : 'Cancel this session?'}{' '}
                The parent is <span className="font-bold">not texted automatically</span> — let them know.
              </p>
              <div className="flex gap-2">
                <KSButton tone="danger" loading={busy} className="flex-1"
                  onClick={() => run({ status: 'cancelled', scope: confirming })}>
                  Yes, cancel {confirming === 'series' ? 'series' : 'it'}
                </KSButton>
                <KSButton tone="ghost" onClick={() => setConfirming(null)}>Keep</KSButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <KSButton tone="danger" onClick={() => setConfirming('one')}>Cancel session</KSButton>
              {b.series_ref && (
                <KSButton tone="danger" onClick={() => setConfirming('series')}>
                  Cancel whole series
                </KSButton>
              )}
            </div>
          )}
        </div>
      </div>
    </KSModal>
  );
}

function CalContextMenu({ x, y, ev, onClose, onAction }: {
  x: number; y: number; ev: CalEvent;
  onClose: () => void;
  onAction: (a: 'edit' | 'complete' | 'cancel' | 'student') => void;
}) {
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 200);
  const done = ev.booking?.status === 'completed';
  const items: [string, string, string][] = [
    ['edit', 'edit_calendar', 'Reschedule'],
    ['complete', 'task_alt', done ? 'Mark not done' : 'Mark complete'],
    ['student', 'person_search', 'View student'],
    ['cancel', 'event_busy', 'Cancel session'],
  ];
  return (
    <div className="fixed inset-0 z-50" onClick={onClose}
      onContextMenu={e => { e.preventDefault(); onClose(); }}>
      <div onClick={e => e.stopPropagation()}
        className="absolute w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-2xl animate-scaleIn"
        style={{ left, top }}>
        {items.map(([a, icon, label]) => (
          <button key={a}
            onClick={() => { onAction(a as 'edit' | 'complete' | 'cancel' | 'student'); onClose(); }}
            className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm font-semibold transition-colors hover:bg-slate-50
              ${a === 'cancel' ? 'text-red-600' : 'text-slate-700'}`}>
            <Icon name={icon} size={17} />{label}
          </button>
        ))}
      </div>
    </div>
  );
}

function BlockDayModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(isoDate(0));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ clashes: number } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await ksApi.addBlockout(date, reason.trim());
      setResult({ clashes: res.clashing_bookings.length });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Could not block that day.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KSModal onClose={onClose}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-extrabold tracking-tight text-slate-900">Block out a day</h3>
        <button onClick={onClose} aria-label="Close"
          className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
          <Icon name="close" size={20} />
        </button>
      </div>

      {result ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-800">
            {shortDay(date)} is blocked — no new bookings can land on it.
          </div>
          {result.clashes > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <span className="font-bold">{result.clashes} session{result.clashes === 1 ? ' is' : 's are'} already
              booked that day</span> — they're highlighted on the calendar so you can rearrange or cancel them.
            </div>
          )}
          <KSButton onClick={onClose} className="w-full">Done</KSButton>
        </div>
      ) : (
        <div className="space-y-3.5">
          <p className="text-sm text-slate-600">
            Holiday, sick day or personal time — parents won't be offered any slot on this date.
          </p>
          <div>
            <KSLabel>Date</KSLabel>
            <KSInput type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <KSLabel hint="(optional)">Reason</KSLabel>
            <KSInput value={reason} onChange={e => setReason(e.target.value)}
              placeholder="Holiday, sick, personal…" />
          </div>
          {error && <KSAlert>{error}</KSAlert>}
          <KSButton onClick={submit} loading={busy} className="w-full">Block this day</KSButton>
        </div>
      )}
    </KSModal>
  );
}

function MiniCalendar({ anchor, monthData, weekStart, onNavMonth, onPickDay }: {
  anchor: string;
  monthData: KsSchedule | null;
  weekStart?: string;
  onNavMonth: (dir: number) => void;
  onPickDay: (iso: string) => void;
}) {
  const first = new Date(`${anchor}T12:00:00`);
  const label = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const gridStart = mondayOf(anchor);
  const cells = Array.from({ length: 42 }, (_, i) => addDaysISO(gridStart, i));
  const byDate = new Map((monthData?.days || []).map(d => [d.date, d]));
  const today = isoDate(0);
  const inWeek = (iso: string) =>
    !!weekStart && iso >= weekStart && iso <= addDaysISO(weekStart, 6);
  return (
    <KSCard className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <button onClick={() => onNavMonth(-1)} aria-label="Previous month"
          className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
          <Icon name="chevron_left" size={17} />
        </button>
        <div className="text-sm font-extrabold text-slate-800">{label}</div>
        <button onClick={() => onNavMonth(1)} aria-label="Next month"
          className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
          <Icon name="chevron_right" size={17} />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] font-bold uppercase text-slate-400">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i} className="py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map(iso => {
          const day = byDate.get(iso);
          const sessions = day?.sessions.filter(s => s.status !== 'cancelled').length || 0;
          const inMonth = iso.slice(0, 7) === anchor.slice(0, 7);
          return (
            <button key={iso} onClick={() => onPickDay(iso)}
              className={`relative mx-auto grid h-8 w-8 place-items-center rounded-lg text-xs font-semibold transition-colors
                ${iso === today ? 'bg-[#FF6B00] text-white'
                  : inWeek(iso) ? 'bg-orange-100 text-slate-900'
                  : inMonth ? 'text-slate-700 hover:bg-slate-100' : 'text-slate-300 hover:bg-slate-50'}
                ${day?.blockout ? 'line-through decoration-red-400 decoration-2' : ''}`}>
              {Number(iso.slice(8, 10))}
              {sessions > 0 && (
                <span className={`absolute bottom-0.5 h-1 w-1 rounded-full
                  ${iso === today ? 'bg-white' : 'bg-[#FF6B00]'}`} />
              )}
            </button>
          );
        })}
      </div>
    </KSCard>
  );
}

function MonthView({ anchor, monthData, loading, onPickDay }: {
  anchor: string;
  monthData: KsSchedule | null;
  loading: boolean;
  onPickDay: (iso: string) => void;
}) {
  if (loading || !monthData) return <Skeleton className="h-[560px] w-full" />;
  const gridStart = mondayOf(anchor);
  const weeks = Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => addDaysISO(gridStart, w * 7 + i)));
  const byDate = new Map(monthData.days.map(d => [d.date, d]));
  const today = isoDate(0);
  return (
    <KSCard className="overflow-hidden">
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <div className="grid border-b border-slate-200 text-center text-[11px] font-bold uppercase tracking-wider text-slate-400"
            style={{ gridTemplateColumns: '34px repeat(7, minmax(0, 1fr))' }}>
            <div className="py-2">Wk</div>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
              <div key={d} className="border-l border-slate-100 py-2">{d}</div>
            ))}
          </div>
          {weeks.map(week => (
            <div key={week[0]} className="grid border-b border-slate-100 last:border-0"
              style={{ gridTemplateColumns: '34px repeat(7, minmax(0, 1fr))' }}>
              <div className="grid place-items-center text-[10px] font-bold text-slate-300">
                {isoWeek(week[0])}
              </div>
              {week.map(iso => {
                const day = byDate.get(iso);
                const live = (day?.sessions || []).filter(s => s.status !== 'cancelled');
                const inMonth = iso.slice(0, 7) === anchor.slice(0, 7);
                return (
                  <button key={iso} onClick={() => onPickDay(iso)}
                    className={`relative min-h-[92px] border-l border-slate-100 p-1.5 text-left align-top transition-colors
                      ${inMonth ? 'hover:bg-orange-50/60' : 'bg-slate-50/60 hover:bg-slate-100/60'}`}>
                    {day?.blockout && (
                      <span className="pointer-events-none absolute inset-0"
                        style={{ background: 'repeating-linear-gradient(45deg, rgba(239,68,68,0.05) 0 8px, rgba(239,68,68,0.13) 8px 16px)' }} />
                    )}
                    <span className="relative flex items-center justify-between">
                      <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-extrabold
                        ${iso === today ? 'bg-[#FF6B00] text-white'
                          : inMonth ? 'text-slate-800' : 'text-slate-300'}`}>
                        {Number(iso.slice(8, 10))}
                      </span>
                      <span className="text-xs">{weatherFor(iso)}</span>
                    </span>
                    <span className="relative mt-1 block space-y-0.5">
                      {live.slice(0, 2).map(s => (
                        <span key={s.id}
                          className={`block truncate rounded px-1 py-px text-[10px] font-bold leading-tight
                            ${TYPE_STYLE[typeOfService(s.service_key, s.service_name)].chip}
                            ${TYPE_STYLE[typeOfService(s.service_key, s.service_name)].text}`}>
                          {s.start_time} {s.child_name.split(' ')[0]}
                        </span>
                      ))}
                      {live.length > 2 && (
                        <span className="block text-[10px] font-bold text-slate-400">
                          +{live.length - 2} more
                        </span>
                      )}
                      {live.length > 0 && (
                        <span className="block text-[9px] font-semibold text-slate-400">
                          {live.length} session{live.length === 1 ? '' : 's'}
                        </span>
                      )}
                      {day?.blockout && (
                        <span className="block truncate text-[10px] font-bold text-red-500">
                          ⛔ {day.blockout.reason || 'Blocked'}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </KSCard>
  );
}

function CalendarTab({ schedule, loading, students, skills, onToggle, afterMark,
  onShiftWeek, onGoWeek, onToday, onViewStudent, refresh }: {
  schedule: KsSchedule | null;
  loading: boolean;
  students: KsStudent[];
  skills: KsSkill[];
  onToggle: (b: KsBooking) => Promise<void>;
  afterMark: () => void;
  onShiftWeek: (days: number) => void;
  onGoWeek: (iso: string) => void;
  onToday: () => void;
  onViewStudent: (name: string) => void;
  refresh: () => void;
}) {
  const [view, setView] = useState<'week' | 'month'>('week');
  const [monthAnchor, setMonthAnchor] = useState(() => `${isoDate(0).slice(0, 7)}-01`);
  const [monthData, setMonthData] = useState<KsSchedule | null>(null);
  const [monthLoading, setMonthLoading] = useState(false);
  const [services, setServices] = useState<KsService[]>([]);
  const [addAt, setAddAt] = useState<{ date: string; time: string } | null>(null);
  const [editing, setEditing] = useState<KsBooking | null>(null);
  const [selected, setSelected] = useState<CalEvent | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; ev: CalEvent } | null>(null);
  const [blocking, setBlocking] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    ksApi.info().then(r => setServices(r.services.filter(s => s.bookable))).catch(() => { /* selector empty */ });
  }, []);

  // One 42-day fetch feeds both the mini calendar and the month view.
  const loadMonth = useCallback(() => {
    setMonthLoading(true);
    ksApi.schedule(mondayOf(monthAnchor), 42)
      .then(setMonthData)
      .catch(() => setMonthData(null))
      .finally(() => setMonthLoading(false));
  }, [monthAnchor]);
  useEffect(loadMonth, [loadMonth]);

  // The mini calendar follows the visible week when the coach navigates.
  const weekStart = schedule?.week_start;
  useEffect(() => {
    if (weekStart) setMonthAnchor(a => {
      const m = `${weekStart.slice(0, 7)}-01`;
      return m === a ? a : m;
    });
  }, [weekStart]);

  const refreshAll = useCallback(() => { refresh(); loadMonth(); }, [refresh, loadMonth]);

  // Keep an open detail popup in step after mark-done toggles.
  const toggle = async (b: KsBooking) => {
    await onToggle(b);
    setSelected(sel => (sel?.booking?.ref === b.ref
      ? { ...sel, booking: { ...sel.booking!, status: b.status === 'completed' ? 'confirmed' : 'completed' } }
      : sel));
    loadMonth();
  };

  const hours = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START / 60 + i);
  const nowMins = new Date(nowMs).getHours() * 60 + new Date(nowMs).getMinutes();

  const days = useMemo(() => {
    if (!schedule) return [];
    // Demo sessions are a fallback for an empty diary only. The moment the
    // coach has a single real booking anywhere in the loaded window, drop the
    // fake children entirely — same "samples only until real data" rule the
    // Students/Finance/Route/Leads tabs follow.
    const anyReal = schedule.days.some(d => d.sessions.length > 0);
    return schedule.days.map(d => {
      const real: CalEvent[] = d.sessions.map(b => ({
        key: `b-${b.id}`,
        date: d.date,
        start: b.start_time,
        end: b.end_time,
        title: b.child_name,
        service: b.service_name,
        type: typeOfService(b.service_key, b.service_name),
        booking: b,
      }));
      const blocks: CalEvent[] = d.blocks.map(bl => ({
        key: `bl-${bl.id}`,
        date: d.date,
        start: bl.start_time === '00:00' ? '08:00' : bl.start_time,
        end: bl.end_time === '23:59' ? '20:00' : bl.end_time,
        title: 'Blocked out',
        service: bl.reason || '',
        type: 'block' as const,
        block: bl,
      }));
      return { ...d, layout: withLanes([...real, ...blocks, ...(anyReal ? [] : demoEventsFor(d.date))]) };
    });
  }, [schedule]);

  const nextSession = useMemo(() => {
    let best: KsBooking | null = null;
    for (const d of schedule?.days || []) {
      for (const s of d.sessions) {
        if (s.status === 'confirmed' && s.starts_at * 1000 > nowMs
          && (!best || s.starts_at < best.starts_at)) best = s;
      }
    }
    return best;
  }, [schedule, nowMs]);

  const clickSlot = (e: React.MouseEvent<HTMLDivElement>, d: (typeof days)[number]) => {
    if (d.blockout) return;                    // no new bookings on a blocked day
    const rect = e.currentTarget.getBoundingClientRect();
    const mins = DAY_START + Math.floor(((e.clientY - rect.top) / HOUR_H) * 2) * 30;
    setAddAt({ date: d.date, time: minsToTime(Math.max(DAY_START, Math.min(DAY_END - 30, mins))) });
  };

  const ctxAction = (a: 'edit' | 'complete' | 'cancel' | 'student') => {
    const b = ctx?.ev.booking;
    if (!b) return;
    if (a === 'edit') setEditing(b);
    else if (a === 'complete') toggle(b);
    else if (a === 'student') onViewStudent(b.child_name);
    else if (a === 'cancel'
      && window.confirm(`Cancel ${b.child_name}'s session on ${shortDay(b.date)} at ${b.start_time}? `
        + `The parent is not texted automatically.`)) {
      ksApi.updateBooking(b.id, { status: 'cancelled' }).then(refreshAll).catch(() => { /* refresh shows truth */ });
    }
  };

  const pickDay = (iso: string) => { onGoWeek(mondayOf(iso)); setView('week'); };

  if (loading || !schedule) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-10 w-64" />
        </div>
        <Skeleton className="h-[560px] w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button onClick={() => (view === 'week' ? onShiftWeek(-7)
            : setMonthAnchor(a => addDaysISO(a, -1).slice(0, 8) + '01'))}
            aria-label="Previous"
            className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-600 transition-colors hover:border-[#FF6B00] hover:text-[#FF6B00]">
            <Icon name="chevron_left" size={20} />
          </button>
          <button onClick={() => (view === 'week' ? onShiftWeek(7)
            : setMonthAnchor(a => addDaysISO(a, 32).slice(0, 8) + '01'))}
            aria-label="Next"
            className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-600 transition-colors hover:border-[#FF6B00] hover:text-[#FF6B00]">
            <Icon name="chevron_right" size={20} />
          </button>
          <KSButton tone="secondary" className="ml-1 py-2"
            onClick={() => { onToday(); setMonthAnchor(`${isoDate(0).slice(0, 7)}-01`); setView('week'); }}>
            Today
          </KSButton>
        </div>

        <div className="text-sm font-extrabold text-slate-800">
          {view === 'week'
            ? <>Wk {isoWeek(schedule.week_start)} · {shortDay(schedule.week_start)} – {shortDay(schedule.week_end)}</>
            : new Date(`${monthAnchor}T12:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}
        </div>

        {/* View toggle */}
        <div className="flex overflow-hidden rounded-xl border border-slate-200 bg-white">
          {(['week', 'month'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3.5 py-2 text-xs font-bold uppercase tracking-wide transition-colors
                ${view === v ? 'bg-[#FF6B00] text-white' : 'text-slate-500 hover:text-slate-800'}`}>
              {v}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Next-session countdown */}
          <span className="hidden items-center gap-1.5 rounded-xl bg-orange-50 px-3 py-2 text-xs font-bold text-[#C24F00] sm:flex">
            <Icon name="timer" size={15} />
            {nextSession
              ? `Next session in ${untilLabel(nextSession.starts_at * 1000, nowMs)}`
              : 'No upcoming sessions this week'}
          </span>
          <KSButton tone="secondary" className="py-2" onClick={() => setBlocking(true)}>
            <Icon name="event_busy" size={17} />Block day
          </KSButton>
          <KSButton className="py-2" onClick={() => setAddAt({ date: isoDate(0), time: '16:00' })}>
            <Icon name="add" size={17} />Add booking
          </KSButton>
        </div>
      </div>

      {/* Colour legend */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold text-slate-500">
        {(['oneone', 'group', 'camp', 'block'] as SessionType[]).map(t => (
          <span key={t} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: TYPE_STYLE[t].dot }} />
            {TYPE_STYLE[t].label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm"
            style={{ background: 'repeating-linear-gradient(45deg, rgba(239,68,68,0.25) 0 2px, rgba(239,68,68,0.5) 2px 4px)' }} />
          Day off
        </span>
      </div>

      {view === 'month' ? (
        <MonthView anchor={monthAnchor} monthData={monthData} loading={monthLoading}
          onPickDay={pickDay} />
      ) : (
        <div className="flex items-start gap-4">
          {/* Mini calendar rail */}
          <div className="hidden w-60 shrink-0 space-y-3 xl:block">
            <MiniCalendar anchor={monthAnchor} monthData={monthData}
              weekStart={schedule.week_start}
              onNavMonth={dir => setMonthAnchor(a => {
                const d = new Date(`${a}T12:00:00`);
                d.setMonth(d.getMonth() + dir);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
              })}
              onPickDay={pickDay} />
            <p className="px-1 text-[11px] leading-relaxed text-slate-400">
              Dots mark days with sessions; a struck-through date is a day off.
              Click any empty slot on the grid to book it.
            </p>
          </div>

          {/* Week grid */}
          <KSCard className="min-w-0 flex-1 overflow-hidden">
            <div className="overflow-x-auto">
              <div className="min-w-[860px]">
                {/* Day headers */}
                <div className="grid border-b border-slate-200"
                  style={{ gridTemplateColumns: '56px repeat(7, minmax(0, 1fr))' }}>
                  <div />
                  {days.map(d => {
                    const dt = new Date(`${d.date}T12:00:00`);
                    const liveCount = d.sessions.filter(s => s.status !== 'cancelled').length;
                    return (
                      <div key={d.date}
                        className={`border-l border-slate-100 px-2 py-2 text-center
                          ${d.blockout ? 'bg-red-50' : d.is_today ? 'bg-orange-50' : ''}`}>
                        <div className={`flex items-center justify-center gap-1 text-[11px] font-bold uppercase tracking-wider
                          ${d.is_today ? 'text-[#FF6B00]' : 'text-slate-400'}`}>
                          {dt.toLocaleDateString('en-GB', { weekday: 'short' })}
                          <span aria-hidden>{weatherFor(d.date)}</span>
                        </div>
                        <div className={`mx-auto mt-0.5 grid h-7 w-7 place-items-center rounded-full text-sm font-extrabold
                          ${d.is_today ? 'bg-[#FF6B00] text-white' : 'text-slate-800'}`}>
                          {dt.getDate()}
                        </div>
                        <div className={`mt-0.5 truncate text-[10px] font-semibold
                          ${d.blockout ? 'text-red-500' : 'text-slate-400'}`}>
                          {d.blockout
                            ? `⛔ ${d.blockout.reason || 'Day off'}`
                            : liveCount ? `${liveCount} session${liveCount === 1 ? '' : 's'}` : '—'}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Time grid */}
                <div className="grid" style={{ gridTemplateColumns: '56px repeat(7, minmax(0, 1fr))' }}>
                  {/* Hour labels */}
                  <div className="relative" style={{ height: GRID_H }}>
                    {hours.map(h => (
                      <div key={h} className="absolute right-2 -translate-y-1/2 text-[11px] font-semibold tabular-nums text-slate-400"
                        style={{ top: (h - DAY_START / 60) * HOUR_H }}>
                        {String(h).padStart(2, '0')}:00
                      </div>
                    ))}
                  </div>

                  {days.map(d => (
                    <div key={d.date}
                      onClick={e => clickSlot(e, d)}
                      title={d.blockout ? `Blocked out${d.blockout.reason ? ` — ${d.blockout.reason}` : ''}`
                        : 'Click a slot to add a booking'}
                      className={`relative border-l border-slate-100
                        ${d.blockout ? 'cursor-not-allowed' : 'cursor-pointer'}
                        ${d.is_today ? 'bg-orange-50/40' : ''}`}
                      style={{ height: GRID_H }}>
                      {/* Empty slots as subtle dashed hour lines */}
                      {hours.slice(0, -1).map(h => (
                        <div key={h} className="absolute inset-x-0 border-t border-dashed border-slate-200/80"
                          style={{ top: (h - DAY_START / 60) * HOUR_H }} />
                      ))}
                      {/* Day-off diagonal stripes */}
                      {d.blockout && (
                        <div className="pointer-events-none absolute inset-0 z-[4]"
                          style={{ background: 'repeating-linear-gradient(45deg, rgba(239,68,68,0.06) 0 10px, rgba(239,68,68,0.14) 10px 20px)' }} />
                      )}
                      {/* Current-time line */}
                      {d.is_today && nowMins > DAY_START && nowMins < DAY_END && (
                        <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
                          style={{ top: ((nowMins - DAY_START) / 60) * HOUR_H }}>
                          <span className="-ml-1 h-2 w-2 rounded-full bg-[#FF6B00]" />
                          <span className="h-px flex-1 bg-[#FF6B00]" />
                        </div>
                      )}
                      {d.layout.placed.map(({ ev, lane }) => (
                        <EventBlock key={ev.key} ev={ev} lane={lane}
                          laneCount={d.layout.laneCount} dayBlocked={!!d.blockout}
                          onOpen={setSelected}
                          onCtx={(cev, x, y) => setCtx({ x, y, ev: cev })} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </KSCard>
        </div>
      )}

      <p className="text-xs text-slate-400">
        Click an empty slot to book it · click a session for details · right-click (or long-press
        with a mouse alternative) a session for quick actions. Soft-coloured sessions are seeded
        examples and open read-only.
      </p>

      {/* ── Popups ─────────────────────────────────────────────────── */}
      {selected && (
        <EventModal ev={selected} skills={skills}
          onClose={() => setSelected(null)}
          onToggle={toggle} onSaved={afterMark}
          onEdit={b => { setSelected(null); setEditing(b); }} />
      )}
      {addAt && (
        <AddBookingModal at={addAt} students={students}
          coaches={schedule.coaches || [{ id: schedule.coach.id, name: schedule.coach.name }]}
          services={services} defaultCoachId={schedule.coach.id}
          onClose={() => setAddAt(null)} onDone={refreshAll} />
      )}
      {editing && (
        <EditBookingModal b={editing} students={students}
          coaches={schedule.coaches || [{ id: schedule.coach.id, name: schedule.coach.name }]}
          onClose={() => setEditing(null)} onDone={refreshAll} />
      )}
      {ctx && (
        <CalContextMenu x={ctx.x} y={ctx.y} ev={ctx.ev}
          onClose={() => setCtx(null)} onAction={ctxAction} />
      )}
      {blocking && <BlockDayModal onClose={() => setBlocking(false)} onDone={refreshAll} />}
    </div>
  );
}

function EventModal({ ev, skills, onClose, onToggle, onSaved, onEdit }: {
  ev: CalEvent;
  skills: KsSkill[];
  onClose: () => void;
  onToggle: (b: KsBooking) => Promise<void>;
  onSaved: () => void;
  onEdit?: (b: KsBooking) => void;
}) {
  const st = TYPE_STYLE[ev.type];
  return (
    <KSModal onClose={onClose} wide={!!ev.booking}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="h-3 w-3 rounded-full" style={{ background: st.dot }} />
            <h3 className="text-lg font-extrabold tracking-tight text-slate-900">{ev.title}</h3>
            {ev.demo && <KSPill tone="slate">Demo session</KSPill>}
            {ev.booking?.series_ref && <KSPill tone="blue">↻ Weekly series</KSPill>}
          </div>
          <div className="mt-1 text-sm text-slate-600">
            {dayName(ev.date)} · <span className="font-mono font-bold">{ev.start}–{ev.end}</span>
            {ev.service ? ` · ${ev.service}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {ev.booking && !ev.demo && onEdit && ev.booking.status !== 'cancelled' && (
            <KSButton tone="secondary" className="px-3 py-1.5 text-xs"
              onClick={() => onEdit(ev.booking!)}>
              <Icon name="edit_calendar" size={15} />Reschedule
            </KSButton>
          )}
          <button onClick={onClose} aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
            <Icon name="close" size={20} />
          </button>
        </div>
      </div>

      {ev.booking ? (
        <SessionRow b={ev.booking} onToggle={onToggle} showContact skills={skills} onSaved={onSaved} />
      ) : ev.type === 'block' ? (
        <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
          This time is blocked out{ev.service ? ` — ${ev.service}` : ''}. Parents aren't offered
          these slots. Manage blocks under <span className="font-bold">Settings</span>.
        </p>
      ) : (
        <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
          This is a seeded example session showing how the calendar will look as bookings come in.
          Real bookings open with parent contact details, the attendance register and progress notes.
        </p>
      )}
    </KSModal>
  );
}

// ── Route map ───────────────────────────────────────────────────────────
// Leaflet ships vendored locally (public/vendor/leaflet, served at
// /vendor/leaflet) — no npm dep, no API key, no CDN dependency — and is only
// fetched the first time the Route tab opens. When a booking has no address
// the route falls back to seeded Chester-area sample data.
let leafletLoader: Promise<any> | null = null;
function loadLeaflet(): Promise<any> {
  const w = window as any;
  if (w.L?.map) return Promise.resolve(w.L);
  if (leafletLoader) return leafletLoader;
  leafletLoader = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = '/vendor/leaflet/leaflet.js';
    s.onload = () => resolve((window as any).L);
    s.onerror = () => { leafletLoader = null; reject(new Error('Leaflet failed to load')); };
    document.head.appendChild(s);
  });
  return leafletLoader;
}

interface RouteVenue { venue: string; postcode: string; coords: [number, number] }

const ROUTE_HOME: RouteVenue = {
  venue: 'Home base', postcode: 'CH2 1BX', coords: [53.2040, -2.8850],
};

// Approximate coordinates for the sample postcodes — close enough to draw an
// honest-looking Chester route, not for navigation (that's the Maps link).
const VENUES: Record<string, RouteVenue> = {
  'CH1 4LF': { venue: 'King George V Sports Hub', postcode: 'CH1 4LF', coords: [53.2005, -2.9060] },
  'CH1 2HT': { venue: 'Northgate Arena', postcode: 'CH1 2HT', coords: [53.1955, -2.8890] },
  'CH2 3NY': { venue: 'Upton Pavilion, Wealstone Lane', postcode: 'CH2 3NY', coords: [53.2090, -2.8700] },
  'CH3 5UH': { venue: 'Boughton Heath Astro', postcode: 'CH3 5UH', coords: [53.1780, -2.8560] },
  'CH4 8AB': { venue: 'Westminster Park Courts', postcode: 'CH4 8AB', coords: [53.1690, -2.9170] },
};

interface RouteStopSeed { start: string; mins: number; type: SessionType; child: string; pc: keyof typeof VENUES }

// One believable coaching day per weekday, reusing the sample students.
const ROUTE_WEEK: Record<number, RouteStopSeed[]> = {
  1: [
    { start: '15:30', mins: 60, type: 'oneone', child: 'Alfie Thompson', pc: 'CH2 3NY' },
    { start: '16:45', mins: 45, type: 'oneone', child: 'Charlie Whitfield', pc: 'CH1 2HT' },
    { start: '17:45', mins: 60, type: 'group', child: 'Small group · 4 players', pc: 'CH3 5UH' },
    { start: '19:00', mins: 60, type: 'oneone', child: 'Ethan Hughes', pc: 'CH4 8AB' },
  ],
  2: [
    { start: '16:00', mins: 60, type: 'oneone', child: 'Maya Patel', pc: 'CH1 4LF' },
    { start: '17:15', mins: 45, type: 'oneone', child: 'Oliver Bennett', pc: 'CH1 2HT' },
    { start: '18:15', mins: 90, type: 'group', child: 'Small group · 5 players', pc: 'CH2 3NY' },
  ],
  3: [
    { start: '15:45', mins: 45, type: 'oneone', child: 'Poppy Sanders', pc: 'CH4 8AB' },
    { start: '16:45', mins: 60, type: 'group', child: 'Small group · 5 players', pc: 'CH3 5UH' },
    { start: '18:00', mins: 60, type: 'oneone', child: 'Ethan Hughes', pc: 'CH1 2HT' },
    { start: '19:15', mins: 45, type: 'oneone', child: 'Grace Ashworth', pc: 'CH1 4LF' },
  ],
  4: [
    { start: '16:00', mins: 60, type: 'oneone', child: 'Freya Collins', pc: 'CH3 5UH' },
    { start: '17:15', mins: 60, type: 'oneone', child: 'Isla McGregor', pc: 'CH2 3NY' },
    { start: '18:30', mins: 60, type: 'group', child: 'Junior team · 8 players', pc: 'CH1 4LF' },
  ],
  5: [
    { start: '15:30', mins: 45, type: 'oneone', child: 'Charlie Whitfield', pc: 'CH1 2HT' },
    { start: '16:30', mins: 60, type: 'oneone', child: 'Alfie Thompson', pc: 'CH2 3NY' },
    { start: '17:45', mins: 60, type: 'oneone', child: 'Noah Barker', pc: 'CH1 4LF' },
    { start: '19:00', mins: 45, type: 'oneone', child: 'Grace Ashworth', pc: 'CH4 8AB' },
  ],
  6: [
    { start: '09:00', mins: 180, type: 'camp', child: 'Holiday camp · 12 players', pc: 'CH1 4LF' },
    { start: '13:00', mins: 90, type: 'group', child: 'Small group tennis', pc: 'CH4 8AB' },
    { start: '15:00', mins: 60, type: 'oneone', child: 'Freya Collins', pc: 'CH3 5UH' },
    { start: '16:30', mins: 45, type: 'oneone', child: 'Grace Ashworth', pc: 'CH2 3NY' },
    { start: '17:30', mins: 60, type: 'oneone', child: 'Noah Barker', pc: 'CH1 2HT' },
  ],
  0: [
    { start: '10:00', mins: 60, type: 'oneone', child: 'Noah Barker', pc: 'CH1 2HT' },
    { start: '11:30', mins: 60, type: 'oneone', child: 'Maya Patel', pc: 'CH1 4LF' },
  ],
};

interface RouteStop {
  n: number; child: string; type: SessionType; start: string; end: string; mins: number;
  venue: string; postcode: string; coords: [number, number];
  driveMins: number; driveKm: number; // from the previous point (home for stop 1)
}

const kmBetween = (a: [number, number], b: [number, number]) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Urban driving guess: ~26 km/h door to door, plus a parking buffer.
const driveMins = (km: number) => Math.max(4, Math.round((km / 26) * 60) + 3);

function routeForDate(dateISO: string): RouteStop[] {
  const weekday = new Date(`${dateISO}T12:00:00`).getDay();
  const seeds = [...(ROUTE_WEEK[weekday] || [])].sort((a, b) => toMins(a.start) - toMins(b.start));
  let prev = ROUTE_HOME.coords;
  return seeds.map((s, i) => {
    const v = VENUES[s.pc];
    const km = kmBetween(prev, v.coords);
    prev = v.coords;
    return {
      n: i + 1, child: s.child, type: s.type, start: s.start,
      end: minsToTime(toMins(s.start) + s.mins), mins: s.mins,
      venue: v.venue, postcode: v.postcode, coords: v.coords,
      driveMins: driveMins(km), driveKm: Math.round(km * 10) / 10,
    };
  });
}

const gmapsDir = (postcode: string) =>
  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(postcode)}`;

// Turn a real day's bookings into the same RouteStop shape the map and list
// already render. Stops the backend couldn't geocode (no postcode on file, or
// the lookup failed) carry no coords, so they're handed back separately for a
// "not on the map" note rather than dropped silently.
function realToStops(route: KsRoute): { stops: RouteStop[]; unmapped: KsRouteStop[] } {
  const home: [number, number] = [route.home.lat, route.home.lng];
  const unmapped = route.stops.filter(s => s.lat == null || s.lng == null);
  let prev = home;
  const stops = route.stops
    .filter(s => s.lat != null && s.lng != null)
    .map((s, i) => {
      const coords: [number, number] = [s.lat as number, s.lng as number];
      const km = kmBetween(prev, coords);
      prev = coords;
      return {
        n: i + 1, child: s.child_name, type: typeOfService('', s.service_name),
        start: s.start_time, end: s.end_time,
        mins: Math.max(0, toMins(s.end_time) - toMins(s.start_time)),
        venue: s.address || s.postcode, postcode: s.postcode, coords,
        driveMins: driveMins(km), driveKm: Math.round(km * 10) / 10,
      };
    });
  return { stops, unmapped };
}

function RouteTab() {
  const [dateISO, setDateISO] = useState(isoDate(0));
  const [mapReady, setMapReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const mapDiv = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => isoDate(i)), []);

  // Real bookings for the selected day. Until they exist (or if the fetch
  // fails), the tab falls back to the seeded sample route, badged as such.
  const [route, setRoute] = useState<KsRoute | null>(null);
  useEffect(() => {
    let dead = false;
    ksApi.route(dateISO)
      .then(r => { if (!dead) setRoute(r); })
      .catch(() => { if (!dead) setRoute(null); });
    return () => { dead = true; };
  }, [dateISO]);

  const real = !!route && route.date === dateISO && route.stops.length > 0;
  const isSample = !real;
  const { stops, unmapped } = useMemo(
    () => (real
      ? realToStops(route as KsRoute)
      : { stops: routeForDate(dateISO), unmapped: [] as KsRouteStop[] }),
    [real, route, dateISO]);

  const isToday = dateISO === isoDate(0);
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  const nextStop = isToday ? stops.find(s => toMins(s.end) > nowMins) : stops[0];
  const totalDrive = stops.reduce((a, s) => a + s.driveMins, 0);
  const locations = new Set(stops.map(s => s.postcode)).size;
  const finish = stops.length ? stops[stops.length - 1].end : null;

  // Fetch the library once; tear the map down when the tab unmounts.
  const [lib, setLib] = useState<any>(null);
  useEffect(() => {
    let dead = false;
    loadLeaflet()
      .then(L => { if (!dead) setLib(L); })
      .catch(() => { if (!dead) setMapFailed(true); });
    return () => {
      dead = true;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []);

  // Create the map lazily (the container only renders on days with stops)
  // and redraw pins + polyline whenever the selected day changes.
  useEffect(() => {
    const L = lib;
    if (stops.length === 0) {
      // The container unmounts on empty days — drop the map so it can be
      // recreated cleanly against the fresh node when stops return.
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        layerRef.current = null;
        setMapReady(false);
      }
      return;
    }
    if (!L || !mapDiv.current) return;
    if (!mapRef.current) {
      const map = L.map(mapDiv.current, { scrollWheelZoom: false, zoomControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      setMapReady(true);
    }
    const lg = layerRef.current;
    lg.clearLayers();

    const pin = (html: string, colour: string, size = 30) => L.divIcon({
      className: '',
      html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${colour};
        color:#fff;display:flex;align-items:center;justify-content:center;font:800 13px/1 Inter,sans-serif;
        border:3px solid #fff;box-shadow:0 2px 8px rgba(15,23,42,0.4)">${html}</div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2 - 2],
    });

    L.marker(ROUTE_HOME.coords, { icon: pin('⌂', '#16A34A', 32) })
      .bindPopup(`<b>Start / finish</b><br>${ROUTE_HOME.venue} · ${ROUTE_HOME.postcode}`)
      .addTo(lg);

    stops.forEach(s => {
      L.marker(s.coords, { icon: pin(String(s.n), TYPE_STYLE[s.type].dot) })
        .bindPopup(
          `<b>${s.child}</b><br>${s.start}–${s.end} · ${TYPE_STYLE[s.type].label}<br>` +
          `${s.venue}<br>${s.postcode}<br>` +
          `<a href="${gmapsDir(s.postcode)}" target="_blank" rel="noreferrer">Directions ↗</a>`)
        .addTo(lg);
    });

    const pts = [ROUTE_HOME.coords, ...stops.map(s => s.coords)];
    if (pts.length > 1) {
      L.polyline(pts, { color: ORANGE, weight: 3, opacity: 0.75, dashArray: '7 9' }).addTo(lg);
    }
    mapRef.current.fitBounds(L.latLngBounds(pts).pad(0.25));
    // The container can settle a frame after the tab animates in.
    setTimeout(() => mapRef.current?.invalidateSize(), 150);
  }, [lib, stops]);

  const dayLabel = (iso: string, i: number) => {
    if (i === 0) return 'Today';
    if (i === 1) return 'Tomorrow';
    return new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short' });
  };

  return (
    <div className="space-y-5">
      <SectionHead sample={isSample}>Route</SectionHead>

      {/* Day selector */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {days.map((d, i) => {
          const active = d === dateISO;
          const dt = new Date(`${d}T12:00:00`);
          return (
            <button key={d} onClick={() => setDateISO(d)}
              className={`shrink-0 rounded-xl border px-3.5 py-2 text-center transition-all duration-200
                ${active
                  ? 'border-[#FF6B00] bg-[#FF6B00] text-white shadow-md shadow-orange-200'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-[#FF6B00]/50 hover:text-slate-900'}`}>
              <div className={`text-[11px] font-bold uppercase tracking-wider ${active ? 'text-white/80' : 'text-slate-400'}`}>
                {dayLabel(d, i)}
              </div>
              <div className="text-sm font-extrabold tabular-nums">
                {dt.getDate()} {dt.toLocaleDateString('en-GB', { month: 'short' })}
              </div>
            </button>
          );
        })}
      </div>

      <div className="space-y-5">
        {/* At a glance — keyed on the day so the tiles animate on every
            switch; the map card stays un-keyed so Leaflet's DOM survives. */}
        <div key={`stats-${dateISO}`} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard icon="sports" label="Sessions" value={stops.length}
            sub={`covering ${locations} location${locations === 1 ? '' : 's'}`} />
          <StatCard icon="directions_car" label="Driving" value={`${totalDrive} min`}
            accent="#2563EB" delay={60} sub="between all stops" />
          <StatCard icon="pin_drop" label="Next stop" accent="#16A34A" delay={120}
            value={nextStop ? nextStop.postcode : '—'}
            sub={nextStop ? `${nextStop.driveMins} min drive · ${nextStop.start}` : 'day complete'} />
          <StatCard icon="sports_score" label="Finish" value={finish || '—'}
            accent="#A78BFA" delay={180} sub={finish ? 'last session ends' : 'no sessions'} />
        </div>

        {unmapped.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
            <span className="font-bold">{unmapped.length} session{unmapped.length === 1 ? '' : 's'}</span>{' '}
            {unmapped.length === 1 ? "isn't" : "aren't"} on the map — add the student's postcode to
            place {unmapped.length === 1 ? 'it' : 'them'}:{' '}
            {unmapped.map(u => `${u.start_time} ${u.child_name}`).join(', ')}.
          </div>
        )}

        {stops.length === 0 ? (
          <EmptyNote icon="route"
            title={unmapped.length > 0 ? 'Nothing to map yet' : 'No sessions this day'}
            hint={unmapped.length > 0
              ? "Today's sessions have no postcode on file — add one to each student to build the route."
              : "Pick another day, or enjoy the day off — you've earned it."} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-5">
            {/* Map — ~60% on desktop */}
            <KSCard className="overflow-hidden lg:col-span-3">
              {mapFailed ? (
                <div className="flex h-[340px] flex-col items-center justify-center gap-2 p-6 text-center lg:h-[520px]">
                  <Icon name="wifi_off" size={28} className="text-slate-300" />
                  <div className="font-bold text-slate-700">Map couldn't load</div>
                  <p className="max-w-xs text-sm text-slate-500">
                    The map tiles need an internet connection. The route list still works —
                    tap a postcode to open directions.
                  </p>
                </div>
              ) : (
                <div className="relative">
                  <div ref={mapDiv} className="z-0 h-[340px] w-full lg:h-[520px]" />
                  {!mapReady && (
                    <div className="absolute inset-0 grid place-items-center bg-slate-50">
                      <div className="flex items-center gap-2 text-slate-400"><Spinner /> Loading map…</div>
                    </div>
                  )}
                </div>
              )}
            </KSCard>

            {/* Route list — ~40% on desktop, animated per day switch */}
            <KSCard key={`list-${dateISO}`} className="animate-fadeInUp p-4 lg:col-span-2">
              <div className="mb-3 flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-green-100 text-green-700">
                  <Icon name="home" size={17} />
                </span>
                <div>
                  <div className="text-sm font-extrabold text-slate-900">Start from home</div>
                  <div className="text-xs text-slate-500">{ROUTE_HOME.postcode}</div>
                </div>
              </div>

              <div className="space-y-0">
                {stops.map((s, i) => (
                  <div key={s.n}>
                    {/* Drive leg */}
                    <div className="ml-4 flex items-center gap-2 border-l-2 border-dashed border-slate-200 py-1.5 pl-4 text-[11px] font-semibold text-slate-400">
                      <Icon name="directions_car" size={13} />
                      {s.driveMins} min drive · {s.driveKm} km
                    </div>
                    {/* Stop */}
                    <div className="flex gap-3 rounded-xl border border-slate-200 bg-white p-3 transition-all duration-200 hover:border-slate-300 hover:shadow-sm">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-extrabold text-white"
                        style={{ background: TYPE_STYLE[s.type].dot }}>
                        {s.n}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-mono text-sm font-bold text-slate-900">{s.start}–{s.end}</span>
                          <span className="text-[11px] font-bold" style={{ color: TYPE_STYLE[s.type].dot }}>
                            {TYPE_STYLE[s.type].label} · {s.mins}m
                          </span>
                        </div>
                        <div className="truncate font-bold text-slate-800">{s.child}</div>
                        <div className="truncate text-xs text-slate-500">{s.venue}</div>
                        <a href={gmapsDir(s.postcode)} target="_blank" rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-[#FF6B00] hover:underline">
                          <Icon name="near_me" size={13} />{s.postcode}
                        </a>
                      </div>
                    </div>
                    {i === stops.length - 1 && (
                      <div className="ml-4 flex items-center gap-2 border-l-2 border-dashed border-slate-200 py-1.5 pl-4 text-[11px] font-semibold text-slate-400">
                        <Icon name="home" size={13} />
                        head home · {driveMins(kmBetween(s.coords, ROUTE_HOME.coords))} min
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <p className="mt-3 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-400">
                Stops run in session-time order. Drive times are straight-line estimates —
                tap a postcode for turn-by-turn directions in Google Maps.
              </p>
            </KSCard>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────────
function DashboardTab({ coachName, schedule, unmarked, skills, onToggle, afterMark, goCalendar }: {
  coachName: string;
  schedule: KsSchedule | null;
  unmarked: KsBooking[];
  skills: KsSkill[];
  onToggle: (b: KsBooking) => Promise<void>;
  afterMark: () => void;
  goCalendar: () => void;
}) {
  const hour = new Date().getHours();
  const daypart = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const today = schedule?.today_sessions || [];

  // The rest of this week, grouped by day, so the coach sees what's ahead
  // without switching to the calendar. Cancelled slots are dropped; we stop
  // once we've gathered ~8 sessions but never cut a day in half.
  const upcoming = useMemo(() => {
    const groups: [string, KsBooking[]][] = [];
    let count = 0;
    for (const d of schedule?.days || []) {
      if (d.date <= (schedule?.today || '')) continue;
      const items = d.sessions.filter(b => b.status !== 'cancelled');
      if (!items.length) continue;
      groups.push([d.date, items]);
      count += items.length;
      if (count >= 8) break;
    }
    return groups;
  }, [schedule]);

  if (!schedule) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
          Good {daypart}, {coachName.split(' ')[0]} 👋
        </h1>
        <p className="mt-1 text-sm text-slate-500">{dayName(schedule.today)}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="event" label="This week" value={schedule.totals.sessions}
          sub={`${shortDay(schedule.week_start)} – ${shortDay(schedule.week_end)}`} />
        <StatCard icon="task_alt" label="Completed" value={schedule.totals.completed}
          accent="#2563EB" delay={60} sub="marked done this week" />
        <StatCard icon="today" label="Today" value={today.length} accent="#16A34A" delay={120}
          sub={today.length ? `first at ${today[0].start_time}` : 'nothing scheduled'} />
        <StatCard icon="fact_check" label="To mark" value={unmarked.length}
          accent={unmarked.length ? '#DC2626' : '#94A3B8'} delay={180}
          sub={unmarked.length ? 'registers outstanding' : 'all caught up'} />
      </div>

      <section>
        <SectionHead action={
          <KSButton tone="ghost" onClick={goCalendar}>Open calendar →</KSButton>
        }>Today's sessions</SectionHead>
        {today.length === 0 ? (
          <EmptyNote icon="sports" title="Nothing on today"
            hint="Enjoy the rest — tomorrow's sessions are on the calendar." />
        ) : (
          <div className="space-y-2.5">
            {today.map(b => (
              <SessionRow key={b.id} b={b} onToggle={onToggle} showContact
                skills={skills} onSaved={afterMark} />
            ))}
          </div>
        )}
      </section>

      {upcoming.length > 0 && (
        <section>
          <SectionHead action={
            <KSButton tone="ghost" onClick={goCalendar}>Full week →</KSButton>
          }>Coming up this week</SectionHead>
          <div className="space-y-4">
            {upcoming.map(([date, items]) => (
              <div key={date}>
                <div className="mb-1.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400">
                  {shortDay(date)}
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">{items.length}</span>
                </div>
                <div className="space-y-1.5">
                  {items.map(b => {
                    const st = TYPE_STYLE[typeOfService('', b.service_name)];
                    return (
                      <div key={b.id}
                        className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 transition-colors hover:border-slate-300">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: st.dot }} />
                        <span className="w-24 shrink-0 font-mono text-sm font-bold text-slate-800">
                          {b.start_time}–{b.end_time}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-bold text-slate-900">{b.child_name}</span>
                          <span className="text-slate-500"> · {b.service_name}</span>
                        </span>
                        {b.series_ref && <Icon name="repeat" size={15} className="shrink-0 text-slate-300" />}
                        {b.status === 'completed' && <KSPill tone="blue">Done</KSPill>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHead>Still to mark</SectionHead>
        <p className="-mt-2 mb-4 text-sm text-slate-500">
          Sessions that have run without a register. Marking a no-show texts the parent that
          the session is still payable.
        </p>
        {unmarked.length === 0 ? (
          <EmptyNote icon="verified" title="All caught up"
            hint="Every session that's run has a register mark." />
        ) : (
          <div className="space-y-2.5">
            {unmarked.map(b => (
              <SessionRow key={b.id} b={b} onToggle={onToggle} showContact
                skills={skills} onSaved={afterMark} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Students ────────────────────────────────────────────────────────────
const SPORT_TINT: Record<string, string> = {
  Football: '#FF6B00', Tennis: '#16A34A', Basketball: '#2563EB',
};

function StudentCard({ s, open, onToggle, delay }:
  { s: MockStudent; open: boolean; onToggle: () => void; delay: number }) {
  const tint = SPORT_TINT[s.sport] || ORANGE;
  const attended = s.attendance.filter(a => a.present).length;
  return (
    <div className="animate-fadeInUp overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md"
      style={{ animationDelay: `${delay}ms` }}>
      <button onClick={onToggle} className="flex w-full items-center gap-3.5 p-4 text-left">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-sm font-extrabold text-white"
          style={{ background: `linear-gradient(135deg, ${tint}, ${tint}CC)` }}>
          {s.child.split(' ').map(w => w[0]).join('').slice(0, 2)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-extrabold text-slate-900">{s.child}</span>
            <KSPill tone="slate">Age {s.age}</KSPill>
            <span className="rounded-full px-2.5 py-0.5 text-xs font-bold"
              style={{ background: `${tint}14`, color: tint }}>{s.sport}</span>
          </span>
          <span className="mt-0.5 block truncate text-sm text-slate-500">
            {s.parent} · {s.phone} · {s.sessionType}
          </span>
        </span>
        <Icon name="expand_more" size={22}
          className={`shrink-0 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="animate-[fadeInUp_0.25s_ease-out_both] border-t border-slate-100 bg-slate-50/50 p-4">
          {/* Contact row */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-white p-3.5 shadow-sm">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Parent</div>
              <div className="mt-1 font-bold text-slate-900">{s.parent}</div>
              <div className="mt-1 space-y-0.5 text-sm">
                <a href={`tel:${s.phone.replace(/\s/g, '')}`}
                  className="block font-semibold text-[#FF6B00] hover:underline">{s.phone}</a>
                <a href={`mailto:${s.email}`}
                  className="block break-words text-slate-500 hover:text-slate-800">{s.email}</a>
              </div>
              <div className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
                <Icon name="home" size={14} className="mt-px shrink-0" />{s.address}
              </div>
            </div>
            <div className="rounded-xl bg-white p-3.5 shadow-sm">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Emergency contact</div>
              <div className="mt-1 text-sm font-semibold text-slate-800">{s.emergency}</div>
              <div className="mt-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">Attendance</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {s.attendance.map((a, i) => (
                  <span key={i} title={`${a.date} — ${a.present ? 'present' : 'absent'}`}
                    className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-extrabold
                      ${a.present ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {a.present ? 'P' : 'A'}
                  </span>
                ))}
                <span className="ml-1 text-xs font-bold text-slate-500">
                  {attended}/{s.attendance.length} attended
                </span>
              </div>
            </div>
          </div>

          {/* Booking history */}
          <div className="mt-3 rounded-xl bg-white p-3.5 shadow-sm">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Booking history</div>
            <div className="mt-2 space-y-1.5">
              {s.history.map((h, i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-slate-50">
                  <Icon name="event_available" size={16} className="shrink-0 text-slate-300" />
                  <span className="w-28 shrink-0 font-semibold text-slate-800">{h.date}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-600">{h.service}</span>
                  <span className="shrink-0 font-mono text-xs text-slate-400">{h.time}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Progress notes */}
          {s.notes.length > 0 && (
            <div className="mt-3 rounded-xl bg-white p-3.5 shadow-sm">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Progress notes</div>
              <div className="mt-2 space-y-2.5">
                {s.notes.map((n, i) => (
                  <div key={i} className="border-l-2 border-orange-200 pl-3">
                    <div className="text-xs font-bold text-slate-400">{n.date}</div>
                    <p className="mt-0.5 text-sm leading-relaxed text-slate-700">{n.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Student onboarding ──────────────────────────────────────────────────
function AddStudentModal({ onClose, onAdded }:
  { onClose: () => void; onAdded: (s: KsStudent) => void }) {
  const [f, setF] = useState({
    child_name: '', dob: '', age: '', parent_name: '', parent_email: '',
    parent_phone: '', address: '', postcode: '', emergency_name: '',
    emergency_phone: '', medical_notes: '', source: 'word of mouth',
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF(v => ({ ...v, [k]: e.target.value }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await ksApi.addStudent({ ...f, age: f.age || undefined, dob: f.dob || undefined });
      onAdded(res.student);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Could not save the student.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KSModal onClose={onClose} wide>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-extrabold tracking-tight text-slate-900">Add a student</h3>
          <p className="text-xs text-slate-500">
            Creates the parent record too — they can claim it later with the same email.
          </p>
        </div>
        <button onClick={onClose} aria-label="Close"
          className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
          <Icon name="close" size={20} />
        </button>
      </div>

      <form onSubmit={submit} className="space-y-3.5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <KSLabel>Child's full name *</KSLabel>
            <KSInput value={f.child_name} onChange={set('child_name')} placeholder="e.g. Bobby Ashton" />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <KSLabel>Date of birth</KSLabel>
              <KSInput type="date" value={f.dob} onChange={set('dob')} />
            </div>
            <div>
              <KSLabel>…or age *</KSLabel>
              <KSInput type="number" min={3} max={18} value={f.age} onChange={set('age')} placeholder="9" />
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <KSLabel>Parent name *</KSLabel>
            <KSInput value={f.parent_name} onChange={set('parent_name')} placeholder="e.g. Jo Ashton" />
          </div>
          <div>
            <KSLabel>Parent phone *</KSLabel>
            <KSInput value={f.parent_phone} onChange={set('parent_phone')} placeholder="07…" />
          </div>
        </div>
        <div>
          <KSLabel>Parent email *</KSLabel>
          <KSInput type="email" value={f.parent_email} onChange={set('parent_email')}
            placeholder="parent@example.com" />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr,9rem]">
          <div>
            <KSLabel>Address *</KSLabel>
            <KSInput value={f.address} onChange={set('address')} placeholder="14 Birch Grove, Chester" />
          </div>
          <div>
            <KSLabel>Postcode *</KSLabel>
            <KSInput value={f.postcode} onChange={set('postcode')} placeholder="CH1 2HT" />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <KSLabel>Emergency contact</KSLabel>
            <KSInput value={f.emergency_name} onChange={set('emergency_name')} placeholder="Name" />
          </div>
          <div>
            <KSLabel>Emergency phone</KSLabel>
            <KSInput value={f.emergency_phone} onChange={set('emergency_phone')} placeholder="07…" />
          </div>
        </div>

        <div>
          <KSLabel hint="allergies, conditions, anything the coach must know">Medical notes</KSLabel>
          <KSTextarea rows={2} value={f.medical_notes} onChange={set('medical_notes')}
            placeholder="e.g. mild asthma — carries an inhaler" />
        </div>

        <div>
          <KSLabel>How did they hear about us?</KSLabel>
          <KSSelect value={f.source} onChange={set('source')} className="w-full py-2.5">
            {['word of mouth', 'social media', 'website', 'other'].map(s => (
              <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
            ))}
          </KSSelect>
        </div>

        {error && <KSAlert>{error}</KSAlert>}
        <KSButton type="submit" loading={busy} className="w-full">Save student</KSButton>
      </form>
    </KSModal>
  );
}

function RealStudentCard({ s, open, onToggle, delay }:
  { s: KsStudent; open: boolean; onToggle: () => void; delay: number }) {
  const total = s.attendance.attended + s.attendance.absent;
  return (
    <div className="animate-fadeInUp overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md"
      style={{ animationDelay: `${delay}ms` }}>
      <button onClick={onToggle} className="flex w-full items-center gap-3.5 p-4 text-left">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#FF8A2B] to-[#FF6B00] text-sm font-extrabold text-white">
          {s.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-extrabold text-slate-900">{s.name}</span>
            {s.age != null && <KSPill tone="slate">Age {s.age}</KSPill>}
            {s.medical_notes && <KSPill tone="red">Medical</KSPill>}
          </span>
          <span className="mt-0.5 block truncate text-sm text-slate-500">
            {s.parent.name} · {s.parent.phone || s.parent.email}
          </span>
        </span>
        <Icon name="expand_more" size={22}
          className={`shrink-0 text-slate-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="animate-[fadeInUp_0.25s_ease-out_both] border-t border-slate-100 bg-slate-50/50 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-white p-3.5 shadow-sm">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Parent</div>
              <div className="mt-1 font-bold text-slate-900">{s.parent.name}</div>
              <div className="mt-1 space-y-0.5 text-sm">
                {s.parent.phone && (
                  <a href={`tel:${s.parent.phone.replace(/\s/g, '')}`}
                    className="block font-semibold text-[#FF6B00] hover:underline">{s.parent.phone}</a>
                )}
                <a href={`mailto:${s.parent.email}`}
                  className="block break-words text-slate-500 hover:text-slate-800">{s.parent.email}</a>
              </div>
              {(s.address || s.postcode) && (
                <div className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
                  <Icon name="home" size={14} className="mt-px shrink-0" />
                  {[s.address, s.postcode].filter(Boolean).join(', ')}
                </div>
              )}
              {s.source && (
                <div className="mt-2 text-[11px] text-slate-400">Heard about us via {s.source}</div>
              )}
            </div>
            <div className="rounded-xl bg-white p-3.5 shadow-sm">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Emergency contact</div>
              <div className="mt-1 text-sm font-semibold text-slate-800">
                {s.emergency_name || '—'}{s.emergency_phone ? ` · ${s.emergency_phone}` : ''}
              </div>
              {s.medical_notes && (
                <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">
                  ⚕ {s.medical_notes}
                </div>
              )}
              <div className="mt-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">Attendance</div>
              <div className="mt-1 text-sm font-semibold text-slate-700">
                {total === 0 ? 'No register marks yet'
                  : `${s.attendance.attended}/${total} attended`}
                {s.attendance.cancelled > 0 && ` · ${s.attendance.cancelled} called off`}
              </div>
            </div>
          </div>

          <div className="mt-3 rounded-xl bg-white p-3.5 shadow-sm">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Booking history</div>
            {s.bookings.length === 0 ? (
              <p className="mt-1.5 text-sm text-slate-400">
                No bookings yet — add one from the calendar.
              </p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {s.bookings.map(h => (
                  <div key={h.ref} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-slate-50">
                    <Icon name="event_available" size={16} className="shrink-0 text-slate-300" />
                    <span className="w-28 shrink-0 font-semibold text-slate-800">{shortDay(h.date)}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-600">{h.service_name}</span>
                    <span className="shrink-0 font-mono text-xs text-slate-400">{h.start_time}</span>
                    <KSPill tone={STATUS_PILL[h.status] || 'slate'}>
                      {h.status[0].toUpperCase() + h.status.slice(1)}
                    </KSPill>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StudentsTab({ students, attendance, focus, onReload }: {
  students: KsStudent[]; attendance: KsChildAttendance[]; focus: string; onReload: () => void;
}) {
  const [query, setQuery] = useState(focus);
  const [openId, setOpenId] = useState<number | null>(null);
  const [openReal, setOpenReal] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  // "View student" from the calendar deep-links here with a name.
  useEffect(() => {
    if (!focus) return;
    setQuery(focus);
    const real = students.find(s => s.name.toLowerCase() === focus.toLowerCase());
    if (real) setOpenReal(real.id);
    const mock = MOCK_STUDENTS.find(s => s.child.toLowerCase() === focus.toLowerCase());
    if (mock) setOpenId(mock.id);
  }, [focus, students]);

  const q = query.trim().toLowerCase();
  const real = q
    ? students.filter(s =>
        s.name.toLowerCase().includes(q) || s.parent.name.toLowerCase().includes(q) ||
        s.parent.email.toLowerCase().includes(q) || (s.postcode || '').toLowerCase().includes(q))
    : students;
  const mocks = q
    ? MOCK_STUDENTS.filter(s =>
        s.child.toLowerCase().includes(q) || s.parent.toLowerCase().includes(q) ||
        s.sport.toLowerCase().includes(q) || s.email.toLowerCase().includes(q))
    : MOCK_STUDENTS;

  return (
    <div className="space-y-7">
      <section>
        <SectionHead action={
          <KSButton onClick={() => setAdding(true)}>
            <Icon name="person_add" size={17} />Add student
          </KSButton>
        }>Students</SectionHead>
        <div className="relative mb-4">
          <Icon name="search" size={19}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <KSInput value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search by child, parent, postcode or email…" className="pl-10" />
        </div>

        {real.length === 0 ? (
          // No real students yet → the badged sample list below carries the
          // demo, so we only surface an empty note when a search misses.
          students.length === 0 ? null : (
            <EmptyNote icon="person_search" title="No students match"
              hint={`Nothing found for "${query}".`} />
          )
        ) : (
          <div className="space-y-2.5">
            {real.map((s, i) => (
              <RealStudentCard key={s.id} s={s} open={openReal === s.id}
                onToggle={() => setOpenReal(v => (v === s.id ? null : s.id))}
                delay={Math.min(i * 50, 400)} />
            ))}
          </div>
        )}
      </section>

      {/* Sample roster — a preview of the finished shape, shown only until the
          coach adds their first real student (mirrors Leads / Route / Finance). */}
      {students.length === 0 && (
        <section>
          <SectionHead sample>Sample students</SectionHead>
          <p className="-mt-2 mb-4 text-sm text-slate-500">
            How students will look here. Add your first real student and this sample
            roster makes way for the real thing.
          </p>
          {mocks.length === 0 ? (
            <p className="text-sm text-slate-400">No sample students match "{query}".</p>
          ) : (
            <div className="space-y-2.5">
              {mocks.map((s, i) => (
                <StudentCard key={s.id} s={s} open={openId === s.id}
                  onToggle={() => setOpenId(v => (v === s.id ? null : s.id))}
                  delay={Math.min(i * 50, 400)} />
              ))}
            </div>
          )}
        </section>
      )}

      {adding && <AddStudentModal onClose={() => setAdding(false)} onAdded={() => onReload()} />}

      {/* Real attendance pulled from actual bookings, when it exists */}
      {attendance.length > 0 && (
        <section>
          <SectionHead>Live attendance — from real bookings</SectionHead>
          <p className="-mt-2 mb-4 text-sm text-slate-500">
            Lowest attendance first. Sessions called off with notice don't count against a player.
          </p>
          <div className="space-y-2">
            {attendance.map(c => (
              <KSCard key={c.child_name} className="flex flex-wrap items-center gap-3 p-4 transition-colors hover:border-slate-300">
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-slate-900">{c.child_name}</div>
                  <div className="text-xs text-slate-500">
                    {c.attended} attended · {c.absent} missed · {c.cancelled} called off
                    {c.last_seen ? ` · last seen ${shortDay(c.last_seen)}` : ''}
                  </div>
                </div>
                {c.rate !== null && (
                  <div className="w-28">
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
                      <div className={`h-full rounded-full ${
                        c.rate >= 90 ? 'bg-green-500' : c.rate >= 70 ? 'bg-amber-500' : 'bg-red-500'}`}
                        style={{ width: `${c.rate}%` }} />
                    </div>
                  </div>
                )}
                <KSPill tone={c.rate === null ? 'slate'
                  : c.rate >= 90 ? 'green' : c.rate >= 70 ? 'orange' : 'red'}>
                  {c.rate === null ? '—' : `${c.rate}%`}
                </KSPill>
              </KSCard>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ── Leads ───────────────────────────────────────────────────────────────
function AddLeadModal({ onAdd, onClose }:
  { onAdd: (l: Omit<Lead, 'id' | 'status' | 'added'>) => void; onClose: () => void }) {
  const [parent, setParent] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [childAge, setChildAge] = useState('');
  const [interest, setInterest] = useState('Football');
  const [source, setSource] = useState('Website');
  const [error, setError] = useState('');

  const save = () => {
    if (!parent.trim()) { setError("The parent's name is the one thing we need."); return; }
    onAdd({
      parent: parent.trim(), phone: phone.trim(), email: email.trim(),
      childAge: Number(childAge) || 0, interest, source,
    });
    onClose();
  };

  return (
    <KSModal onClose={onClose}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-extrabold tracking-tight text-slate-900">Add a lead</h3>
        <button onClick={onClose} aria-label="Close"
          className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
          <Icon name="close" size={20} />
        </button>
      </div>
      <div className="space-y-3.5">
        <div>
          <KSLabel>Parent name</KSLabel>
          <KSInput value={parent} onChange={e => setParent(e.target.value)} placeholder="e.g. Jo Baxter" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <KSLabel>Phone</KSLabel>
            <KSInput value={phone} onChange={e => setPhone(e.target.value)} placeholder="07…" />
          </div>
          <div>
            <KSLabel>Child's age</KSLabel>
            <KSInput type="number" min={4} max={17} value={childAge}
              onChange={e => setChildAge(e.target.value)} placeholder="e.g. 9" />
          </div>
        </div>
        <div>
          <KSLabel>Email</KSLabel>
          <KSInput type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="parent@example.com" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <KSLabel>Interest</KSLabel>
            <KSSelect value={interest} onChange={e => setInterest(e.target.value)}>
              {['Football', 'Tennis', 'Basketball', 'Badminton', 'Handball', 'Multi-sport'].map(s =>
                <option key={s}>{s}</option>)}
            </KSSelect>
          </div>
          <div>
            <KSLabel>Source</KSLabel>
            <KSSelect value={source} onChange={e => setSource(e.target.value)}>
              {['Website', 'Word of mouth', 'Referral', 'School', 'Social media'].map(s =>
                <option key={s}>{s}</option>)}
            </KSSelect>
          </div>
        </div>
        {error && <KSAlert>{error}</KSAlert>}
        <KSButton onClick={save} className="w-full">Save lead</KSButton>
      </div>
    </KSModal>
  );
}

function LeadModal({ lead, onStatus, onClose }:
  { lead: Lead; onStatus: (id: number, s: Lead['status']) => void; onClose: () => void }) {
  return (
    <KSModal onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-extrabold tracking-tight text-slate-900">{lead.parent}</h3>
          <div className="mt-1 text-sm text-slate-500">
            Child age {lead.childAge || '—'} · {lead.interest} · via {lead.source}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
          <Icon name="close" size={20} />
        </button>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {lead.phone && (
            <a href={`tel:${lead.phone.replace(/\s/g, '')}`}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#FF6B00] px-4 py-2 text-sm font-bold text-white shadow-sm transition-all hover:bg-[#E85F00] hover:shadow-md">
              <Icon name="call" size={17} />{lead.phone}
            </a>
          )}
          {lead.email && (
            <a href={`mailto:${lead.email}`}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50">
              <Icon name="mail" size={17} />Email
            </a>
          )}
        </div>

        <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Added {shortDay(lead.added)} · currently{' '}
          <span className="font-bold">{LEAD_STATUS[lead.status].label.toLowerCase()}</span>
        </div>

        <div>
          <KSLabel>Move to</KSLabel>
          <div className="grid grid-cols-4 gap-2">
            {(Object.keys(LEAD_STATUS) as Lead['status'][]).map(s => (
              <button key={s} onClick={() => onStatus(lead.id, s)}
                className={`rounded-xl border px-2 py-2 text-xs font-bold transition-colors
                  ${lead.status === s
                    ? 'border-[#FF6B00] bg-orange-50 text-[#FF6B00]'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'}`}>
                {LEAD_STATUS[s].label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </KSModal>
  );
}

function LeadsTab({ leads, onReload }:
  { leads: Lead[]; onReload: () => void }) {
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [error, setError] = useState('');
  // Local copy of the seeded pipeline, used only until the first real lead
  // exists. Moving a sample lead's status is a demo-only, in-memory change.
  const [sample, setSample] = useState<Lead[]>(MOCK_LEADS);

  const isSample = leads.length === 0;
  const rows = isSample ? sample : leads;

  // "Add lead" always writes a real lead — the first one flips the whole tab
  // from the sample view to live data.
  const addLead = async (l: Omit<Lead, 'id' | 'status' | 'added'>) => {
    setError('');
    try {
      await ksApi.addLead(l);
      onReload();
    } catch (e: any) {
      setError(e?.message || 'Could not save that lead.');
    }
  };

  const setStatus = async (id: number, status: Lead['status']) => {
    setSelected(sel => (sel && sel.id === id ? { ...sel, status } : sel));
    if (isSample) {
      setSample(ls => ls.map(l => (l.id === id ? { ...l, status } : l)));
      return;
    }
    setError('');
    try {
      await ksApi.updateLead(id, status);
    } catch (e: any) {
      setError(e?.message || 'Could not move that lead.');
    } finally {
      onReload();      // reconcile whether the write landed or not
    }
  };

  return (
    <div className="space-y-4">
      <SectionHead sample={isSample} action={
        <KSButton onClick={() => setAdding(true)}>
          <Icon name="add" size={18} />Add lead
        </KSButton>
      }>Leads</SectionHead>
      <p className="-mt-4 text-sm text-slate-500">
        Prospective parents who haven't booked yet. Click a lead to call them or move them
        along the pipeline.
      </p>
      {error && <KSAlert>{error}</KSAlert>}

      {rows.length === 0 ? (
        <EmptyNote icon="person_add" title="No leads yet"
          hint="Add parents who've enquired and track them from first call to first booking." />
      ) : (
        <KSCard className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-3">Parent</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Child</th>
                  <th className="px-4 py-3">Interest</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Added</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(l => (
                  <tr key={l.id} onClick={() => setSelected(l)}
                    className="cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-orange-50/60">
                    <td className="px-4 py-3 font-bold text-slate-900">{l.parent}</td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-700">{l.phone || '—'}</div>
                      <div className="text-xs text-slate-400">{l.email}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{l.childAge ? `Age ${l.childAge}` : '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{l.interest}</td>
                    <td className="px-4 py-3 text-slate-500">{l.source}</td>
                    <td className="px-4 py-3">
                      <KSPill tone={LEAD_STATUS[l.status].tone}>{LEAD_STATUS[l.status].label}</KSPill>
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums text-slate-400">{shortDay(l.added)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </KSCard>
      )}

      {adding && <AddLeadModal onAdd={addLead} onClose={() => setAdding(false)} />}
      {selected && (
        <LeadModal lead={selected} onStatus={setStatus} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ── Finance ─────────────────────────────────────────────────────────────
function RevenueChart({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(...values, 1);
  return (
    <div>
      <div className="flex h-44 items-end gap-2.5 sm:gap-4">
        {values.map((v, i) => (
          <div key={labels[i]} className="group flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <div className="text-[11px] font-bold tabular-nums text-slate-500 opacity-0 transition-opacity group-hover:opacity-100 sm:opacity-100">
              £{v.toLocaleString()}
            </div>
            <div className="w-full max-w-[52px] rounded-t-lg bg-gradient-to-t from-[#FF6B00] to-[#FF8A2B] shadow-sm transition-all duration-200 group-hover:brightness-110"
              style={{ height: `${Math.max((v / max) * 100, 4)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2.5 border-t border-slate-100 pt-2 sm:gap-4">
        {labels.map(l => (
          <div key={l} className="flex-1 text-center text-xs font-semibold text-slate-500">{l}</div>
        ))}
      </div>
    </div>
  );
}

function SignupsChart({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(...values, 1);
  const W = 600, H = 150, PAD = 24;
  const pts = values.map((v, i) => ({
    x: PAD + (i * (W - PAD * 2)) / (values.length - 1),
    y: H - PAD - ((H - PAD * 2) * v) / max,
    v,
  }));
  const line = pts.map(p => `${p.x},${p.y}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`New students per month: ${values.join(', ')}`}>
        <polygon points={`${pts[0].x},${H - PAD} ${line} ${pts[pts.length - 1].x},${H - PAD}`}
          fill={ORANGE} opacity="0.08" />
        <polyline points={line} fill="none" stroke={ORANGE} strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="5" fill="#fff" stroke={ORANGE} strokeWidth="3" />
            <text x={p.x} y={p.y - 11} textAnchor="middle" fontSize="13" fontWeight="700" fill="#334155">
              {p.v}
            </text>
          </g>
        ))}
      </svg>
      <div className="flex border-t border-slate-100 pt-2">
        {labels.map(l => (
          <div key={l} className="flex-1 text-center text-xs font-semibold text-slate-500">{l}</div>
        ))}
      </div>
    </div>
  );
}

function SampleFinanceTab() {
  const labels = monthLabels();
  const total = FIN_REVENUE.reduce((a, b) => a + b, 0);
  const thisMonth = FIN_REVENUE[FIN_REVENUE.length - 1];
  const students = MOCK_STUDENTS.length;
  const avg = Math.round(total / students);

  return (
    <div className="space-y-6">
      <SectionHead sample>Finance</SectionHead>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="payments" label="Total revenue" value={`£${total.toLocaleString()}`}
          sub="last 6 months" />
        <StatCard icon="groups" label="Active students" value={students} accent="#2563EB"
          delay={60} sub="on the books" />
        <StatCard icon="person" label="Avg per student" value={`£${avg.toLocaleString()}`}
          accent="#16A34A" delay={120} sub="6-month average" />
        <StatCard icon="calendar_month" label="This month" value={`£${thisMonth.toLocaleString()}`}
          accent="#A78BFA" delay={180} sub={`${labels[labels.length - 1]} so far`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <KSCard className="p-5 transition-shadow hover:shadow-md">
          <h3 className="font-extrabold tracking-tight text-slate-900">Revenue</h3>
          <p className="mb-4 mt-0.5 text-xs text-slate-500">Last 6 months</p>
          <RevenueChart values={FIN_REVENUE} labels={labels} />
        </KSCard>
        <KSCard className="p-5 transition-shadow hover:shadow-md">
          <h3 className="font-extrabold tracking-tight text-slate-900">New sign-ups</h3>
          <p className="mb-4 mt-0.5 text-xs text-slate-500">New students per month</p>
          <SignupsChart values={FIN_SIGNUPS} labels={labels} />
        </KSCard>
      </div>

      <KSCard className="p-5">
        <h3 className="font-extrabold tracking-tight text-slate-900">Outstanding payments</h3>
        <p className="mb-4 mt-0.5 text-xs text-slate-500">
          Students with a balance to chase — oldest first.
        </p>
        <div className="space-y-2">
          {MOCK_OUTSTANDING.map(o => (
            <div key={o.student}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 px-3.5 py-3 transition-colors hover:border-slate-300 hover:bg-slate-50/60">
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl
                ${o.due.startsWith('Overdue') ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>
                <Icon name={o.due.startsWith('Overdue') ? 'priority_high' : 'schedule'} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-slate-900">{o.student}</div>
                <div className="text-xs text-slate-500">{o.reason}</div>
              </div>
              <div className="text-right">
                <div className="font-extrabold tabular-nums text-slate-900">{money(o.amount_pence)}</div>
                <div className={`text-[11px] font-bold ${o.due.startsWith('Overdue') ? 'text-red-600' : 'text-slate-400'}`}>
                  {o.due}
                </div>
              </div>
            </div>
          ))}
        </div>
      </KSCard>
    </div>
  );
}

// A 'YYYY-MM' key → short month label ("Jul").
const monthShort = (ym: string) =>
  new Date(`${ym}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'short' });

function OutstandingRow({ o, busy, onMarkPaid }:
  { o: KsOutstanding; busy: boolean; onMarkPaid: (ids: number[]) => void }) {
  const daysAgo = Math.floor(
    (Date.now() - new Date(`${o.oldest_date}T12:00:00`).getTime()) / 86400000);
  const overdue = daysAgo >= 7;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 px-3.5 py-3 transition-colors hover:border-slate-300 hover:bg-slate-50/60">
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl
        ${overdue ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'}`}>
        <Icon name={overdue ? 'priority_high' : 'schedule'} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-bold text-slate-900">{o.student}</div>
        <div className="truncate text-xs text-slate-500">
          {o.sessions} session{o.sessions === 1 ? '' : 's'} · {o.parent_name}
          {o.parent_phone ? ` · ${o.parent_phone}` : ''}
        </div>
      </div>
      <div className="text-right">
        <div className="font-extrabold tabular-nums text-slate-900">{money(o.amount_pence)}</div>
        <div className={`text-[11px] font-bold ${overdue ? 'text-red-600' : 'text-slate-400'}`}>
          {daysAgo <= 0 ? 'since today' : `oldest ${daysAgo}d ago`}
        </div>
      </div>
      <KSButton tone="secondary" loading={busy} className="py-1.5 text-xs"
        onClick={() => onMarkPaid(o.booking_ids)}>
        <Icon name="done_all" size={15} />Mark paid
      </KSButton>
    </div>
  );
}

function FinanceTab() {
  const [fin, setFin] = useState<KsFinance | null>(null);
  const [loading, setLoading] = useState(true);
  const [payingKey, setPayingKey] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    ksApi.finance()
      .then(setFin)
      .catch(() => setFin(null))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const markPaid = async (key: string, ids: number[]) => {
    setPayingKey(key);
    try { await ksApi.markPaid(ids, true); load(); }
    catch { /* a reload shows the true state */ }
    finally { setPayingKey(''); }
  };

  if (loading && !fin) {
    return (
      <div className="space-y-6">
        <SectionHead>Finance</SectionHead>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // No real financial footprint yet — show the seeded sample so the tab still
  // demonstrates its shape, exactly like the students and route tabs do.
  const hasReal = !!fin && (fin.active_students > 0 || fin.earned_total_pence > 0
    || fin.outstanding.length > 0 || fin.upcoming_pence > 0);
  if (!hasReal) return <SampleFinanceTab />;

  const labels = fin!.months.map(monthShort);
  const revenuePounds = fin!.revenue_pence.map(p => Math.round(p / 100));

  return (
    <div className="space-y-6">
      <SectionHead>Finance</SectionHead>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon="payments" label="Revenue earned" value={money(fin!.earned_total_pence)}
          sub="delivered · last 6 months" />
        <StatCard icon="calendar_month" label="This month" value={money(fin!.this_month_pence)}
          accent="#A78BFA" delay={60} sub={`${labels[labels.length - 1]} so far`} />
        <StatCard icon="hourglass_top" label="Outstanding" value={money(fin!.outstanding_pence)}
          accent={fin!.outstanding_pence > 0 ? '#DC2626' : '#16A34A'} delay={120}
          sub={fin!.outstanding_pence > 0 ? 'delivered, unpaid' : 'all settled'} />
        <StatCard icon="event_upcoming" label="Booked ahead" value={money(fin!.upcoming_pence)}
          accent="#2563EB" delay={180} sub={`${fin!.active_students} active student${fin!.active_students === 1 ? '' : 's'}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <KSCard className="p-5 transition-shadow hover:shadow-md">
          <h3 className="font-extrabold tracking-tight text-slate-900">Revenue</h3>
          <p className="mb-4 mt-0.5 text-xs text-slate-500">
            Earned from completed sessions · last 6 months
          </p>
          <RevenueChart values={revenuePounds} labels={labels} />
        </KSCard>
        <KSCard className="p-5 transition-shadow hover:shadow-md">
          <h3 className="font-extrabold tracking-tight text-slate-900">New sign-ups</h3>
          <p className="mb-4 mt-0.5 text-xs text-slate-500">Students onboarded per month</p>
          <SignupsChart values={fin!.signups} labels={labels} />
        </KSCard>
      </div>

      <KSCard className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="font-extrabold tracking-tight text-slate-900">Outstanding payments</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Delivered sessions not yet marked paid — oldest first.
            </p>
          </div>
          {fin!.collected_pence > 0 && (
            <div className="hidden text-right sm:block">
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Collected</div>
              <div className="font-extrabold tabular-nums text-green-600">{money(fin!.collected_pence)}</div>
            </div>
          )}
        </div>
        {fin!.outstanding.length === 0 ? (
          <EmptyNote icon="verified" title="Nothing outstanding"
            hint="Every delivered session has been marked paid. Nice and tidy." />
        ) : (
          <div className="space-y-2">
            {fin!.outstanding.map(o => {
              const key = `${o.student}·${o.parent_email}`;
              return (
                <OutstandingRow key={key} o={o} busy={payingKey === key}
                  onMarkPaid={ids => markPaid(key, ids)} />
              );
            })}
          </div>
        )}
      </KSCard>
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────
function AvailabilityPanel({ onChanged }: { onChanged: () => void }) {
  const [blocks, setBlocks] = useState<KsBlock[]>([]);
  const [date, setDate] = useState(isoDate(1));
  const [start, setStart] = useState('00:00');
  const [end, setEnd] = useState('23:59');
  const [reason, setReason] = useState('');
  const [allDay, setAllDay] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    ksApi.availability().then(r => setBlocks(r.availability)).catch(() => setBlocks([]));
  }, []);
  useEffect(load, [load]);

  const add = async () => {
    setBusy(true);
    setError('');
    try {
      await ksApi.blockTime({
        date,
        start_time: allDay ? '00:00' : start,
        end_time: allDay ? '23:59' : end,
        reason: reason.trim(),
      });
      setReason('');
      load();
      onChanged();
    } catch (e: any) {
      setError(e?.message || 'Could not block that time.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try { await ksApi.unblock(id); load(); onChanged(); } catch { /* refresh shows truth */ }
  };

  return (
    <KSCard className="p-5">
      <h3 className="font-extrabold tracking-tight text-slate-900">Block out time</h3>
      <p className="mt-1 text-sm text-slate-600">
        Parents won't be offered these slots. Existing bookings are never affected.
        Blocked time also shows on your calendar.
      </p>

      <div className="mt-4 space-y-3">
        <div>
          <KSLabel>Date</KSLabel>
          <KSInput type="date" value={date} min={isoDate(0)} onChange={e => setDate(e.target.value)} />
        </div>

        <label className="flex items-center gap-2.5 text-sm font-semibold text-slate-700">
          <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-[#FF6B00]" />
          All day
        </label>

        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <KSLabel>From</KSLabel>
              <KSInput type="time" value={start} onChange={e => setStart(e.target.value)} />
            </div>
            <div>
              <KSLabel>To</KSLabel>
              <KSInput type="time" value={end} onChange={e => setEnd(e.target.value)} />
            </div>
          </div>
        )}

        <div>
          <KSLabel hint="(optional)">Reason</KSLabel>
          <KSInput value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Holiday, course, other work…" />
        </div>

        {error && <KSAlert>{error}</KSAlert>}
        <KSButton onClick={add} loading={busy} className="w-full">Block this time</KSButton>
      </div>

      <div className="mt-6 border-t border-slate-100 pt-4">
        <h4 className="text-sm font-bold uppercase tracking-wide text-slate-500">
          Blocked ({blocks.length})
        </h4>
        <div className="mt-3 space-y-2">
          {blocks.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing blocked — you're available on every slot.</p>
          ) : blocks.map(b => (
            <div key={b.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm transition-colors hover:bg-slate-100">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-slate-800">{shortDay(b.date)}</div>
                <div className="text-xs text-slate-500">
                  {b.start_time === '00:00' && b.end_time === '23:59'
                    ? 'All day' : `${b.start_time}–${b.end_time}`}
                  {b.reason ? ` · ${b.reason}` : ''}
                </div>
              </div>
              <button onClick={() => remove(b.id)}
                className="shrink-0 rounded-lg px-2 py-1 text-xs font-bold text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600">
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>
    </KSCard>
  );
}

function SettingsTab({ coach, onChanged, onSignOut }:
  { coach: { name: string; slug: string }; onChanged: () => void; onSignOut: () => void }) {
  return (
    <div className="space-y-4">
      <SectionHead>Settings</SectionHead>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <KSCard className="p-5">
            <div className="flex items-center gap-4">
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#FF8A2B] to-[#FF6B00] text-lg font-extrabold text-white">
                {coach.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-extrabold text-slate-900">{coach.name}</div>
                <div className="text-sm text-slate-500">Signed in as <span className="font-mono">{coach.slug}</span></div>
              </div>
              <KSButton tone="danger" onClick={onSignOut}>Sign out</KSButton>
            </div>
          </KSCard>

          <KSCard className="p-5">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600">
                <Icon name="sms" size={19} />
              </span>
              <div className="text-sm leading-relaxed text-slate-600">
                <div className="font-bold text-slate-900">Parent texting is live</div>
                Booking confirmations, reminders and no-show charge notices send real SMS
                messages. Marking a session as a <span className="font-bold">no-show</span> texts
                the parent that the session is still payable — use{' '}
                <span className="font-bold">called off</span> when they gave notice.
              </div>
            </div>
          </KSCard>
          <DaysOffCard onChanged={onChanged} />
        </div>

        <AvailabilityPanel onChanged={onChanged} />
      </div>
    </div>
  );
}

// ── Days off (whole-day blockouts) ──────────────────────────────────────
function DaysOffCard({ onChanged }: { onChanged: () => void }) {
  const [blockouts, setBlockouts] = useState<KsBlockout[]>([]);
  const [date, setDate] = useState(isoDate(1));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warn, setWarn] = useState('');

  const load = useCallback(() => {
    ksApi.blockouts().then(r => setBlockouts(r.blockouts)).catch(() => setBlockouts([]));
  }, []);
  useEffect(load, [load]);

  const add = async () => {
    setBusy(true);
    setError('');
    setWarn('');
    try {
      const res = await ksApi.addBlockout(date, reason.trim());
      if (res.clashing_bookings.length) {
        setWarn(`${res.clashing_bookings.length} session(s) already booked that day — `
          + 'they show with a warning on the calendar until you rearrange or cancel them.');
      }
      setReason('');
      load();
      onChanged();
    } catch (e: any) {
      setError(e?.message || 'Could not block that day.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    try { await ksApi.deleteBlockout(id); load(); onChanged(); } catch { /* refresh shows truth */ }
  };

  return (
    <KSCard className="p-5">
      <h3 className="font-extrabold tracking-tight text-slate-900">Days off</h3>
      <p className="mt-1 text-sm text-slate-600">
        Whole days you're away — holiday, sick or personal. Blocked days take no new bookings
        and show striped red on the calendar.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div className="min-w-[9rem] flex-1">
          <KSLabel>Date</KSLabel>
          <KSInput type="date" value={date} min={isoDate(0)} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="min-w-[9rem] flex-1">
          <KSLabel hint="(optional)">Reason</KSLabel>
          <KSInput value={reason} onChange={e => setReason(e.target.value)} placeholder="Holiday…" />
        </div>
        <KSButton onClick={add} loading={busy}>Block day</KSButton>
      </div>
      {error && <div className="mt-2"><KSAlert>{error}</KSAlert></div>}
      {warn && (
        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
          {warn}
        </div>
      )}

      <div className="mt-4 space-y-2">
        {blockouts.length === 0 ? (
          <p className="text-sm text-slate-500">No days off booked — the calendar is fully open.</p>
        ) : blockouts.map(b => (
          <div key={b.id} className="flex items-center gap-2 rounded-lg bg-red-50/70 px-3 py-2 text-sm transition-colors hover:bg-red-50">
            <Icon name="event_busy" size={16} className="shrink-0 text-red-500" />
            <div className="min-w-0 flex-1">
              <span className="font-semibold text-slate-800">{shortDay(b.date)}</span>
              {b.reason && <span className="text-slate-500"> · {b.reason}</span>}
            </div>
            <button onClick={() => remove(b.id)}
              className="shrink-0 rounded-lg px-2 py-1 text-xs font-bold text-slate-400 transition-colors hover:bg-white hover:text-red-600">
              Remove
            </button>
          </div>
        ))}
      </div>
    </KSCard>
  );
}

// ── Login ───────────────────────────────────────────────────────────────
function CoachLogin({ onAuthed }: { onAuthed: (c: KsSchedule['coach']) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await ksApi.coachLogin(username.trim(), password);
      setCoachToken(res.token);
      onAuthed(res.coach);
    } catch (err: any) {
      setError(err?.message || 'Sign-in failed.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm px-4 py-14 sm:px-6">
      <div className="text-center">
        <div className="flex justify-center"><KSMark size={48} /></div>
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-slate-900">Coach sign-in</h1>
        <p className="mt-1.5 text-slate-600">Your calendar, students and finances in one place.</p>
      </div>
      <KSCard className="mt-7 p-6">
        <form onSubmit={submit} className="space-y-4">
          <div>
            <KSLabel>Username</KSLabel>
            <KSInput value={username} onChange={e => setUsername(e.target.value)}
              placeholder="saul or kellie" autoCapitalize="none" autoCorrect="off"
              autoComplete="username" />
          </div>
          <div>
            <KSLabel>Password</KSLabel>
            <KSInput type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" autoComplete="current-password" />
          </div>
          {error && <KSAlert>{error}</KSAlert>}
          <KSButton type="submit" loading={busy} className="w-full py-3">Sign in</KSButton>
        </form>
      </KSCard>
    </div>
  );
}

// ── Shell: sidebar + mobile drawer ──────────────────────────────────────
function NavItems({ tab, onPick, badges }:
  { tab: CoachTab; onPick: (t: CoachTab) => void; badges: Partial<Record<CoachTab, number>> }) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(n => {
        const active = tab === n.id;
        const badge = badges[n.id] || 0;
        return (
          <button key={n.id} onClick={() => onPick(n.id)}
            className={`relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-bold transition-all duration-200
              ${active
                ? 'bg-orange-50 text-[#FF6B00]'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
            {active && (
              <span className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-[#FF6B00]" />
            )}
            <Icon name={n.icon} size={21} fill={active} />
            <span className="flex-1 text-left">{n.label}</span>
            {badge > 0 && (
              <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-[#FF6B00] px-1 text-[11px] font-extrabold text-white">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ── Root ────────────────────────────────────────────────────────────────
export default function KSCoach() {
  const [coach, setCoach] = useState<KsSchedule['coach'] | null>(null);
  const [schedule, setSchedule] = useState<KsSchedule | null>(null);
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<CoachTab>('dashboard');
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState('');
  const [skills, setSkills] = useState<KsSkill[]>([]);
  const [unmarked, setUnmarked] = useState<KsBooking[]>([]);
  const [attendance, setAttendance] = useState<KsChildAttendance[]>([]);
  const [students, setStudents] = useState<KsStudent[]>([]);
  // "View student" from the calendar deep-links the Students tab to a name.
  const [studentFocus, setStudentFocus] = useState('');
  // Leads live here (not in the tab) so pipeline changes survive tab switches.
  // Real leads from the pipeline. Empty until the coach adds one, at which
  // point the Leads tab flips from its seeded sample view to live data.
  const [leads, setLeads] = useState<Lead[]>([]);

  const load = useCallback(async (w?: string) => {
    try {
      const s = await ksApi.schedule(w);
      setSchedule(s);
      setCoach(s.coach);
    } catch (e: any) {
      if (e?.status === 401) { clearCoachToken(); setCoach(null); }
      else setError(e?.message || 'Could not load the schedule.');
    }
  }, []);

  // The register is the coach's chase-list, so it reloads whenever a mark is
  // saved anywhere on the dashboard, not just on the dashboard tab.
  const loadRegister = useCallback(async () => {
    try {
      const [u, s] = await Promise.all([ksApi.unmarkedSessions(), ksApi.attendanceSummary(true)]);
      setUnmarked(u.sessions);
      setAttendance(s.children);
    } catch { /* the schedule still works without it */ }
  }, []);

  const loadStudents = useCallback(async () => {
    try {
      setStudents((await ksApi.students()).students);
    } catch { /* the tab shows samples regardless */ }
  }, []);

  const loadLeads = useCallback(async () => {
    try {
      setLeads((await ksApi.leads()).leads);
    } catch { /* the tab falls back to samples */ }
  }, []);

  useEffect(() => {
    if (!getCoachToken()) { setBooting(false); return; }
    ksApi.coachMe()
      .then(r => { setCoach(r.coach); return Promise.all([load(), loadRegister(), loadStudents(), loadLeads()]); })
      .catch(() => clearCoachToken())
      .finally(() => setBooting(false));
    ksApi.skills().then(r => setSkills(r.skills)).catch(() => { /* chips hide */ });
  }, [load, loadRegister, loadStudents, loadLeads]);

  const afterMark = useCallback(() => {
    load(week);
    loadRegister();
  }, [load, loadRegister, week]);

  const shiftWeek = (days: number) => {
    const base = schedule ? new Date(`${schedule.week_start}T00:00:00`) : new Date();
    base.setDate(base.getDate() + days);
    const iso = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
    setWeek(iso);
    load(iso);
  };

  const goToday = () => { setWeek(undefined); load(undefined); };

  const goWeek = (iso: string) => { setWeek(iso); load(iso); };

  const goStudents = (name: string) => { setStudentFocus(name); setTab('students'); };

  const toggleDone = async (b: KsBooking) => {
    try {
      await ksApi.complete(b.ref, b.status !== 'completed');
      await load(week);
    } catch (e: any) {
      setError(e?.message || 'Could not update that session.');
    }
  };

  const signOut = async () => {
    try { await ksApi.coachLogout(); } catch { /* already gone */ }
    clearCoachToken();
    setCoach(null);
    setSchedule(null);
  };

  const pickTab = (t: CoachTab) => { setTab(t); setDrawer(false); setError(''); };

  if (booting) {
    return (
      <KSShell nav={false}>
        <div className="flex min-h-screen items-center justify-center text-slate-400"><Spinner /></div>
      </KSShell>
    );
  }

  if (!coach) {
    return <KSShell nav={false}><CoachLogin onAuthed={c => { setCoach(c); load(); loadRegister(); loadLeads(); }} /></KSShell>;
  }

  const badges: Partial<Record<CoachTab, number>> = {
    dashboard: unmarked.length,
    leads: leads.filter(l => l.status === 'new').length,
  };
  const activeLabel = NAV.find(n => n.id === tab)?.label || '';

  const sidebarFooter = (
    <div className="border-t border-slate-200 p-3">
      <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#FF8A2B] to-[#FF6B00] text-xs font-extrabold text-white">
          {coach.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold text-slate-900">{coach.name}</div>
          <div className="text-[11px] text-slate-400">KS Coach</div>
        </div>
        <button onClick={signOut} title="Sign out"
          className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600">
          <Icon name="logout" size={18} />
        </button>
      </div>
    </div>
  );

  return (
    <KSShell nav={false} footer={false}>
      <div className="flex min-h-screen bg-slate-50">
        {/* ── Desktop sidebar ─────────────────────────────────────── */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
          <div className="flex items-center gap-2.5 border-b border-slate-200 p-4">
            <KSMark size={34} />
            <div className="min-w-0">
              <div className="truncate text-sm font-extrabold tracking-tight text-slate-900">KS Sports</div>
              <div className="text-[11px] font-medium text-slate-400">Coach dashboard</div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <NavItems tab={tab} onPick={pickTab} badges={badges} />
          </div>
          {sidebarFooter}
        </aside>

        {/* ── Main column ─────────────────────────────────────────── */}
        <div className="min-w-0 flex-1">
          {/* Mobile top bar */}
          <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur-md lg:hidden">
            <button onClick={() => setDrawer(true)} aria-label="Open menu"
              className="grid h-9 w-9 place-items-center rounded-xl text-slate-600 transition-colors hover:bg-slate-100">
              <Icon name="menu" size={22} />
            </button>
            <KSMark size={30} />
            <div className="min-w-0 flex-1 truncate font-extrabold tracking-tight text-slate-900">
              {activeLabel}
            </div>
            <button onClick={() => { load(week); loadRegister(); }} aria-label="Refresh"
              className="grid h-9 w-9 place-items-center rounded-xl text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800">
              <Icon name="refresh" size={20} />
            </button>
          </header>

          <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
            {error && (
              <div className="mb-5"><KSAlert>{error}</KSAlert></div>
            )}
            {/* keyed on the tab so every switch plays the entrance animation */}
            <div key={tab} className="animate-fadeInUp">
              {tab === 'dashboard' && (
                <DashboardTab coachName={coach.name} schedule={schedule} unmarked={unmarked}
                  skills={skills} onToggle={toggleDone} afterMark={afterMark}
                  goCalendar={() => pickTab('calendar')} />
              )}
              {tab === 'calendar' && (
                <CalendarTab schedule={schedule} loading={!schedule} students={students}
                  skills={skills} onToggle={toggleDone} afterMark={afterMark}
                  onShiftWeek={shiftWeek} onGoWeek={goWeek} onToday={goToday}
                  onViewStudent={goStudents}
                  refresh={() => { load(week); loadRegister(); }} />
              )}
              {tab === 'route' && <RouteTab />}
              {tab === 'students' && (
                <StudentsTab students={students} attendance={attendance}
                  focus={studentFocus} onReload={loadStudents} />
              )}
              {tab === 'leads' && <LeadsTab leads={leads} onReload={loadLeads} />}
              {tab === 'finance' && <FinanceTab />}
              {tab === 'settings' && (
                <SettingsTab coach={coach} onChanged={() => load(week)} onSignOut={signOut} />
              )}
            </div>
          </main>
        </div>
      </div>

      {/* ── Mobile drawer ───────────────────────────────────────────── */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
          <div onClick={e => e.stopPropagation()}
            className="absolute right-0 top-0 flex h-full w-72 flex-col bg-white shadow-2xl animate-slideInRight">
            <div className="flex items-center gap-2.5 border-b border-slate-200 p-4">
              <KSMark size={32} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-extrabold tracking-tight text-slate-900">KS Sports</div>
                <div className="text-[11px] font-medium text-slate-400">Coach dashboard</div>
              </div>
              <button onClick={() => setDrawer(false)} aria-label="Close menu"
                className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">
                <Icon name="close" size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <NavItems tab={tab} onPick={pickTab} badges={badges} />
            </div>
            {sidebarFooter}
          </div>
        </div>
      )}

    </KSShell>
  );
}
