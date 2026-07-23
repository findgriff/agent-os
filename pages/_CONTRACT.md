# AGENT OS frontend contract (READ BEFORE WRITING A PAGE)

Stack: React 18 + TypeScript + Tailwind + react-router-dom v6. Vite. Dark theme.
Every page file lives in `/opt/agent-os/pages/` and **default-exports** a React component.

## Palette (Tailwind tokens already configured in tailwind.config.js)
bg `#05080C`, surface `#0D1520`, raised `#141E2D`, accent `#19C3E6` (teal),
sky `#38BDF8`, violet `#A78BFA`, amber `#F59E0B`, rose `#F43F5E`, emerald `#22C55E`,
ink `#E8EDF5` (text), muted `#7B8DA8`. Use as `bg-accent`, `text-muted`, `border-rose/25`, etc.
Fonts: `font-display` (Space Grotesk, headings), `font-sans` (Inter, default), `font-mono`.
Utility classes available in CSS: `.glass`, `.glass-raised`, `.card`, `.aurora-bg`, `.animate-fadeInUp`.
Tailwind animations: `animate-fadeInUp animate-pulseGlow animate-twinkle animate-float animate-slideInRight animate-aurora`.
Arbitrary anim ok: `animate-[fadeInUp_0.5s_ease-out]`. Stagger with inline `style={{animationDelay:`${i*60}ms`}}`.

## components/ui.tsx exports
`Icon({name,size?,fill?,className?})` — Material Symbols Rounded (e.g. name="radar").
`Button({variant?,icon?,loading?,...})` variant: primary|secondary|ghost|danger|glass.
`Card({glass?,hover?,className?,...})`, `Badge({tone?,dot?})` tone: ok|warn|danger|info|neutral|violet.
`STATUS_TONE` (Record status→tone), `TEAM_COLOUR` (Record team→hex).
`Toggle({checked,onChange,disabled?})`, `Textarea`, `Input`, `Select`,
`Modal({open,onClose,title?,width?})`, `Drawer({open,onClose,width?})`,
`EmptyState({icon?,title,hint?})`, `SkeletonList({count?})`,
`useToast()` → `(msg, tone?)=>void`, `Stat({label,value,icon?,accent?,delay?})`,
`useCountUp(target,ms?)`→number.

## Other components
`import { Avatar } from '../components/Avatar'` — `Avatar({colour?,initials?,size?,glow?,status?})` status: idle|running|flagged|error.
`import { Sparkline } from '../components/Sparkline'` — `Sparkline({data:number[],colour?,height?,width?,showAxis?})`.
`import { Galaxy, CONSTELLATION_COLOUR } from '../components/Galaxy'` —
  `Galaxy({memories:GalaxyStar[],interactive?,mini?,filter?,bloom?,selectedId?,onMemoryClick?,onHover?,className?})`.
  Container must have explicit height (e.g. wrap in `<div className="h-full">`).
`import { Logo } from '../components/Logo'` — `Logo({size?,showText?})`.

## State + API
`import { useApp } from '../lib/store'` → `{ user, tenants, selectedTenant, setSelectedTenant, refreshTenants, logout }`.
  `selectedTenant` is `number|null` (null = All Projects). Pass it to APIs that accept a tenantId.
`import { api, timeAgo } from '../lib/api'`. All methods return Promises; wrap in try/catch.
Key methods (see lib/api.ts / lib/types.ts for exact shapes):
  api.overview(), api.tenants(), api.agents(tenantId?), api.agent(id), api.runAgent(id),
  api.toggleAgent(id), api.updateAgent(id,data), api.agentLog(id), api.agentMemory(id),
  api.writeMemory(id,data), api.agentInbox(id), api.sendMessage(id,{subject,body,from_agent_id?}),
  api.missionControl(tenantId?), api.metrics(tenantId?), api.vaultMemories(tenantId?,topic?),
  api.vaultSync(), api.galaxy(tenantId?), api.bridges(), api.addBridge({platform,label?,config?}),
  api.updateBridge(id,data), api.deleteBridge(id), api.testBridge(id).
`timeAgo(ts?:number)` → "3m ago". Timestamps are unix seconds.
Types: `import type { Agent, Tenant, Memory, GalaxyStar, MissionControl, Overview, Metrics, Connection, BridgesResponse, LogEntry, InboxMessage } from '../lib/types'`.

## Rules
- Default export the page component. No prop required unless stated.
- Use ONLY the exports above. Do not invent api methods or ui exports.
- Fully responsive (mobile→desktop). Smooth 60fps animations; entrance fade/stagger.
- Load data in useEffect; show SkeletonList while loading, EmptyState when empty.
- Re-fetch when `selectedTenant` changes (add it to useEffect deps).
- Keep it self-contained in one file. No new dependencies.
