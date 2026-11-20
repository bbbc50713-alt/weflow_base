import { basename } from 'path'
import type { Message } from '../chatService'
import type { WechatHistoryMessageV1 } from '../../../shared/wechatHistory'

export function exactServerId(value: unknown): string | null {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return null
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('微信消息 ID 精度已丢失，不能同步')
  const raw = String(value).trim()
  if (!/^-?\d+$/.test(raw)) throw new Error('微信消息 ID 格式不合法')
  let id = BigInt(raw)
  if (id < 0n) id = BigInt.asUintN(64, id)
  if (id > 18446744073709551615n) throw new Error('微信消息 ID 超出范围')
  return id > 0n ? id.toString() : null
}

export function historyKind(message: Message): import('../../../shared/historyKinds').HistoryKind {
  const raw = message.rawContent || message.content || ''
  const xmlType = Number(message.xmlType || raw.match(/<type>\s*(\d+)\s*<\/type>/)?.[1] || Math.floor(message.localType / 4294967296))
  const baseType = message.localType % 4294967296
  const mediaKind = ({ 3: 'image', 34: 'voice', 43: 'video', 47: 'emoji' } as const)[baseType as 3 | 34 | 43 | 47]
    || (baseType === 49 && xmlType === 6 ? 'file' : null)
  return mediaKind || (baseType === 1 ? 'text' : 'other')
}

export function toHistoryMessage(message: Message, row: Record<string, any>, owner: string): WechatHistoryMessageV1 {
  const serverId = exactServerId(row.server_id ?? message.serverIdRaw ?? message.serverId)
  const shard = String(row.db_name || basename(String(row._db_path || row.db_path || message._db_path || '')))
  const table = String(row.table_name || row.tableName || '')
  const localId = String(row.local_id ?? message.localId)
  if (!serverId && (!shard || !table || !localId || localId === '0')) throw new Error('缺少稳定的本地消息定位信息')
  const sourceKey = shard && table ? `${shard}:${table}:${localId}` : `server:${serverId}`
  const sender = String(message.senderUsername || '')
  let isSend = message.isSend
  if (isSend !== 0 && isSend !== 1) isSend = sender ? (sender === owner ? 1 : 0) : null
  if (isSend === null || (isSend === 1 && sender && sender !== owner)) throw new Error('无法确认消息发送方向')
  const raw = message.rawContent || message.content || ''
  const kind = historyKind(message)
  const mediaKind = kind === 'other' || kind === 'text' ? null : kind
  const quotedId = raw.match(/<refermsg>[\s\S]*?<svrid>(\d+)<\/svrid>/i)?.[1]
  return {
    source_key: sourceKey, server_id: serverId, local_id: localId, shard, table,
    occurred_at: new Date(message.createTime * 1000).toISOString(), sort_seq: String(message.sortSeq || 0),
    direction: isSend === 1 ? 'outbound' : 'inbound', sender_wxid: sender || (isSend === 1 ? owner : ''),
    sender_name: '', local_type: message.localType, content: message.parsedContent || raw,
    raw_content: raw, reply_to_server_id: exactServerId(quotedId), media_kind: mediaKind,
  }
}

export function normalizeOrigin(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || !(['https:'].includes(url.protocol) || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('中台地址必须使用 HTTPS（本机测试允许 HTTP）')
  }
  return url.origin
}
