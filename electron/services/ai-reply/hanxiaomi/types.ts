import type { Message } from '../../chatService'
import type { DeliveryPolicy } from '../queue/DeliveryPacer'

export type HanxiaomiScenario =
  | 'reply'
  | 'reactivation'
  | 'repurchase'
  | 'new_customer'
  | 'maintenance'

export type HanxiaomiMode = 'auto' | 'manual'
export type HanxiaomiAction = 'send' | 'draft' | 'skip' | 'handoff'

export type HanxiaomiDeliveryPolicyConfig = Pick<
  DeliveryPolicy,
  | 'minDelayMs'
  | 'maxDelayMs'
  | 'postSendGapMsMin'
  | 'postSendGapMsMax'
  | 'perContactCooldownMs'
  | 'staleAfterMs'
  | 'splitMinGapMs'
  | 'splitMaxGapMs'
>

export interface HanxiaomiChannelConfig {
  enabled: boolean
  serviceUrl: string
  keyId: string
  signingSecret: string
  timeoutMs: number
  identitySalt?: string
  inboundConcurrency?: number
  deliveryPolicy?: Partial<HanxiaomiDeliveryPolicyConfig>
}

export interface HanxiaomiContactInfo {
  display_name?: string
  remark?: string
  alias?: string
  labels?: string[]
  extra?: Record<string, unknown>
}

export interface HanxiaomiContextMessage {
  message_key: string
  role: 'customer' | 'operator'
  timestamp: string
  content: string
  content_type: string
  sender_ref?: string
}

export interface HanxiaomiReplyRequest {
  account_ref: string
  subject_ref: string
  external_session_key: string
  chat_type: 'private'
  mode: HanxiaomiMode
  scenario: HanxiaomiScenario
  current_message: HanxiaomiContextMessage
  history: HanxiaomiContextMessage[]
  contact: HanxiaomiContactInfo
  long_profile?: string
  request_meta?: Record<string, unknown>
}

export interface HanxiaomiReplyResponse {
  request_id: string
  reply_to_message_key: string
  action: HanxiaomiAction
  text: string
  segments?: string[]
}

export interface HanxiaomiContextProvider {
  getLatestMessages(contactId: string, limit: number): Promise<{ success: boolean; messages?: Message[]; error?: string }>
  getContact(contactId: string): Promise<any>
  getLongProfile(contactId: string): Promise<string>
  getAccountId(): string
}

export interface HanxiaomiContextBuildInput {
  accountId: string
  contactId: string
  contactName: string
  isFirstSuccessfulCall: boolean
  currentContent: string
  bufferedMessages: Array<{
    msgId: string
    messageKey?: string
    localId?: number | string
    serverId?: number | string
    serverIdRaw?: string
    content: string
    timestamp: number
    type?: number
    senderId?: string
  }>
  mode: HanxiaomiMode
  scenario: HanxiaomiScenario
  identitySalt: string
  provider: HanxiaomiContextProvider
}

export interface HanxiaomiDeliveryLedgerEntry {
  eventKey: string
  contactId: string
  contactName?: string
  messageKey: string
  requestHash: string
  requestId?: string
  action?: HanxiaomiAction
  text?: string
  segments?: string[]
  status:
    | 'requested'
    | 'completed'
    | 'draft'
    | 'queued'
    | 'sending'
    | 'sent'
    | 'send_failed'
    | 'skipped'
    | 'failed'
    | 'cancelled'
    | 'superseded'
  error?: string
  scenario?: HanxiaomiScenario
  mode?: HanxiaomiMode
  updatedAt: number
}
