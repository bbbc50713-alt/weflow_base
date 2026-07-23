import type { ChatRecord } from '../../../../src/types/ai-reply'

export interface PreprocessedRecords {
  otherMessages: ChatRecord[]
  selfMessages: ChatRecord[]
  segments: ChatRecord[][]
  totalCount: number
}

export function preprocessChatRecords(records: ChatRecord[]): PreprocessedRecords {
  const filtered = records.filter(r => r.type === 1)

  const otherMessages: ChatRecord[] = []
  const selfMessages: ChatRecord[] = []

  for (const r of filtered) {
    if (r.isSend) {
      selfMessages.push(r)
    } else {
      otherMessages.push(r)
    }
  }

  const dedupedOther = deduplicate(otherMessages)
  const dedupedSelf = deduplicate(selfMessages)

  const allSorted = [...filtered].sort((a, b) => a.timestamp - b.timestamp)
  const dedupedAll = deduplicate(allSorted)

  const replaced = dedupedAll.map(r => ({
    ...r,
    content: replaceMediaPlaceholders(r.content)
  }))

  const segments = segmentByTime(replaced, 30 * 60 * 1000)

  const sampled = replaced.length > 3000 ? uniformSample(replaced, 3000) : replaced

  return {
    otherMessages: dedupedOther.map(r => ({ ...r, content: replaceMediaPlaceholders(r.content) })),
    selfMessages: dedupedSelf.map(r => ({ ...r, content: replaceMediaPlaceholders(r.content) })),
    segments: segments.map(seg => seg.map(r => ({ ...r, content: replaceMediaPlaceholders(r.content) }))),
    totalCount: sampled.length
  }
}

function deduplicate(records: ChatRecord[]): ChatRecord[] {
  const result: ChatRecord[] = []
  let prevContent = ''
  for (const r of records) {
    if (r.content !== prevContent) {
      result.push(r)
      prevContent = r.content
    }
  }
  return result
}

function replaceMediaPlaceholders(content: string): string {
  return content
    .replace(/\[图片\]/g, '[媒体:图片]')
    .replace(/\[视频\]/g, '[媒体:视频]')
    .replace(/\[语音\]/g, '[媒体:语音]')
    .replace(/\[文件\]/g, '[媒体:文件]')
    .replace(/\[表情\]/g, '[媒体:表情]')
}

function segmentByTime(records: ChatRecord[], gapMs: number): ChatRecord[][] {
  if (records.length === 0) return []

  const segments: ChatRecord[][] = []
  let currentSegment: ChatRecord[] = [records[0]]

  for (let i = 1; i < records.length; i++) {
    if (records[i].timestamp - records[i - 1].timestamp > gapMs) {
      segments.push(currentSegment)
      currentSegment = [records[i]]
    } else {
      currentSegment.push(records[i])
    }
  }

  segments.push(currentSegment)
  return segments
}

function uniformSample(records: ChatRecord[], targetCount: number): ChatRecord[] {
  const step = records.length / targetCount
  const result: ChatRecord[] = []
  for (let i = 0; i < targetCount; i++) {
    const index = Math.floor(i * step)
    result.push(records[index])
  }
  return result
}
