import { markdownToPlainText } from '../utils/markdownToPlainText'
import type { HanxiaomiOutboundSendJob } from '../queue/HanxiaomiQueueStore'

const RECENT_SELF_SENT_WINDOW_MS = 10 * 60 * 1000

export function extractHanxiaomiMessageText(message: any): string {
  return normalizeHanxiaomiSentText(
    message?.parsedContent ?? message?.content ?? message?.rawContent ?? message?.text ?? ''
  )
}

export function normalizeHanxiaomiSentText(text: unknown): string {
  return markdownToPlainText(String(text || ''))
    .replace(/[~锝瀅+]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isRecentHanxiaomiAutoReplyText(
  contactId: string,
  latestText: string,
  recentSentEntries: Iterable<[string, number]>,
  now = Date.now()
): boolean {
  const normalizedLatest = normalizeHanxiaomiSentText(latestText)
  if (!normalizedLatest) return false

  const prefix = `${contactId}:`
  for (const [key, sentAt] of recentSentEntries) {
    if (now - sentAt > RECENT_SELF_SENT_WINDOW_MS) continue
    if (!key.startsWith(prefix)) continue
    const sentText = key.slice(prefix.length)
    if (normalizeHanxiaomiSentText(sentText) === normalizedLatest) {
      return true
    }
  }
  return false
}

export function isOwnPreviousHanxiaomiSplitPart(
  job: Pick<HanxiaomiOutboundSendJob, 'contactId' | 'parentEventKey' | 'partIndex' | 'partTotal'>,
  latestText: string,
  recentSentEntries: Iterable<[string, number]>,
  now = Date.now()
): boolean {
  if (!job.parentEventKey || !job.partIndex || !job.partTotal || job.partIndex <= 1) return false
  return isRecentHanxiaomiAutoReplyText(job.contactId, latestText, recentSentEntries, now)
}

export function shouldIgnoreOperatorOutboundForHanxiaomiSplitContinuation(
  job: Pick<HanxiaomiOutboundSendJob, 'parentEventKey' | 'partIndex' | 'partTotal'>
): boolean {
  return Boolean(job.parentEventKey && job.partIndex && job.partTotal && job.partIndex > 1)
}
