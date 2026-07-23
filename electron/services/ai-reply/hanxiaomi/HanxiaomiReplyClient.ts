import * as crypto from 'crypto'
import * as http from 'http'
import * as https from 'https'
import type { HanxiaomiChannelConfig, HanxiaomiReplyRequest, HanxiaomiReplyResponse } from './types'

const DEFAULT_REPLY_TIMEOUT_MS = 120000
const DEFAULT_REPLAY_WINDOW_MS = 120000
const MAX_REPLAY_ATTEMPTS = 5

export class HanxiaomiReplyClient {
  private config: HanxiaomiChannelConfig

  constructor(config: HanxiaomiChannelConfig) {
    this.config = config
  }

  updateConfig(config: HanxiaomiChannelConfig): void {
    this.config = config
  }

  isEnabled(): boolean {
    return Boolean(this.config.enabled && this.config.serviceUrl && this.config.keyId && this.config.signingSecret)
  }

  async testConnection(): Promise<{ success: boolean; message: string; latencyMs?: number }> {
    if (!this.isEnabled()) return { success: false, message: '汉小密渠道未配置完整' }
    const start = Date.now()
    try {
      const url = new URL('/api/v1/health/', this.config.serviceUrl)
      const response = await this.requestRaw('GET', url, undefined, false)
      return {
        success: response.statusCode >= 200 && response.statusCode < 300,
        message: response.statusCode >= 200 && response.statusCode < 300 ? '连接正常' : `HTTP ${response.statusCode}`,
        latencyMs: Date.now() - start
      }
    } catch (error: any) {
      return { success: false, message: error?.message || String(error), latencyMs: Date.now() - start }
    }
  }

  async createReply(payload: HanxiaomiReplyRequest): Promise<HanxiaomiReplyResponse> {
    if (!this.isEnabled()) {
      throw new Error('汉小密渠道未配置完整')
    }
    const url = new URL('/api/v1/channels/weflow/replies', this.config.serviceUrl)
    const body = JSON.stringify(payload)
    const startedAt = Date.now()
    let attempt = 0
    let lastError: unknown

    while (attempt < MAX_REPLAY_ATTEMPTS && Date.now() - startedAt < DEFAULT_REPLAY_WINDOW_MS) {
      attempt++
      try {
        const response = await this.requestRaw('POST', url, body, true)
        if (response.statusCode === 409 && attempt < MAX_REPLAY_ATTEMPTS) {
          await this.sleep(this.retryDelayMs(response.headers, attempt))
          continue
        }
        if (response.statusCode === 409) {
          const retryAfter = response.headers['retry-after']
          throw new Error(`汉小密正在处理同一会话，请稍后重试${retryAfter ? ` (${retryAfter}s)` : ''}`)
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new Error(`汉小密回复接口失败: HTTP ${response.statusCode} ${response.body.slice(0, 200)}`)
        }
        return this.parseReplyResponse(response.body)
      } catch (error: any) {
        lastError = error
        if (!this.isRetryableError(error) || attempt >= MAX_REPLAY_ATTEMPTS || Date.now() - startedAt >= DEFAULT_REPLAY_WINDOW_MS) {
          throw error
        }
        await this.sleep(this.retryDelayMs(undefined, attempt))
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError || '汉小密请求失败'))
  }

  private parseReplyResponse(body: string): HanxiaomiReplyResponse {
    const parsed = JSON.parse(body) as HanxiaomiReplyResponse
    if (!parsed || !parsed.request_id || !parsed.reply_to_message_key || !parsed.action) {
      throw new Error('汉小密回复接口返回格式不合法')
    }
    const segments = this.normalizeReplySegments((parsed as any).segments)
    return {
      request_id: String(parsed.request_id),
      reply_to_message_key: String(parsed.reply_to_message_key),
      action: parsed.action,
      text: String(parsed.text || ''),
      segments: segments.length > 0 ? segments : undefined
    }
  }

  private normalizeReplySegments(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const segments = value.map(item => String(item || '').trim()).filter(Boolean)
    if (segments.length === 0 || segments.length > 5) return []
    return segments
  }

  private isRetryableError(error: any): boolean {
    const message = String(error?.message || error || '').toLowerCase()
    const code = String(error?.code || '').toLowerCase()
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('超时') ||
      code === 'etimedout' ||
      code === 'econnreset'
    )
  }

  private retryDelayMs(headers: http.IncomingHttpHeaders | undefined, attempt: number): number {
    const retryAfter = headers?.['retry-after']
    const raw = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(10000, seconds * 1000)
    }
    return Math.min(10000, 2000 + attempt * 1000)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
  }

  private async requestRaw(
    method: 'GET' | 'POST',
    url: URL,
    body: string | undefined,
    sign: boolean
  ): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http
    const headers: Record<string, string> = {
      Accept: 'application/json'
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(body).toString()
    }

    if (sign) {
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const nonce = crypto.randomBytes(16).toString('hex')
      const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex')
      const canonical = [method, url.pathname, timestamp, nonce, bodyHash].join('\n')
      const signature = crypto.createHmac('sha256', this.config.signingSecret).update(canonical).digest('hex')
      headers['X-WeFlow-Key-Id'] = this.config.keyId
      headers['X-WeFlow-Timestamp'] = timestamp
      headers['X-WeFlow-Nonce'] = nonce
      headers['X-WeFlow-Body-SHA256'] = bodyHash
      headers['X-WeFlow-Signature'] = `sha256=${signature}`
    }

    const timeoutMs = Math.max(1000, Number(this.config.timeoutMs) || DEFAULT_REPLY_TIMEOUT_MS)
    return await new Promise((resolve, reject) => {
      const req = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        timeout: timeoutMs
      }, (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { data += chunk })
        res.on('end', () => resolve({
          statusCode: res.statusCode || 0,
          body: data,
          headers: res.headers
        }))
      })
      req.on('timeout', () => {
        req.destroy(new Error(`汉小密请求超时 (${timeoutMs}ms)`))
      })
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }
}
