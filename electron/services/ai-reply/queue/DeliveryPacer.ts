export interface DeliveryPolicy {
  minDelayMs: number
  maxDelayMs: number
  postSendGapMsMin: number
  postSendGapMsMax: number
  perContactCooldownMs: number
  maxRetry: number
  retryDelayMs: number
  staleAfterMs: number
  typingMsPerCharMin: number
  typingMsPerCharMax: number
  maxTypingDelayMs: number
  splitMinGapMs: number
  splitMaxGapMs: number
}

export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = {
  minDelayMs: 8000,
  maxDelayMs: 45000,
  postSendGapMsMin: 8000,
  postSendGapMsMax: 25000,
  perContactCooldownMs: 60000,
  maxRetry: 2,
  retryDelayMs: 30000,
  staleAfterMs: 180000,
  typingMsPerCharMin: 80,
  typingMsPerCharMax: 180,
  maxTypingDelayMs: 18000,
  splitMinGapMs: 2500,
  splitMaxGapMs: 8000
}

const MAX_DELAY_MS = 24 * 60 * 60 * 1000

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const next = Math.floor(Number(value))
  if (!Number.isFinite(next)) return fallback
  return Math.max(min, Math.min(max, next))
}

function normalizeDelayMs(value: unknown, fallback: number, min = 0, max = MAX_DELAY_MS): number {
  return normalizeInteger(value, fallback, min, max)
}

export function mergeDeliveryPolicy(policy?: Partial<DeliveryPolicy>): DeliveryPolicy {
  const merged = {
    ...DEFAULT_DELIVERY_POLICY,
    ...(policy || {})
  }
  const minDelayMs = normalizeDelayMs(merged.minDelayMs, DEFAULT_DELIVERY_POLICY.minDelayMs)
  const maxDelayMs = Math.max(
    minDelayMs,
    normalizeDelayMs(merged.maxDelayMs, DEFAULT_DELIVERY_POLICY.maxDelayMs)
  )
  const postSendGapMsMin = normalizeDelayMs(
    merged.postSendGapMsMin,
    DEFAULT_DELIVERY_POLICY.postSendGapMsMin
  )
  const postSendGapMsMax = Math.max(
    postSendGapMsMin,
    normalizeDelayMs(merged.postSendGapMsMax, DEFAULT_DELIVERY_POLICY.postSendGapMsMax)
  )
  const typingMsPerCharMin = normalizeDelayMs(
    merged.typingMsPerCharMin,
    DEFAULT_DELIVERY_POLICY.typingMsPerCharMin
  )
  const typingMsPerCharMax = Math.max(
    typingMsPerCharMin,
    normalizeDelayMs(merged.typingMsPerCharMax, DEFAULT_DELIVERY_POLICY.typingMsPerCharMax)
  )

  return {
    minDelayMs,
    maxDelayMs,
    postSendGapMsMin,
    postSendGapMsMax,
    perContactCooldownMs: normalizeDelayMs(
      merged.perContactCooldownMs,
      DEFAULT_DELIVERY_POLICY.perContactCooldownMs
    ),
    maxRetry: normalizeInteger(merged.maxRetry, DEFAULT_DELIVERY_POLICY.maxRetry, 0, 20),
    retryDelayMs: normalizeDelayMs(merged.retryDelayMs, DEFAULT_DELIVERY_POLICY.retryDelayMs),
    staleAfterMs: normalizeDelayMs(merged.staleAfterMs, DEFAULT_DELIVERY_POLICY.staleAfterMs, 1000),
    typingMsPerCharMin,
    typingMsPerCharMax,
    maxTypingDelayMs: normalizeDelayMs(merged.maxTypingDelayMs, DEFAULT_DELIVERY_POLICY.maxTypingDelayMs),
    splitMinGapMs: normalizeDelayMs(merged.splitMinGapMs, DEFAULT_DELIVERY_POLICY.splitMinGapMs),
    splitMaxGapMs: Math.max(
      normalizeDelayMs(merged.splitMinGapMs, DEFAULT_DELIVERY_POLICY.splitMinGapMs),
      normalizeDelayMs(merged.splitMaxGapMs, DEFAULT_DELIVERY_POLICY.splitMaxGapMs)
    )
  }
}

export function randomBetween(min: number, max: number): number {
  if (max <= min) return Math.max(0, min)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export function computeInitialDelayMs(text: string, policy: DeliveryPolicy): number {
  const base = randomBetween(policy.minDelayMs, policy.maxDelayMs)
  const typingPerChar = randomBetween(policy.typingMsPerCharMin, policy.typingMsPerCharMax)
  const typingDelay = Math.min(policy.maxTypingDelayMs, Math.max(0, text.length * typingPerChar))
  return base + typingDelay
}

export function computePostSendGapMs(policy: DeliveryPolicy): number {
  return randomBetween(policy.postSendGapMsMin, policy.postSendGapMsMax)
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => setTimeout(resolve, ms))
}
