export function selectSameTimestampIncomingMessages<T>(
  sameTimestampIncoming: T[],
  sameTimestampAllowance: number,
  allowSameTimestampIncoming = false
): T[] {
  if (allowSameTimestampIncoming) return sameTimestampIncoming
  if (sameTimestampAllowance <= 0) return []
  return sameTimestampIncoming.slice(-sameTimestampAllowance)
}
