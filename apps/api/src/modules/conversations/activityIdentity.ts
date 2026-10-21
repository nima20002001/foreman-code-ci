import { ActivityNativeIdentitySchema, WorkRefSchema, type ActivityNativeIdentity, type WorkRef } from '@foreman-code/contracts'
export const conversationActivityKey = (requestId: string, id: string) => JSON.stringify([requestId, id])
export const conversationActivityId = (conversationId: string, requestId: string, id: string) => JSON.stringify(['conversation-activity', conversationId, requestId, id])
export function publicActivityProvenance(input: unknown): { native?: ActivityNativeIdentity; parent?: WorkRef } {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const native = ActivityNativeIdentitySchema.safeParse(record.native)
  const parent = WorkRefSchema.safeParse(record.parent)
  return { ...(native.success ? { native: native.data } : {}), ...(parent.success ? { parent: parent.data } : {}) }
}
