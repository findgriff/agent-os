// Thin fetch wrapper. Same-origin in production (Python server serves the
// SPA); Vite proxies /api to :8100 in dev. The bearer token lives in
// localStorage under `agentos_token`.
import type {
  Agent, Tenant, User, LogEntry, InboxMessage, Memory, MissionControl,
  Overview, BridgesResponse, Connection, Metrics, GalaxyStar,
  ChatResponse, StudioModel, StudioResult,
  Pipeline, PipelineRun, KanbanTask, AgentBrief, Room, RoomMessage,
  WorkspaceItem, WorkspaceStats, Lead, Campaign, AgentEmail, EmailMetrics,
  VoiceSession, ApolloCommand, ApolloCommandResult,
} from './types';

const TOKEN_KEY = 'agentos_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    if (res.status === 401) clearToken();
    throw new ApiError(res.status, data.error || res.statusText);
  }
  return data as T;
}

const qs = (params: Record<string, unknown>) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
};

export const api = {
  // auth
  login: (email: string, password: string) =>
    req<{ token: string; user: User }>('POST', '/api/auth/login', { email, password }),
  me: () => req<{ user: User }>('GET', '/api/me'),
  setPassword: (password: string) => req<{ ok: boolean }>('POST', '/api/auth/set-password', { password }),

  // tenants
  tenants: () => req<{ tenants: Tenant[] }>('GET', '/api/tenants'),
  updateTenant: (id: number, data: Partial<Tenant>) =>
    req<{ tenant: Tenant }>('PATCH', `/api/tenants/${id}`, data),

  // agents
  agents: (tenantId?: number) =>
    req<{ agents: Agent[] }>('GET', '/api/agents' + qs({ tenant_id: tenantId })),
  agent: (id: number) => req<{ agent: Agent }>('GET', `/api/agents/${id}`),
  createAgent: (data: Partial<Agent> & { tenant_id: number }) =>
    req<{ agent: Agent }>('POST', '/api/agents', data),
  updateAgent: (id: number, data: Record<string, unknown>) =>
    req<{ agent: Agent }>('PATCH', `/api/agents/${id}`, data),
  toggleAgent: (id: number) => req<{ enabled: boolean }>('POST', `/api/agents/${id}/toggle`),
  runAgent: (id: number) => req<{ result: any }>('POST', `/api/agents/${id}/run`),
  agentLog: (id: number, limit = 50) =>
    req<{ logs: LogEntry[] }>('GET', `/api/agents/${id}/log` + qs({ limit })),
  agentMemory: (id: number) => req<{ memories: Memory[] }>('GET', `/api/agents/${id}/memory`),
  writeMemory: (id: number, data: Partial<Memory>) =>
    req<{ id: number }>('POST', `/api/agents/${id}/memory`, data),
  agentInbox: (id: number) => req<{ messages: InboxMessage[] }>('GET', `/api/agents/${id}/inbox`),
  sendMessage: (id: number, data: { subject: string; body: string; from_agent_id?: number }) =>
    req<{ id: number }>('POST', `/api/agents/${id}/inbox`, data),

  // mission control / metrics / overview
  missionControl: (tenantId?: number) =>
    req<MissionControl>('GET', '/api/mission-control' + qs({ tenant_id: tenantId })),
  metrics: (tenantId?: number) =>
    req<Metrics>('GET', '/api/metrics' + qs({ tenant_id: tenantId })),
  overview: () => req<Overview>('GET', '/api/overview'),

  // vault
  vaultMemories: (tenantId?: number, topic?: string) =>
    req<{ memories: Memory[] }>('GET', '/api/vault/memories' + qs({ tenant_id: tenantId, topic })),
  vaultSync: () => req<{ synced: number }>('POST', '/api/vault/sync'),
  galaxy: (tenantId?: number) =>
    req<{ memories: GalaxyStar[]; constellations: string[]; count: number }>(
      'GET', '/api/vault/galaxy' + qs({ tenant_id: tenantId })),
  vaultAddMemory: (data: { topic?: string; fact: string; metadata?: Record<string, string>; tenant_id?: number }) =>
    req<{ path: string; topic: string; fact: string }>('POST', '/api/vault/memories', data),

  // bridges
  bridges: () => req<BridgesResponse>('GET', '/api/bridges'),
  addBridge: (data: { platform: string; label?: string; config?: Record<string, string> }) =>
    req<{ connection: Connection }>('POST', '/api/bridges', data),
  updateBridge: (id: number, data: Record<string, unknown>) =>
    req<{ connection: Connection }>('PATCH', `/api/bridges/${id}`, data),
  deleteBridge: (id: number) => req<{ ok: boolean }>('DELETE', `/api/bridges/${id}`),
  testBridge: (id: number) => req<{ result: any }>('POST', `/api/bridges/${id}/test`),
  bridgeChat: (id: number, data: { message: string; take_command?: boolean }) =>
    req<ChatResponse>('POST', `/api/bridges/${id}/chat`, data),

  // studio (image generation)
  studioModels: () => req<{ models: StudioModel[] }>('GET', '/api/studio/models'),
  studioGenerate: (data: Record<string, unknown>) =>
    req<StudioResult>('POST', '/api/studio/generate', data),

  // 1. pipelines
  pipelines: (tenantId?: number) =>
    req<{ pipelines: Pipeline[] }>('GET', '/api/pipelines' + qs({ tenant_id: tenantId })),
  pipeline: (id: number) => req<{ pipeline: Pipeline }>('GET', `/api/pipelines/${id}`),
  createPipeline: (data: { name: string; steps?: unknown[]; tenant_id?: number; enabled?: boolean }) =>
    req<{ pipeline: Pipeline }>('POST', '/api/pipelines', data),
  updatePipeline: (id: number, data: Record<string, unknown>) =>
    req<{ pipeline: Pipeline }>('PATCH', `/api/pipelines/${id}`, data),
  deletePipeline: (id: number) => req<{ ok: boolean }>('DELETE', `/api/pipelines/${id}`),
  runPipeline: (id: number) => req<{ run: PipelineRun }>('POST', `/api/pipelines/${id}/run`),
  pipelineRuns: (id: number) => req<{ runs: PipelineRun[] }>('GET', `/api/pipelines/${id}/runs`),

  // 2. kanban
  kanbanTasks: (params: { tenant_id?: number; status?: string; assigned_agent_id?: number } = {}) =>
    req<{ tasks: KanbanTask[] }>('GET', '/api/kanban/tasks' + qs(params)),
  createKanbanTask: (data: Record<string, unknown>) =>
    req<{ task: KanbanTask }>('POST', '/api/kanban/tasks', data),
  updateKanbanTask: (id: number, data: Record<string, unknown>) =>
    req<{ task: KanbanTask }>('PATCH', `/api/kanban/tasks/${id}`, data),
  deleteKanbanTask: (id: number) => req<{ ok: boolean }>('DELETE', `/api/kanban/tasks/${id}`),
  autoAssignTask: (id: number) =>
    req<{ task: KanbanTask; reason: string; agent: AgentBrief | null }>(
      'POST', `/api/kanban/tasks/${id}/auto-assign`),

  // 3. war room
  chatRooms: (tenantId?: number) =>
    req<{ rooms: Room[] }>('GET', '/api/chat/rooms' + qs({ tenant_id: tenantId })),
  createRoom: (data: { name: string; tenant_id?: number }) =>
    req<{ room: Room }>('POST', '/api/chat/rooms', data),
  roomMessages: (id: number) =>
    req<{ messages: RoomMessage[]; room: Room }>('GET', `/api/chat/rooms/${id}/messages`),
  sendRoomMessage: (id: number, data: { text: string; from_agent_id?: number | null; reply?: boolean }) =>
    req<{ message: RoomMessage; replies: RoomMessage[] }>('POST', `/api/chat/rooms/${id}/messages`, data),
  summarizeRoom: (id: number) =>
    req<{ summary: string }>('POST', `/api/chat/rooms/${id}/summarize`),

  // 4. workspace gallery
  workspace: (params: { tenant_id?: number; type?: string; agent_id?: number; model?: string; project?: string; q?: string } = {}) =>
    req<{ items: WorkspaceItem[] }>('GET', '/api/workspace' + qs(params)),
  saveWorkspaceItem: (data: Record<string, unknown>) =>
    req<{ item: WorkspaceItem }>('POST', '/api/workspace', data),
  deleteWorkspaceItem: (id: number) => req<{ ok: boolean }>('DELETE', `/api/workspace/${id}`),
  workspaceStats: (tenantId?: number) =>
    req<WorkspaceStats>('GET', '/api/workspace/stats' + qs({ tenant_id: tenantId })),

  // 5. leads + campaigns
  leadsSearch: (data: { industry?: string; keywords?: string; location?: string; count?: number; tenant_id?: number; campaign_id?: number }) =>
    req<{ leads: Lead[]; count: number }>('POST', '/api/leads/search', data),
  leads: (params: { tenant_id?: number; status?: string; campaign_id?: number } = {}) =>
    req<{ leads: Lead[] }>('GET', '/api/leads' + qs(params)),
  updateLead: (id: number, data: Record<string, unknown>) =>
    req<{ lead: Lead }>('PATCH', `/api/leads/${id}`, data),
  convertLead: (id: number) => req<{ lead: Lead }>('POST', `/api/leads/${id}/convert`),
  campaigns: (tenantId?: number) =>
    req<{ campaigns: Campaign[] }>('GET', '/api/campaigns' + qs({ tenant_id: tenantId })),
  createCampaign: (data: { name: string; tenant_id?: number; status?: string }) =>
    req<{ campaign: Campaign }>('POST', '/api/campaigns', data),
  campaign: (id: number) => req<{ campaign: Campaign }>('GET', `/api/campaigns/${id}`),

  // 6. email
  emailInbox: (params: { tenant_id?: number; status?: string } = {}) =>
    req<{ emails: AgentEmail[] }>('GET', '/api/email/inbox' + qs(params)),
  sendEmail: (data: { to: string; subject: string; body: string; from_agent_id?: number; tenant_id?: number }) =>
    req<{ email: AgentEmail }>('POST', '/api/email/send', data),
  updateEmailStatus: (id: number, status: string) =>
    req<{ email: AgentEmail }>('PATCH', `/api/email/${id}/status`, { status }),
  emailMetrics: (tenantId?: number) =>
    req<EmailMetrics>('GET', '/api/email/metrics' + qs({ tenant_id: tenantId })),

  // 7. voice
  voiceTranscribe: (data: { transcript?: string; text?: string }) =>
    req<{ transcript: string; provider: string }>('POST', '/api/voice/transcribe', data),
  voiceChat: (data: { transcript: string; duration?: number; tenant_id?: number }) =>
    req<{ session: VoiceSession; response: string }>('POST', '/api/voice/chat', data),
  voiceHistory: (tenantId?: number) =>
    req<{ sessions: VoiceSession[] }>('GET', '/api/voice/history' + qs({ tenant_id: tenantId })),
  deleteVoiceSession: (id: number) => req<{ ok: boolean }>('DELETE', `/api/voice/history/${id}`),

  // 7b. apollo — real-time voice butler
  apolloCommand: (data: { text: string; tenant_id?: number }) =>
    req<ApolloCommandResult>('POST', '/api/apollo/command', data),
  apolloChat: (data: { text: string; tenant_id?: number }) =>
    req<{ response: string }>('POST', '/api/apollo/chat', data),
  apolloTts: (data: { text: string; voice?: string }) =>
    req<{ audio_url: string }>('POST', '/api/apollo/tts', data),
  apolloHistory: (tenantId?: number) =>
    req<{ commands: ApolloCommand[] }>('GET', '/api/apollo/history' + qs({ tenant_id: tenantId })),

  // 8. Hermes Oracle
  oracleScan: (keywords: string[], tenantId?: number) =>
    req<{ headlines: any[]; ideas: any[]; scan_id?: number }>(
      'POST', '/api/oracle/scan', { keywords, tenant_id: tenantId }),
  oracleHistory: () => req<{ scans: any[] }>('GET', '/api/oracle/history'),

  // 9. Fire Coral Search
  searchQuery: (query: string, topK = 10) =>
    req<{ results: any[] }>('POST', '/api/search/query', { query, top_k: topK }),
  searchAgents: (query: string, agentId: number, topK = 10) =>
    req<{ results: any[] }>('POST', '/api/search/agents', { query, top_k: topK, agent_id: agentId }),
};

export function timeAgo(ts?: number | null): string {
  if (!ts) return 'never';
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
