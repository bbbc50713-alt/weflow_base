import type { ChatMessage, WeChatMessage } from '../../../../src/types/ai-reply'

interface ContextEntry {
  messages: ChatMessage[]
  updatedAt: number
  summary?: string
}

export class ContextManager {
  private contexts: Map<string, ContextEntry> = new Map()
  private maxMessagesPerContext: number
  private maxContexts: number
  // P1-3 修复：summary 字符串长度上限，防止长期对话后无限膨胀撑大 system prompt
  private maxSummaryLength: number = 2000

  constructor(maxMessagesPerContext = 50, maxContexts = 100) {
    this.maxMessagesPerContext = maxMessagesPerContext
    this.maxContexts = maxContexts
  }

  getHistory(contactId: string): ChatMessage[] {
    const entry = this.contexts.get(contactId)
    return entry?.messages || []
  }

  addMessage(contactId: string, message: ChatMessage): void {
    let entry = this.contexts.get(contactId)
    if (!entry) {
      entry = { messages: [], updatedAt: Date.now() }
      this.contexts.set(contactId, entry)
    }

    entry.messages.push(message)
    entry.updatedAt = Date.now()

    if (entry.messages.length > this.maxMessagesPerContext) {
      this.compressContext(contactId)
    }

    this.evictOldContexts()
  }

  addWeChatMessage(contactId: string, message: WeChatMessage, role: 'user' | 'assistant'): void {
    this.addMessage(contactId, {
      role,
      content: message.content,
      timestamp: message.timestamp
    })
  }

  clearHistory(contactId: string): void {
    this.contexts.delete(contactId)
  }

  clearAllHistory(): void {
    this.contexts.clear()
  }

  compressContext(contactId: string): void {
    const entry = this.contexts.get(contactId)
    if (!entry) return

    const keepCount = Math.floor(this.maxMessagesPerContext * 0.6)
    const removed = entry.messages.slice(0, entry.messages.length - keepCount)

    if (removed.length > 0) {
      const summary = this.generateSummary(removed)
      // P1-3 修复：限制 summary 总长度，防止长期高频对话后无限膨胀
      // 新摘要 + 旧摘要拼接后，若超限则截断保留最新的部分
      const newSummary = entry.summary
        ? `${entry.summary}\n${summary}`
        : summary
      if (newSummary.length > this.maxSummaryLength) {
        entry.summary = newSummary.slice(-this.maxSummaryLength)
      } else {
        entry.summary = newSummary
      }
    }

    entry.messages = entry.messages.slice(-keepCount)
  }

  getRecentMessages(contactId: string, count: number): ChatMessage[] {
    const entry = this.contexts.get(contactId)
    if (!entry) return []
    return entry.messages.slice(-count)
  }

  getContextWithSummary(contactId: string): {
    messages: ChatMessage[]
    summary?: string
  } {
    const entry = this.contexts.get(contactId)
    return {
      messages: entry?.messages || [],
      summary: entry?.summary
    }
  }

  getAllContactIds(): string[] {
    return Array.from(this.contexts.keys())
  }

  private generateSummary(messages: ChatMessage[]): string {
    const userMessages = messages.filter(m => m.role === 'user').length
    const assistantMessages = messages.filter(m => m.role === 'assistant').length
    const timeRange = messages.length > 0
      ? `从 ${new Date(messages[0].timestamp || 0).toLocaleString()} 到 ${new Date(messages[messages.length - 1].timestamp || 0).toLocaleString()}`
      : ''

    return `[历史摘要] 共 ${userMessages} 条用户消息, ${assistantMessages} 条回复${timeRange ? `，${timeRange}` : ''}`
  }

  private evictOldContexts(): void {
    if (this.contexts.size <= this.maxContexts) return

    const entries = Array.from(this.contexts.entries())
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)

    const toRemove = entries.slice(0, this.contexts.size - this.maxContexts)
    for (const [contactId] of toRemove) {
      this.contexts.delete(contactId)
    }
  }
}
