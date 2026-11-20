export const historyKinds = { text: '文字', image: '图片', video: '视频', emoji: '表情', voice: '语音', file: '文件', other: '其他（链接、小程序、系统消息等）' } as const
export type HistoryKind = keyof typeof historyKinds
export const allHistoryKinds = Object.keys(historyKinds) as HistoryKind[]

export function selectedKinds(kinds?: HistoryKind[]): HistoryKind[] {
  if (kinds === undefined) return [...allHistoryKinds]
  if (!Array.isArray(kinds) || !kinds.length || kinds.some(k => !allHistoryKinds.includes(k))) throw new Error('请至少选择一种有效的消息类型')
  return allHistoryKinds.filter(k => kinds.includes(k))
}
