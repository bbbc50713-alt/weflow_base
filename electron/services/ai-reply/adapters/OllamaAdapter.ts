import { BaseAdapter } from './BaseAdapter'
import type { ChatMessage, GenerateOptions, GenerateResult, TestResult, OllamaConfig } from '../../../../src/types/ai-reply'

export class OllamaAdapter extends BaseAdapter {
  private getConfig(): OllamaConfig {
    return this.getOllamaConfig()
  }

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult> {
    const cfg = this.getConfig()
    const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/chat`

    const body = {
      model: cfg.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      options: {
        temperature: options?.temperature ?? cfg.temperature,
        num_predict: options?.maxTokens ?? cfg.maxTokens
      }
    }

    const startTime = Date.now()
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Ollama API error (${response.status}): ${text || response.statusText}`)
    }

    const data = await response.json()
    const content = data.message?.content || ''

    return {
      content,
      model: cfg.model,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
      }
    }
  }

  async testConnection(): Promise<TestResult> {
    const cfg = this.getConfig()
    const startTime = Date.now()

    try {
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/tags`
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) })

      if (!response.ok) {
        return {
          success: false,
          message: `连接失败: HTTP ${response.status}`,
          latencyMs: Date.now() - startTime
        }
      }

      const data = await response.json()
      const modelExists = (data.models || []).some(
        (m: { name: string }) => m.name === cfg.model || m.name === `${cfg.model}:latest`
      )

      if (!modelExists) {
        return {
          success: false,
          message: `模型 "${cfg.model}" 未找到，可用模型: ${(data.models || []).map((m: { name: string }) => m.name).join(', ') || '无'}`,
          latencyMs: Date.now() - startTime
        }
      }

      return {
        success: true,
        message: `连接成功，模型 "${cfg.model}" 可用`,
        latencyMs: Date.now() - startTime
      }
    } catch (error) {
      return {
        success: false,
        message: `连接失败: ${error instanceof Error ? error.message : String(error)}`,
        latencyMs: Date.now() - startTime
      }
    }
  }

  validateConfig(): boolean {
    const cfg = this.getConfig()
    return !!cfg.baseUrl && !!cfg.model
  }

  async fetchAvailableModels(): Promise<{ id: string; name: string; isLocal: boolean }[]> {
    const cfg = this.getConfig()
    try {
      const baseUrl = cfg.baseUrl.replace(/\/$/, '')
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const data = await res.json()
      return (data.models || []).map((m: any) => ({
        id: m.name as string,
        name: m.name as string,
        isLocal: true
      }))
    } catch (e) {
      console.warn('[OllamaAdapter] fetchAvailableModels failed:', e instanceof Error ? e.message : e)
      throw e
    }
  }
}
