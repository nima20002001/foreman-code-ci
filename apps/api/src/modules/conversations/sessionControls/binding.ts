import type { NativeSessionReference, SessionControlCapabilities, SessionControlState } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../../harnesses/port.js'

export interface SessionControlBinding {
  conversationId: string
  principalId: string
  defaultSubject: string
  profileKey: string
  initialMode?: SessionControlState['desiredMode']
  busyReason: string | null
  session?: NativeSessionReference | undefined
  manager?: NativeHarnessSessionManager | undefined
  recoverCompaction?(state: NonNullable<SessionControlState['compaction']>): Promise<NonNullable<SessionControlState['compaction']>>
  pendingCapabilities?: SessionControlCapabilities
}
