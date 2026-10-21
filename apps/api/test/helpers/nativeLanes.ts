import type { NativeSessionLane, NativeSessionReference } from '@foreman-code/contracts'

import { DomainError } from '../../src/modules/errors.js'
import type { LaneLeaseOwnership, PostgresInteractionCoordinationRepository, WriterFence } from '../../src/modules/interactions/coordination.js'

/** In-memory persistence boundary; tests still run the real session writer and lease guards. */
export function nativeLanes(): PostgresInteractionCoordinationRepository {
  const sessions = new Map<string, { session: NativeSessionReference; finalized: boolean }>()
  const lanes = new Map<string, NativeSessionLane>()
  const owned = (id: string, token: string, ownership?: LaneLeaseOwnership) => {
    const lane = lanes.get(id)
    if (!lane || lane.leaseToken !== token
      || ownership && (lane.leaseOwner !== ownership.owner || lane.connectionGeneration !== ownership.connectionGeneration)
      || !ownership && Date.parse(lane.leaseExpiresAt ?? '') <= Date.now()) {
      throw new DomainError('SESSION_LANE_LEASE_LOST', 'The lane is no longer owned.', 409)
    }
    return lane
  }
  return {
    async assertReviewConnection() {},
    async reviewRunStopped() { return false },
    async finishStoppedReviews() {},
    async getLane(harness: NativeSessionLane['harness'], nativeSessionId: string) {
      const lane = [...lanes.values()].find((item) => item.harness === harness && item.nativeSessionId === nativeSessionId)
      return lane && structuredClone(lane)
    },
    async bindWorkflowSession(id: string, session: NativeSessionReference) { sessions.set(id, { session, finalized: false }) },
    async finalizeWorkflowSession(id: string) { const saved = sessions.get(id); if (saved) saved.finalized = true },
    async workflowSession(id: string) { return sessions.get(id) },
    async ensureLane(input: NativeSessionLane) {
      const existing = [...lanes.values()].find((lane) => lane.harness === input.harness && lane.nativeSessionId === input.nativeSessionId)
      if (existing && existing.ownerAgentId !== input.ownerAgentId) throw new DomainError('SESSION_LANE_OWNER_CONFLICT', 'Different owner.', 409)
      if (!existing) lanes.set(input.id, structuredClone(input))
      return structuredClone(existing ?? input)
    },
    async claimLane(id: string, revision: number, owner: string, token: string, expiresAt: string) {
      const current = lanes.get(id)
      if (!current || current.revision !== revision || Date.parse(current.leaseExpiresAt ?? '') > Date.now()) {
        throw new DomainError('SESSION_LANE_BUSY', 'The lane is already owned.', 409)
      }
      const lane = { ...current, revision: revision + 1, leaseOwner: owner, leaseToken: token,
        leaseExpiresAt: expiresAt, observedStatus: 'busy' as const }
      lanes.set(id, lane)
      return structuredClone(lane)
    },
    async assertLaneLease(id: string, token: string, ownership?: LaneLeaseOwnership) {
      const lane = owned(id, token, ownership)
      if (Date.parse(lane.leaseExpiresAt ?? '') <= Date.now()) {
        throw new DomainError('SESSION_LANE_LEASE_LOST', 'The lane expired.', 409)
      }
    },
    async renewLane(id: string, token: string, duration: number, ownership?: LaneLeaseOwnership) {
      const lane = owned(id, token, ownership)
      lane.leaseExpiresAt = new Date(Date.now() + duration).toISOString()
      return lane.leaseExpiresAt
    },
    async bindLaneTurn(fence: WriterFence, correlationId: string) {
      const lane = owned(fence.id, fence.token)
      lane.correlationId = correlationId
      delete lane.currentTurnOrMessageId
    },
    async acknowledgeLaneTurn(fence: WriterFence, correlationId: string, providerId: string) {
      const lane = owned(fence.id, fence.token)
      if (lane.correlationId !== correlationId
        || lane.currentTurnOrMessageId && lane.currentTurnOrMessageId !== providerId) {
        throw new DomainError('NATIVE_TURN_IDENTITY_CONFLICT', 'Different native turn.', 409)
      }
      lane.currentTurnOrMessageId = providerId
    },
    async releaseLane(id: string, token: string, observed: Pick<NativeSessionLane, 'observedStatus' | 'currentTurnOrMessageId'>) {
      const lane = owned(id, token)
      Object.assign(lane, observed, { revision: lane.revision + 1 })
      delete lane.leaseToken; delete lane.leaseExpiresAt; delete lane.leaseOwner
      if (observed.observedStatus === 'idle' && !observed.currentTurnOrMessageId) delete lane.correlationId
      return structuredClone(lane)
    },
  } as unknown as PostgresInteractionCoordinationRepository
}
