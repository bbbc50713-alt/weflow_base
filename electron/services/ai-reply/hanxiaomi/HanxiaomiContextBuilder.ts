import * as crypto from 'crypto'
import { markdownToPlainText } from '../utils/markdownToPlainText'
import type {
  HanxiaomiContactInfo,
  HanxiaomiContextBuildInput,
  HanxiaomiContextMessage,
  HanxiaomiReplyRequest
} from './types'
import type { Message } from '../../chatService'

const MEDIA_TYPE_LABELS: Record<number, string> = {
  3: '[图片消息]',
  34: '[语音消息]',
  42: '[名片消息]',
  43: '[视频消息]',
  47: '[表情消息]',
  48: '[位置消息]',
  49: '[链接/文件消息]',
  50: '[通话消息]',
  10000: '[系统消息]',
  244813135921: '[拍一拍消息]',
  8589934592049: '[转账消息]',
  8594229559345: '[红包消息]'
}

export function hashRef(salt: string, value: string): string {
  return crypto.createHmac('sha256', salt).update(value).digest('hex')
}

export function buildHanxiaomiEventKey(contactId: string, messageKey: string): string {
  return `${contactId}:${messageKey}`
}

export function hashHanxiaomiRequest(request: HanxiaomiReplyRequest): string {
  return crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

type BufferedMessageForContext = HanxiaomiContextBuildInput['bufferedMessages'][number]

interface PickedCurrentMessage {
  message: HanxiaomiContextMessage
  source: 'buffered_match' | 'buffered_fallback'
}

export async function buildHanxiaomiReplyRequest(input: HanxiaomiContextBuildInput): Promise<HanxiaomiReplyRequest> {
  if (input.contactId.includes('@chatroom')) {
    throw new Error('汉小密渠道 V1 仅支持私聊')
  }
  if (!input.bufferedMessages.length) {
    throw new Error('汉小密渠道缺少本次触发消息')
  }

  const windowSize = input.isFirstSuccessfulCall ? 50 : 30
  const latestResult = await input.provider.getLatestMessages(input.contactId, windowSize)
  if (!latestResult.success || !Array.isArray(latestResult.messages)) {
    throw new Error(latestResult.error || '读取最近聊天记录失败')
  }

  const bufferedLatest = input.bufferedMessages[input.bufferedMessages.length - 1]
  const normalizedAll = normalizeMessages(latestResult.messages, input.contactId, input.identitySalt)
  const pickedCurrent = pickCurrentMessage(input.contactId, latestResult.messages, input.currentContent, input.identitySalt, bufferedLatest)
  const currentMessage = pickedCurrent.message
  const currentKey = currentMessage.message_key
  const bufferedKeys = new Set(input.bufferedMessages.flatMap(bufferedMessageIdentityTokens))
  const currentTs = Date.parse(currentMessage.timestamp)
  const history = normalizedAll
    .filter(message => {
      if (message.message_key === currentKey) return false
      if (bufferedKeys.has(message.message_key)) return false
      const messageTs = Date.parse(message.timestamp)
      if (Number.isFinite(currentTs) && Number.isFinite(messageTs) && messageTs >= currentTs) return false
      return true
    })
  const precedingLimit = windowSize - 1
  const preceding = history.slice(Math.max(0, history.length - precedingLimit))

  const longProfile = await input.provider.getLongProfile(input.contactId).catch(() => '')
  const contactInfo = await buildContactInfo(input, Boolean(longProfile))
  const accountRef = hashRef(input.identitySalt, `account:${input.accountId}`)
  const subjectRef = hashRef(input.identitySalt, `subject:${input.accountId}:${input.contactId}`)
  const externalSessionKey = hashRef(input.identitySalt, `session:${input.accountId}:${input.contactId}`)

  return {
    account_ref: accountRef,
    subject_ref: subjectRef,
    external_session_key: externalSessionKey,
    chat_type: 'private',
    mode: input.mode,
    scenario: input.scenario,
    current_message: currentMessage,
    history: preceding,
    contact: contactInfo,
    long_profile: longProfile || undefined,
    request_meta: {
      source: 'weflow-electron',
      window_size: windowSize,
      identity_version: 2,
      current_source: pickedCurrent.source,
      buffered_message_count: input.bufferedMessages.length,
      buffered_message_keys: Array.from(bufferedKeys).slice(0, 20),
      source_contact_hash: hashRef(input.identitySalt, `contact:${input.contactId}`),
      account_ref_short: accountRef.slice(0, 12),
      subject_ref_short: subjectRef.slice(0, 12),
      session_key_short: externalSessionKey.slice(0, 12),
      history_first_key: preceding[0]?.message_key,
      history_last_key: preceding[preceding.length - 1]?.message_key
    }
  }
}

async function buildContactInfo(input: HanxiaomiContextBuildInput, hasProfile: boolean): Promise<HanxiaomiContactInfo> {
  const contact = await input.provider.getContact(input.contactId).catch(() => null)
  const raw = contact?.contact || contact || {}
  const displayName = cleanContactText(raw.displayName || raw.display_name || input.contactName)
  const remark = cleanContactText(raw.remark || raw.remarkName || raw.remark_name)
  const alias = cleanContactText(raw.alias)
  const labels = Array.isArray(raw.labels) ? raw.labels.map((item: unknown) => String(item || '').trim()).filter(Boolean) : []
  return {
    display_name: displayName || input.contactName,
    remark: remark || undefined,
    alias: alias || undefined,
    labels,
    extra: {
      source: 'weflow',
      has_profile: hasProfile
    }
  }
}

function pickCurrentMessage(
  contactId: string,
  messages: Message[],
  currentContent: string,
  salt: string,
  latestBuffered: BufferedMessageForContext
): PickedCurrentMessage {
  const sorted = [...messages].sort(compareMessageTimeline)
  const tokens = new Set(bufferedMessageIdentityTokens(latestBuffered))
  const matched = sorted.find(message => messageMatchesBuffered(message, tokens))
  if (matched) {
    const normalized = normalizeMessage(matched, contactId, salt)
    return {
      source: 'buffered_match',
      message: {
        ...normalized,
        role: 'customer',
        content: safeContent(currentContent, Number(matched.localType || latestBuffered.type || 1)),
        content_type: contentType(Number(matched.localType || latestBuffered.type || 1))
      }
    }
  }

  const timestamp = latestBuffered.timestamp || Date.now()
  const fallbackKey = latestBuffered.msgId || latestBuffered.messageKey || `buffer:${contactId}:${timestamp}`
  return {
    source: 'buffered_fallback',
    message: {
      message_key: fallbackKey,
      role: 'customer',
      timestamp: toIsoTimestamp(timestamp),
      content: safeContent(currentContent, latestBuffered.type || 1),
      content_type: contentType(latestBuffered.type || 1),
      sender_ref: latestBuffered.senderId ? hashRef(salt, latestBuffered.senderId) : undefined
    }
  }
}

function normalizeMessages(messages: Message[], contactId: string, salt: string): HanxiaomiContextMessage[] {
  const seen = new Set<string>()
  const output: HanxiaomiContextMessage[] = []
  for (const message of [...messages].sort(compareMessageTimeline)) {
    const normalized = normalizeMessage(message, contactId, salt)
    if (!normalized.message_key || seen.has(normalized.message_key)) continue
    seen.add(normalized.message_key)
    output.push(normalized)
  }
  return output
}

function normalizeMessage(message: Message, contactId: string, salt: string): HanxiaomiContextMessage {
  const messageKey = String(message.messageKey || '').trim()
    || String(message.localId || message.serverId || `${contactId}:${message.createTime}:${message.sortSeq}`)
  const sender = String(message.senderUsername || '').trim()
  return {
    message_key: messageKey,
    role: Number(message.isSend || 0) === 1 ? 'operator' : 'customer',
    timestamp: toIsoTimestamp(Number(message.createTime || 0) * 1000),
    content: safeContent(message.parsedContent || message.content || message.rawContent || '', Number(message.localType || 1)),
    content_type: contentType(Number(message.localType || 1)),
    sender_ref: sender ? hashRef(salt || 'weflow-sender', sender) : undefined
  }
}

function bufferedMessageIdentityTokens(message?: Partial<BufferedMessageForContext>): string[] {
  if (!message) return []
  const tokens = [
    message.msgId,
    message.messageKey,
    message.localId,
    message.serverId,
    message.serverIdRaw
  ]
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
  return Array.from(new Set(tokens))
}

function messageMatchesBuffered(message: Message, bufferedTokens: Set<string>): boolean {
  if (!bufferedTokens.size) return false
  for (const token of messageIdentityTokens(message)) {
    if (bufferedTokens.has(token)) return true
  }
  return false
}

function messageIdentityTokens(message: Message): string[] {
  const anyMessage = message as any
  const tokens = [
    anyMessage.messageKey,
    anyMessage.msgId,
    anyMessage.localId,
    anyMessage.serverId,
    anyMessage.serverIdRaw,
    anyMessage.svrId,
    anyMessage.svrid
  ]
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
  return Array.from(new Set(tokens))
}

function safeContent(raw: string, localType: number): string {
  const text = markdownToPlainText(String(raw || '')).trim()
  if (text) return text.slice(0, 4000)
  return MEDIA_TYPE_LABELS[localType] || '[非文本消息]'
}

function contentType(localType: number): string {
  if (localType === 1) return 'text'
  if (localType === 3) return 'image'
  if (localType === 34) return 'voice'
  if (localType === 43) return 'video'
  if (localType === 47) return 'emoji'
  if (localType === 49 || localType === 8589934592049) return 'appmsg'
  return 'other'
}

function compareMessageTimeline(left: Message, right: Message): number {
  return (Number(left.createTime || 0) - Number(right.createTime || 0))
    || (Number(left.sortSeq || 0) - Number(right.sortSeq || 0))
    || (Number(left.localId || 0) - Number(right.localId || 0))
}

function toIsoTimestamp(timestampMs: number): string {
  const safe = normalizeTimestampMs(timestampMs, Date.now())
  return new Date(safe).toISOString()
}

function cleanContactText(value: unknown): string {
  return String(value || '').trim().slice(0, 100)
}

function normalizeTimestampMs(value: unknown, fallback: number): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  if (raw < 100000000000) return Math.floor(raw * 1000)
  return Math.floor(raw)
}
