export type Status = 'idle' | 'running' | 'flagged' | 'error';
export type Team = 'marketing' | 'sales' | 'technical' | 'platform';
export type ModelName = 'deepseek' | 'claude' | 'kimi';

export interface User {
  id: number; email: string; name: string; role: string; tenant_id: number;
}

export interface Tenant {
  id: number; name: string; slug: string; brand_colour: string;
  agent_count: number; active_count: number; error_count: number;
  last_activity: number | null; settings?: Record<string, unknown>;
}

export interface Agent {
  id: number; tenant_id: number; tenant_name?: string;
  slug: string; name: string; real_name?: string; role?: string;
  brand?: string; enabled: number | boolean;
  last_status: Status; last_summary?: string; last_run_at?: number | null;
  certificate: Record<string, any>;
  soul_text?: string;
  team?: Team; avatar_colour?: string; avatar_initials?: string;
  default_model: ModelName; generates: boolean;
}

export interface LogEntry {
  id: number; agent_id: number; action: string; summary: string;
  details: Record<string, any>; token_count: number; cost_usd: number;
  created_at: number;
}

export interface InboxMessage {
  id: number; to_agent_id: number; from_agent_id: number | null;
  subject: string; body: string; status: string; thread_id: number;
  from_name?: string; from_real?: string; to_name?: string; created_at: number;
}

export interface Memory {
  id: number; topic: string; fact: string; confidence: number;
  memory_type: 'collective' | 'personal'; usage_count?: number;
  agent_id?: number | null; source?: string; created_at?: number;
}

export interface GalaxyStar {
  id: number; topic: string; fact: string; confidence: number;
  usage_count: number; agent_name: string;
  type: 'collective' | 'personal'; constellation: string;
  connected_to: number[];
  source?: string | null; created_at?: number | null;
}

// ── Integration chat ──────────────────────────────────────────────────────
export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  ts: number;
  pending?: boolean;
  error?: boolean;
  broadcast?: Array<{ id: number; platform: string; label: string; reply: string }>;
}

export interface ChatResponse {
  reply: string; ok: boolean; take_command: boolean;
  broadcast: Array<{ id: number; platform: string; label: string; reply: string }>;
}

// ── Image Studio ──────────────────────────────────────────────────────────
export interface StudioModel {
  id: string; label: string; blurb: string;
  steps: number; max_steps: number; guidance: boolean; negative: boolean; cost: number;
}

export interface StudioImage {
  url: string; seed: number | null; model: string;
  width?: number; height?: number; remote_url?: string;
}

export interface StudioResult {
  images: StudioImage[]; model: string; cost: number;
}

export interface MCTelemetry {
  uptime_pct: number; success_rate: number | null; avg_latency_ms: number | null;
  api_calls_today: number; error_rate_hour: number; errors_hour: number; calls_hour: number;
}

export interface MCMatrixRow {
  id: number; name: string; team: Team | null; colour: string; initials: string;
  status: Status; enabled: boolean; active: boolean; last_run_at: number | null;
  success_rate: number | null; avg_latency_ms: number | null;
  tasks_today: number; memory_count: number;
}

export interface MCAlert {
  id: string; severity: 'critical' | 'warn' | 'info';
  message: string; at: number | null; agent_id: number | null;
}

export interface MissionControl {
  total: number; active_now: number; drafts_today: number; messages_today: number;
  tokens_today: number; cost_today: number;
  teams: Record<Team, { total: number; active: number; drafts: number }>;
  health: Array<{ id: number; name: string; status: Status; team: Team;
    colour: string; initials: string; active: boolean; enabled: boolean }>;
  telemetry?: MCTelemetry;
  matrix?: MCMatrixRow[];
  series?: { tokens_24h: number[]; tasks_24h: number[]; errors_24h: number[]; cost_7d: number[] };
  alerts?: MCAlert[];
  recent_activity: Array<any>; recent_messages: InboxMessage[]; generated_at: number;
}

export interface Overview {
  projects: Array<{ id: number; name: string; slug: string; brand_colour: string;
    agent_count: number; active_count: number; error_count: number;
    runs_today: number; latest: any }>;
  recent_activity: Array<any>;
  stats: { total_agents: number; active_now: number; total_memories: number; runs_today: number };
}

export interface Connection {
  id: number; tenant_id: number; platform: string; label: string;
  config: Record<string, string>; enabled: boolean;
  last_sync_at: number | null; last_status: string;
  meta: { label: string; kind: string; blurb: string };
}

export interface BridgesResponse {
  connections: Connection[];
  available: Array<{ platform: string; meta: { label: string; kind: string; blurb: string } }>;
}

export interface Metrics {
  today: { tokens: number; cost_usd: number; runs: number };
  week: { tokens: number; cost_usd: number; runs: number };
  all_time: { tokens: number; cost_usd: number; runs: number };
  by_model: Record<string, { tokens: number; cost_usd: number }>;
  trends: { labels: string[]; tokens: number[]; cost_usd: number[]; runs: number[] };
}

// ── Agent brief (embedded in feature DTOs) ─────────────────────────────────
export interface AgentBrief {
  id: number; name: string; colour: string; initials: string;
}

// ── 1. Workflow pipelines ──────────────────────────────────────────────────
export interface PipelineStep {
  type: string; config: Record<string, any>; position: number; label?: string;
}
export interface PipelineRunStep {
  position: number; type: string; label: string;
  status: 'ok' | 'error' | 'skipped'; output: string; ms: number;
}
export interface PipelineRun {
  id: number; pipeline_id: number;
  status: 'running' | 'success' | 'error' | 'partial';
  started_at: number; finished_at: number | null;
  result: { status: string; steps: PipelineRunStep[]; ok: number; errors: number; total: number };
  error: string | null;
}
export interface Pipeline {
  id: number; tenant_id: number; name: string; steps: PipelineStep[];
  enabled: boolean; created_at: number; updated_at: number;
  run_count: number; last_run_at: number | null; last_status: string | null;
  runs?: PipelineRun[];
}

// ── 2. Kanban board ─────────────────────────────────────────────────────────
export type KanbanStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export interface KanbanTask {
  id: number; tenant_id: number; title: string; description?: string | null;
  status: KanbanStatus; priority: Priority;
  assigned_agent_id: number | null; labels: string[];
  due_date: number | null; position: number;
  created_at: number; updated_at: number; agent: AgentBrief | null;
}

// ── 3. Group chat (war room) ────────────────────────────────────────────────
export interface RoomParticipant { id: number | null; name: string; colour: string; }
export interface Room {
  id: number; tenant_id: number; name: string; created_at: number;
  message_count: number; last_at: number | null; participants: RoomParticipant[];
}
export interface RoomMessage {
  id: number; room_id: number; from_agent_id: number | null;
  from_name: string; text: string; created_at: number;
  colour?: string | null; initials?: string | null;
}

// ── 4. Workspace gallery ────────────────────────────────────────────────────
export interface WorkspaceItem {
  id: number; tenant_id: number; agent_id: number | null;
  type: string; title: string; description?: string | null;
  url: string; thumbnail: string; model?: string | null; project?: string | null;
  agent_name?: string | null; agent_colour: string; agent_initials?: string | null;
  tags: string[]; created_at: number;
}
export interface WorkspaceStats { by_type: Record<string, number>; total: number; }

// ── 5. Lead generation ──────────────────────────────────────────────────────
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'converted' | 'lost';
export interface Lead {
  id: number; tenant_id: number; company: string;
  contact_name?: string | null; email?: string | null; phone?: string | null;
  source?: string | null; status: LeadStatus;
  campaign_id: number | null; campaign_name?: string | null;
  notes?: string | null; created_at: number;
}
export interface Campaign {
  id: number; tenant_id: number; name: string; status: string;
  sent_count: number; reply_count: number; conversion_rate: number; created_at: number;
  lead_count: number; converted_count: number; reply_rate: number;
  leads?: Lead[]; email_preview?: string;
}

// ── 6. Email agent ──────────────────────────────────────────────────────────
export type EmailStatus = 'unread' | 'read' | 'replied' | 'archived' | 'sent' | 'bounced';
export interface AgentEmail {
  id: number; tenant_id: number; to_agent_id: number | null;
  from_address?: string | null; to_address?: string | null;
  subject?: string | null; body?: string | null; status: EmailStatus; created_at: number;
  agent_name?: string | null; agent_colour: string; agent_initials?: string | null;
}
export interface EmailMetrics {
  sent_today: number; reply_rate: number; bounce_rate: number;
  received: number; unread: number; replied: number; sent_total: number;
}

// ── 7. Voice agent ──────────────────────────────────────────────────────────
export interface VoiceSession {
  id: number; tenant_id: number; transcript?: string | null;
  response?: string | null; duration: number; created_at: number;
}

// ── Apollo — real-time voice butler ────────────────────────────────────────
export type ApolloIntent = 'chat' | 'open' | 'build' | 'search' | 'joke' | 'teach';
export type ApolloAction = 'open' | 'build' | 'search' | null;

export interface ApolloOpenResult { target: string; url: string; opened: boolean; }
export interface ApolloBuildResult {
  kind: string; title: string; description: string; filename: string;
  path: string; url: string; model_built?: boolean; error?: string;
}
export interface ApolloSearchHit { title: string; url: string; snippet?: string; source?: string; }
export interface ApolloSearchResult { query: string; results: ApolloSearchHit[]; }
export type ApolloResult =
  ApolloOpenResult | ApolloBuildResult | ApolloSearchResult | null;

export interface ApolloCommandResult {
  id: number; intent: ApolloIntent; action: ApolloAction;
  response: string; result: ApolloResult; status: string; latency_ms: number;
}

export interface ApolloCommand {
  id: number; tenant_id: number; text: string; response: string | null;
  intent: ApolloIntent | null; action: ApolloAction; result: ApolloResult;
  status: string; latency_ms: number; created_at: number;
}
