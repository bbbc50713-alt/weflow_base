import type { TriggerRules, WeChatMessage } from '../../../../src/types/ai-reply'

interface RateLimitEntry {
  timestamps: number[]
}

export class TriggerEngine {
  private rules: TriggerRules
  private rateLimitMap: Map<string, RateLimitEntry> = new Map()
  private selfNickname: string = ''

  constructor(rules: TriggerRules) {
    this.rules = rules
  }

  setSelfNickname(name: string): void {
    this.selfNickname = name
  }

  updateRules(rules: TriggerRules): void {
    this.rules = rules
  }

  getRules(): TriggerRules {
    return this.rules
  }

  shouldReply(message: WeChatMessage): { shouldReply: boolean; reason?: string } {
    if (!this.rules.enabled) {
      return { shouldReply: false, reason: '自动回复未启用' }
    }

    const contactCheck = this.checkContact(message)
    if (!contactCheck.passed) {
      return { shouldReply: false, reason: contactCheck.reason }
    }

    const keywordCheck = this.checkKeywords(message)
    if (!keywordCheck.passed) {
      return { shouldReply: false, reason: keywordCheck.reason }
    }

    const atCheck = this.checkAtTrigger(message)
    if (!atCheck.passed) {
      return { shouldReply: false, reason: atCheck.reason }
    }

    const timeCheck = this.checkTimeRules()
    if (!timeCheck.passed) {
      return { shouldReply: false, reason: timeCheck.reason }
    }

    const rateCheck = this.checkRateLimit(message)
    if (!rateCheck.passed) {
      return { shouldReply: false, reason: rateCheck.reason }
    }

    this.recordReply(message)

    return { shouldReply: true }
  }

  private checkContact(message: WeChatMessage): { passed: boolean; reason?: string } {
    switch (this.rules.listenMode) {
      case 'all':
        return { passed: true }
      case 'specific':
        if (this.rules.targetContacts.length === 0) {
          return { passed: false, reason: '未指定监听联系人' }
        }
        if (!this.rules.targetContacts.includes(message.contactId) &&
            !this.rules.targetContacts.includes(message.contactName)) {
          return { passed: false, reason: '不在监听列表中' }
        }
        return { passed: true }
      case 'whitelist':
        if (!this.rules.whitelist.includes(message.contactId) &&
            !this.rules.whitelist.includes(message.contactName)) {
          return { passed: false, reason: '不在白名单中' }
        }
        return { passed: true }
      case 'blacklist':
        if (this.rules.blacklist.includes(message.contactId) ||
            this.rules.blacklist.includes(message.contactName)) {
          return { passed: false, reason: '在黑名单中' }
        }
        return { passed: true }
      default:
        return { passed: false, reason: `未知监听模式: ${this.rules.listenMode}` }
    }
  }

  private checkKeywords(message: WeChatMessage): { passed: boolean; reason?: string } {
    if (this.rules.keywords.include.length > 0) {
      const hasKeyword = this.rules.keywords.include.some(kw =>
        message.content.includes(kw)
      )
      if (!hasKeyword) {
        return { passed: false, reason: '不包含触发关键词' }
      }
    }

    if (this.rules.keywords.exclude.some(kw => message.content.includes(kw))) {
      return { passed: false, reason: '包含排除关键词' }
    }

    if (this.rules.keywords.regex) {
      try {
        const regex = new RegExp(this.rules.keywords.regex)
        if (!regex.test(message.content)) {
          return { passed: false, reason: '不匹配正则规则' }
        }
      } catch {
        // invalid regex, skip
      }
    }

    return { passed: true }
  }

  private checkAtTrigger(message: WeChatMessage): { passed: boolean; reason?: string } {
    if (!message.isGroup) {
      return { passed: true }
    }

    // 修复：不再因配置了关键词就绕过 @ 检查。
    // 关键词是内容过滤层，@ 是群聊触发条件层，两者应独立生效（AND 关系）。
    // 若用户希望群聊无需 @ 即可回复，应关闭 triggerOnAt，而非靠关键词短路。

    if (this.rules.triggerOnAt) {
      const content = message.content
      const atPatterns = ['@all', '@所有人', '@全体成员']
      const isAtAll = atPatterns.some(pattern => content.includes(pattern))

      let isAtMe = false
      if (this.selfNickname) {
        isAtMe = content.includes(`@${this.selfNickname}`)
      }
      if (!isAtMe) {
        isAtMe = content.includes('@我')
      }

      const atEveryone = this.rules.triggerOnAtAll && isAtAll

      if (!isAtMe && !atEveryone) {
        return { passed: false, reason: '群聊中未@，不触发回复' }
      }

      return { passed: true }
    }

    return { passed: true }
  }

  private checkTimeRules(): { passed: boolean; reason?: string } {
    if (!this.rules.timeRules.enabled) return { passed: true }

    const now = new Date()
    // 修复：使用配置中的 timezone 字段计算小时数，而非直接取本机时区。
    const hour = this.getHourInTimezone(now, this.rules.timeRules.timezone)
    const [start, end] = this.rules.timeRules.allowedHours

    if (start <= end) {
      if (hour < start || hour >= end) {
        return { passed: false, reason: `当前时间不在允许范围内 (${start}:00-${end}:00)` }
      }
    } else {
      if (hour < start && hour >= end) {
        return { passed: false, reason: `当前时间不在允许范围内` }
      }
    }

    return { passed: true }
  }

  /**
   * 按指定时区获取当前小时数（24 小时制）。
   * timezone 为空或非法时回退到本机时区。
   */
  private getHourInTimezone(date: Date, timezone: string): number {
    if (!timezone) return date.getHours()
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false
      })
      const hourStr = formatter.format(date)
      // Intl 在 hour12:false 下可能返回 "24"，规范化为 0
      const hour = parseInt(hourStr, 10)
      if (isNaN(hour)) return date.getHours()
      return hour === 24 ? 0 : hour
    } catch {
      return date.getHours()
    }
  }

  private checkRateLimit(message: WeChatMessage): { passed: boolean; reason?: string } {
    if (!this.rules.rateLimit.enabled) return { passed: true }

    const now = Date.now()
    const key = message.contactId
    let entry = this.rateLimitMap.get(key)

    if (!entry) {
      entry = { timestamps: [] }
      this.rateLimitMap.set(key, entry)
    }

    const windowMs = 60 * 1000
    entry.timestamps = entry.timestamps.filter(t => now - t < windowMs)

    if (entry.timestamps.length === 0) {
      this.rateLimitMap.delete(key)
    }

    if (this.rateLimitMap.size > 1000) {
      this.cleanupRateLimitMap(now)
    }

    const currentEntry = this.rateLimitMap.get(key)
    if (!currentEntry) return { passed: true }

    if (currentEntry.timestamps.length >= this.rules.rateLimit.maxRepliesPerMinute) {
      return { passed: false, reason: '超过频率限制' }
    }

    if (currentEntry.timestamps.length > 0) {
      const lastReply = currentEntry.timestamps[currentEntry.timestamps.length - 1]
      const elapsed = (now - lastReply) / 1000
      if (elapsed < this.rules.rateLimit.cooldownSeconds) {
        return { passed: false, reason: '冷却中' }
      }
    }

    return { passed: true }
  }

  private cleanupRateLimitMap(now: number): void {
    const windowMs = 60 * 1000
    for (const [key, entry] of this.rateLimitMap) {
      entry.timestamps = entry.timestamps.filter(t => now - t < windowMs)
      if (entry.timestamps.length === 0) {
        this.rateLimitMap.delete(key)
      }
    }
  }

  private recordReply(message: WeChatMessage): void {
    let entry = this.rateLimitMap.get(message.contactId)
    if (!entry) {
      entry = { timestamps: [] }
      this.rateLimitMap.set(message.contactId, entry)
    }
    entry.timestamps.push(Date.now())
  }
}
