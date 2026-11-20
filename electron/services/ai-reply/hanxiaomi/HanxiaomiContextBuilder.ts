import * as crypto from 'crypto'
import { markdownToPlainText } from '../utils/markdownToPlainText'
import type {
  HanxiaomiContactInfo,
  HanxiaomiContextBuildInput,
  HanxiaomiContextMessage,
  HanxiaomiImagePayload,
  HanxiaomiReplyRequest,
  HanxiaomiVoiceAudioPayload,
  HanxiaomiVoiceTranscriptTarget
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
  const pickedCurrent = await pickCurrentMessage(input.contactId, latestResult.messages, input.currentContent, input.identitySalt, bufferedLatest, input.provider)
  const currentMessage = pickedCurrent.message
  const currentKey = currentMessage.message_key
  const bufferedKeys = new Set(input.bufferedMessages.flatMap(bufferedMessageIdentityTokens))
  const currentTs = Date.parse(currentMessage.timestamp)
  const normalizedAll = await normalizeMessages(
    latestResult.messages,
    input.contactId,
    input.identitySalt,
    input.provider,
    new Set([...bufferedKeys, currentKey].filter(Boolean)),
    Number.isFinite(currentTs) ? currentTs : undefined
  )
  const history = normalizedAll
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

async function pickCurrentMessage(
  contactId: string,
  messages: Message[],
  currentContent: string,
  salt: string,
  latestBuffered: BufferedMessageForContext,
  provider: HanxiaomiContextBuildInput['provider']
): Promise<PickedCurrentMessage> {
  const sorted = [...messages].sort(compareMessageTimeline)
  const tokens = new Set(bufferedMessageIdentityTokens(latestBuffered))
  const matched = sorted.find(message => messageMatchesBuffered(message, tokens))
  if (matched) {
    const messageKey = String(matched.messageKey || '').trim()
      || String(matched.localId || matched.serverId || `${contactId}:${matched.createTime}:${matched.sortSeq}`)
    const sender = String(matched.senderUsername || '').trim()
    const currentLocalType = Number(matched.localType || latestBuffered.type || 1)
    const voiceTarget = voiceTargetFromMessage(matched, latestBuffered)
    const voicePayload = currentLocalType === 34
      ? await voiceAudioPayloadForMessage(contactId, voiceTarget, provider)
      : undefined
    const imagePayload = currentLocalType === 3
      ? await imagePayloadForMessage(contactId, voiceTarget, provider)
      : undefined
    const message: HanxiaomiContextMessage = {
      message_key: messageKey,
      role: 'customer',
      timestamp: toIsoTimestamp(Number(matched.createTime || 0) * 1000),
      content: (voicePayload || imagePayload)
        ? safeContent(currentContent, currentLocalType)
        : await safeContentForMessage(currentContent, currentLocalType, contactId, voiceTarget, provider),
      content_type: contentType(currentLocalType),
      sender_ref: sender ? hashRef(salt || 'weflow-sender', sender) : undefined
    }
    if (voicePayload) message.voice = voicePayload
    if (imagePayload) message.image = imagePayload
    return {
      source: 'buffered_match',
      message
    }
  }

  const timestamp = latestBuffered.timestamp || Date.now()
  const fallbackKey = latestBuffered.msgId || latestBuffered.messageKey || `buffer:${contactId}:${timestamp}`
  const currentLocalType = latestBuffered.type || 1
  const voiceTarget = voiceTargetFromBuffered(latestBuffered)
  const voicePayload = currentLocalType === 34
    ? await voiceAudioPayloadForMessage(contactId, voiceTarget, provider)
    : undefined
  const imagePayload = currentLocalType === 3
    ? await imagePayloadForMessage(contactId, voiceTarget, provider)
    : undefined
  const message: HanxiaomiContextMessage = {
    message_key: fallbackKey,
    role: 'customer',
    timestamp: toIsoTimestamp(timestamp),
    content: (voicePayload || imagePayload)
      ? safeContent(currentContent, currentLocalType)
      : await safeContentForMessage(currentContent, currentLocalType, contactId, voiceTarget, provider),
    content_type: contentType(currentLocalType),
    sender_ref: latestBuffered.senderId ? hashRef(salt, latestBuffered.senderId) : undefined
  }
  if (voicePayload) message.voice = voicePayload
  if (imagePayload) message.image = imagePayload
  return {
    source: 'buffered_fallback',
    message
  }
}

async function normalizeMessages(
  messages: Message[],
  contactId: string,
  salt: string,
  provider: HanxiaomiContextBuildInput['provider'],
  excludedTokens: Set<string> = new Set(),
  beforeTimestampMs?: number
): Promise<HanxiaomiContextMessage[]> {
  const seen = new Set<string>()
  const output: HanxiaomiContextMessage[] = []
  for (const message of [...messages].sort(compareMessageTimeline)) {
    if (excludedTokens.size && messageIdentityTokens(message).some(token => excludedTokens.has(token))) continue
    const messageTs = normalizeTimestampMs(Number(message.createTime || 0) * 1000, 0)
    if (beforeTimestampMs && messageTs && messageTs >= beforeTimestampMs) continue
    const normalized = await normalizeMessage(message, contactId, salt, provider)
    if (!normalized.message_key || seen.has(normalized.message_key)) continue
    seen.add(normalized.message_key)
    output.push(normalized)
  }
  return output
}

async function normalizeMessage(
  message: Message,
  contactId: string,
  salt: string,
  provider: HanxiaomiContextBuildInput['provider']
): Promise<HanxiaomiContextMessage> {
  const messageKey = String(message.messageKey || '').trim()
    || String(message.localId || message.serverId || `${contactId}:${message.createTime}:${message.sortSeq}`)
  const sender = String(message.senderUsername || '').trim()
  const localType = Number(message.localType || 1)
  return {
    message_key: messageKey,
    role: Number(message.isSend || 0) === 1 ? 'operator' : 'customer',
    timestamp: toIsoTimestamp(Number(message.createTime || 0) * 1000),
    content: await safeContentForMessage(
      message.parsedContent || message.content || message.rawContent || '',
      localType,
      contactId,
      voiceTargetFromMessage(message),
      provider
    ),
    content_type: contentType(localType),
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

async function safeContentForMessage(
  raw: string,
  localType: number,
  contactId: string,
  voiceTarget: HanxiaomiVoiceTranscriptTarget,
  provider: HanxiaomiContextBuildInput['provider']
): Promise<string> {
  if (localType === 34 && provider.getVoiceTranscript) {
    try {
      const result = await provider.getVoiceTranscript(contactId, voiceTarget)
      const transcript = markdownToPlainText(String(result.transcript || '')).trim()
      if (result.success && transcript) {
        return `[语音转文字] ${transcript}`.slice(0, 4000)
      }
      if (result.error) {
        console.warn(`[HanxiaomiContextBuilder] voice transcript failed: ${result.error}`)
      }
    } catch (error) {
      console.warn(`[HanxiaomiContextBuilder] voice transcript exception: ${String(error)}`)
    }
  }
  return safeContent(raw, localType)
}

async function voiceAudioPayloadForMessage(
  contactId: string,
  voiceTarget: HanxiaomiVoiceTranscriptTarget,
  provider: HanxiaomiContextBuildInput['provider']
): Promise<HanxiaomiVoiceAudioPayload | undefined> {
  if (!provider.getVoiceAudio) return undefined
  try {
    const result = await provider.getVoiceAudio(contactId, voiceTarget)
    const audioBase64 = String(result.audioBase64 || '').trim()
    if (result.success && audioBase64) {
      const payload: HanxiaomiVoiceAudioPayload = {
        audio_base64: audioBase64,
        audio_format: normalizeVoiceAudioFormat(result.format),
        sample_rate: normalizeVoiceSampleRate(result.sampleRate)
      }
      const durationSeconds = normalizeOptionalPositiveNumber(result.durationSeconds)
      if (durationSeconds !== undefined) payload.duration_seconds = durationSeconds
      return payload
    }
    if (result.error) {
      console.warn(`[HanxiaomiContextBuilder] voice audio fetch failed: ${result.error}`)
    }
  } catch (error) {
    console.warn(`[HanxiaomiContextBuilder] voice audio fetch exception: ${String(error)}`)
  }
  return undefined
}

function normalizeVoiceAudioFormat(value: unknown): 'wav' | 'pcm' {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'pcm' ? 'pcm' : 'wav'
}

function normalizeVoiceSampleRate(value: unknown): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 24000
  return Math.max(8000, Math.min(48000, Math.floor(raw)))
}

function normalizeOptionalPositiveNumber(value: unknown): number | undefined {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return undefined
  return raw
}

async function imagePayloadForMessage(
  contactId: string,
  target: HanxiaomiVoiceTranscriptTarget,
  provider: HanxiaomiContextBuildInput['provider']
): Promise<HanxiaomiImagePayload | undefined> {
  if (!provider.getImageData) return undefined
  try {
    const result = await provider.getImageData(contactId, target)
    const imageBase64 = String(result.imageBase64 || '').trim()
    const imageUrl = String(result.imageUrl || '').trim()
    if (result.success && (imageBase64 || imageUrl)) {
      const payload: HanxiaomiImagePayload = {
        mime_type: normalizeImageMimeType(result.mimeType)
      }
      if (imageBase64) payload.image_base64 = imageBase64
      if (imageUrl) payload.image_url = imageUrl
      return payload
    }
    if (result.error) {
      console.warn(`[HanxiaomiContextBuilder] image data fetch failed: ${result.error}`)
    }
  } catch (error) {
    console.warn(`[HanxiaomiContextBuilder] image data fetch exception: ${String(error)}`)
  }
  return undefined
}

function normalizeImageMimeType(value: unknown): 'image/jpeg' | 'image/png' | 'image/webp' {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'image/png' || normalized === 'png') return 'image/png'
  if (normalized === 'image/webp' || normalized === 'webp') return 'image/webp'
  return 'image/jpeg'
}

function voiceTargetFromMessage(
  message: Partial<Message>,
  fallback?: Partial<BufferedMessageForContext>
): HanxiaomiVoiceTranscriptTarget {
  const anyMessage = message as any
  return {
    msgId: String(anyMessage.localId ?? fallback?.localId ?? fallback?.msgId ?? anyMessage.messageKey ?? '').trim(),
    messageKey: String(anyMessage.messageKey ?? fallback?.messageKey ?? '').trim(),
    localId: anyMessage.localId ?? fallback?.localId,
    serverId: anyMessage.serverId ?? fallback?.serverId,
    serverIdRaw: anyMessage.serverIdRaw ?? fallback?.serverIdRaw,
    createTime: toCreateTimeSeconds(anyMessage.createTime ?? fallback?.timestamp),
    timestamp: normalizeTimestampMs(anyMessage.timestamp ?? fallback?.timestamp ?? (anyMessage.createTime ? Number(anyMessage.createTime) * 1000 : 0), 0),
    senderId: String(anyMessage.senderId ?? fallback?.senderId ?? '').trim(),
    senderUsername: typeof anyMessage.senderUsername === 'string' ? anyMessage.senderUsername : undefined
  }
}

function voiceTargetFromBuffered(message: BufferedMessageForContext): HanxiaomiVoiceTranscriptTarget {
  return {
    msgId: String(message.localId ?? message.msgId ?? message.messageKey ?? '').trim(),
    messageKey: String(message.messageKey ?? '').trim(),
    localId: message.localId,
    serverId: message.serverId,
    serverIdRaw: message.serverIdRaw,
    createTime: toCreateTimeSeconds(message.timestamp),
    timestamp: normalizeTimestampMs(message.timestamp, 0),
    senderId: String(message.senderId ?? '').trim()
  }
}

function toCreateTimeSeconds(value: unknown): number | undefined {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return undefined
  if (raw > 100000000000) return Math.floor(raw / 1000)
  return Math.floor(raw)
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
