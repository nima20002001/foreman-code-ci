import { randomUUID } from 'node:crypto'
import { DomainError } from '../errors.js'
import { newBrowserReplica } from './service.js'
import type { BrowserProfileService } from './service.js'
import type { ProfileHostIntent } from './types.js'

/** Short durable claims surround native work; no SQL transaction stays open over a host request. */
export async function reconcileBrowserProfileIntent(service: BrowserProfileService, intentId: string): Promise<ProfileHostIntent> {
  const found = await service.repository.read(tx => tx.intent(intentId))
  if (!found) throw new DomainError('NOT_FOUND', 'Browser operation not found.', 404)
  if (found.operation === 'sync') return found
  const claimId = randomUUID(), now = Date.parse(service.now())
  const claim = await service.repository.transaction([`profile:${found.profileId}`], async tx => {
    const intent = (await tx.intent(intentId))!, facts = await tx.replicaFacts(intent.profileId, intent.computerId)
    if (intent.state === 'completed' || intent.state === 'failed') return { intent, claimed: false }
    if (facts.currentIntent?.id !== intent.id || intent.operation === 'create' && (await tx.profile(intent.profileId))?.deleted) {
      const superseded: ProfileHostIntent = { ...intent, state: 'failed', reason: 'A newer profile operation replaced this request.' }
      await tx.putIntent(superseded); return { intent: superseded, claimed: false }
    }
    if (intent.claimUntil && intent.claimUntil > now) return { intent, claimed: false }
    const running: ProfileHostIntent = { ...intent, claimId, claimUntil: now + 30_000 }
    await tx.putIntent(running); return { intent: running, claimed: true }
  })
  if (!claim.claimed) return claim.intent
  const intent = claim.intent
  const finish = (state: ProfileHostIntent['state'], reason: string | null) => service.repository.transaction([`profile:${intent.profileId}`], async tx => {
    const current = (await tx.intent(intent.id))!
    if (current.claimId !== claimId || current.state === 'completed') return current
    const next: ProfileHostIntent = { ...current, state, reason }
    delete next.claimId
    delete next.claimUntil
    const latest = await tx.replicaFacts(intent.profileId, intent.computerId)
    await tx.putIntent(next)
    if (state === 'completed' && latest.currentIntent?.id === intent.id) {
      const replica = await tx.replica(intent.profileId, intent.computerId) ?? newBrowserReplica(intent.profileId, intent.computerId)
      await tx.putReplica(intent.operation === 'remove'
        ? { ...newBrowserReplica(intent.profileId, intent.computerId), reason: 'Local profile removed.' }
        : { ...replica, lastSeenAt: service.now(), reason: null })
    }
    return next
  })
  try {
    const status = await service.host.status(intent.profileId, intent.computerId)
    if (status !== 'ready') return finish('queued', status === 'busy' ? 'Waiting for browser sessions to close.'
      : status === 'offline' ? 'Computer offline.' : 'Waiting for browser runtime setup.')
    const current = await service.repository.read(tx => tx.replicaFacts(intent.profileId, intent.computerId))
    if (current.currentIntent?.id !== intent.id) return finish('failed', 'A newer profile operation replaced this request.')
    const admitted = await service.repository.transaction([`profile:${intent.profileId}`], async tx => {
      const latest = await tx.intent(intent.id)
      if (latest?.claimId !== claimId || (await tx.replicaFacts(intent.profileId, intent.computerId)).currentIntent?.id !== intent.id) return false
      await tx.putIntent({ ...latest, state: 'running', reason: null }); return true
    })
    if (!admitted) return (await service.repository.read(tx => tx.intent(intent.id)))!
    await service.host[intent.operation as 'create' | 'remove']({ profileId: intent.profileId, computerId: intent.computerId,
      operationId: intent.id, revision: intent.revision, installationId: intent.installationId })
    return finish('completed', null)
  } catch {
    return finish('queued', 'Could not confirm the computer operation. Reconnect to check its original receipt.')
  }
}
