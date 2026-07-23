export interface MessagePushDeliveryResult {
  eventId: number
  clientCount: number
  sentCount: number
  failedCount: number
}

export function isMessagePushDeliveryCommitted(delivery: MessagePushDeliveryResult): boolean {
  return Number(delivery?.sentCount || 0) > 0
}
