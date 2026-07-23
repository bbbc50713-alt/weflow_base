import type { WeChatMessage } from '../../../../src/types/ai-reply'

interface DedupEntry {
  // 实际存储原始 content（命名沿用历史，避免破坏已持久化数据兼容性）
  contentHash: string
  processedAt: number
  contactId?: string
}

export class MessageDeduper {
  private processed: Map<string, DedupEntry> = new Map()
  private maxEntries: number
  private ttlMs: number

  constructor(maxEntries = 10000, ttlMs = 5 * 60 * 1000) {
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
  }

  isDuplicate(msgId: string): boolean {
    const entry = this.processed.get(msgId)
    if (!entry) return false
    if (Date.now() - entry.processedAt > this.ttlMs) {
      this.processed.delete(msgId)
      return false
    }
    return true
  }

  markProcessed(msgId: string, contentHash?: string, contactId?: string): void {
    this.processed.set(msgId, {
      contentHash: this.normalizeContent(contentHash || ''),
      processedAt: Date.now(),
      contactId
    })

    this.evict()
  }

  /**
   * 内容级相似度去重：仅对同一联系人的近期消息做相似度比对，
   * 避免不同联系人发相同内容被误判。
  */
  isSimilar(content: string, contactId: string, threshold = 0.9): boolean {
    if (!content || !contactId) return false
    const normalizedContent = this.normalizeContent(content)
    // 太短的消息通常是“好/是/哈哈/明天/就这个”一类真人补充，不做相似度误杀。
    if (normalizedContent.length < 8) return false
    const now = Date.now()
    for (const [, entry] of this.processed) {
      if (now - entry.processedAt > this.ttlMs) continue
      if (entry.contactId !== contactId) continue
      if (!entry.contentHash || entry.contentHash.length < 8) continue
      if (this.similarity(normalizedContent, entry.contentHash) > threshold) {
        return true
      }
    }
    return false
  }

  clear(): void {
    this.processed.clear()
  }

  private evict(): void {
    if (this.processed.size <= this.maxEntries) return

    const now = Date.now()
    const entries = Array.from(this.processed.entries())
      .filter(([, entry]) => now - entry.processedAt < this.ttlMs)
      .sort((a, b) => a[1].processedAt - b[1].processedAt)

    this.processed.clear()
    const keep = entries.slice(-this.maxEntries)
    for (const [key, value] of keep) {
      this.processed.set(key, value)
    }
  }

  private similarity(a: string, b: string): number {
    if (a === b) return 1
    if (!a || !b) return 0

    const longer = a.length > b.length ? a : b
    const shorter = a.length > b.length ? b : a

    if (longer.length === 0) return 1

    const editDistance = this.levenshtein(longer, shorter)
    return (longer.length - editDistance) / longer.length
  }

  private normalizeContent(value: string): string {
    return String(value || '')
      .replace(/[\s\u200B-\u200D\uFEFF]+/g, '')
      .replace(/[~`!！@#￥$%^&*()_+\-=[\]{};:'"“”、,，。\.、<>/?\\|]/g, '')
      .toLowerCase()
      .trim()
  }

  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = []

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i]
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1]
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          )
        }
      }
    }

    return matrix[b.length][a.length]
  }
}
