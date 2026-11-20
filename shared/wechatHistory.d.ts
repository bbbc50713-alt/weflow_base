export interface HistoryOptions {
  ordinalRange?: { first:number; last:number; owner:string }
  kinds?: import('./historyKinds').HistoryKind[]
  sessions: string[]
  start: number
  end: number
  media: boolean
  continuous: boolean
}

export interface HistoryBinding {
  id: number
  tenant_id: number
  tenant_name: string
  channel_account_id: number
  account_name: string
  account_wxid: string
  account_status: string
}

export interface SessionProgress {
  id: string
  name: string
  group: boolean
  total: number
  processed: number
  failed: number
  phase: 'waiting' | 'counting' | 'queued' | 'syncing' | 'done' | 'failed' | 'skipped'
  issue?: string
  inserted?: number
  existing?: number
}
export interface HistoryStatus {
  concurrencyLimit?: number
  activeSessions?: number
  sessionProgress?: SessionProgress[]
  progressPhase?: 'counting' | 'processing' | 'done'

  initialScanComplete?: boolean
  typeFilterVersion?: 1
  origin: string
  accountWxid: string
  binding?: HistoryBinding
  status: 'unbound' | 'idle' | 'running' | 'paused' | 'offline' | 'partial' | 'completed'
  options: HistoryOptions
  runId?: string
  currentSession?: string
  completedSessions: number
  totalSessions: number
  scanned: number
  inserted: number
  existing: number
  failed: number
  mediaPending: number
  mediaUploaded: number
  lastSuccess?: string
  error?: string
  problems: Array<{ session_wxid: string; source_key?: string; error: string }>
}

export interface HistorySession {
  wxid: string
  display_name: string
  nickname: string
  remark: string
  avatar_url: string
  members: Array<{ wxid: string; nickname: string; display_name: string }>
}

export interface WechatHistoryMessageV1 {
  source_key: string
  server_id: string | null
  local_id: string
  shard: string
  table: string
  occurred_at: string
  sort_seq: string
  direction: 'inbound' | 'outbound'
  sender_wxid: string
  sender_name: string
  local_type: number
  content: string
  raw_content: string
  reply_to_server_id: string | null
  media_kind: 'image' | 'voice' | 'video' | 'file' | 'emoji' | null
}

export interface HistorySyncApi {
  status(): Promise<HistoryStatus>
  sessions(): Promise<Array<{ id: string; name: string; group: boolean; ordinal?:number }>>
  bind(origin: string, code: string): Promise<HistoryStatus>
  unbind(): Promise<HistoryStatus>
  start(options: HistoryOptions): Promise<HistoryStatus>
  pause(): Promise<HistoryStatus>
  resume(): Promise<HistoryStatus>
  retry(): Promise<HistoryStatus>
  onPreviewRow(callback: (event: { requestId: string; row: SessionProgress; total: number }) => void): () => void
  preview(options: HistoryOptions, requestId?: string): Promise<SessionProgress[]>
  review(): Promise<{ id: string; partitions: Array<{ session_wxid: string; date: string; source_records: number; matched: number; unresolved: number; media: Record<string, number> }> }>
  rescan(): Promise<HistoryStatus>
  report(): Promise<{ path?: string }>
  onStatus(callback: (status: HistoryStatus) => void): () => void
}
