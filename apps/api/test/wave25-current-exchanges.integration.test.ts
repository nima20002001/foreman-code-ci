import { postgresEnabled } from './helpers/wave25Agent3.js'
import { afterEach, describe, expect, it } from 'vitest'

import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { readCurrentGraphExchanges } from '../src/modules/interactions/wave25/currentExchanges.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })

describe.skipIf(!postgresEnabled)('Wave 2.5 production compact graph composition', { timeout: 60000 }, () => {
  it('reads authoritative current exchanges and exposes the qualified shared service', async () => {
    const fixture = await approvalDatabase()
    closes.push(fixture.close)
    const exchanges = await withExclusiveGraphConnection(fixture.pool,
      (connection) => connection.transaction((sql) => readCurrentGraphExchanges(sql, fixture.scope), true))
    expect(exchanges.interactions).toEqual([
      expect.objectContaining({ interactionId: fixture.interaction.id, status: fixture.interaction.status }),
    ])
    expect(exchanges.reviews).toEqual([
      expect.objectContaining({ reviewJobId: fixture.job.id, interactionId: fixture.interaction.id }),
    ])

    const reader = await fixture.access.issue({ name: 'graph-reader', audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
      grants: [{ actions: ['capabilities:read'], scope: {} },
        { actions: ['runs:read'], scope: { workspaceIds: [fixture.run.workspaceId], workflowIds: [fixture.run.workflowId], runIds: [fixture.run.id] } }] })
    const service = new RunGraphReadService(fixture.pool, { qualifiedReads: true })
    expect(service.capabilities(reader.principal)).toMatchObject({ protocolVersions: [1], readSemanticsVersions: [3], semantics3: { persistedReads: true, runtimeAdmission: false } })
    const snapshot = await service.snapshot(reader.principal, { protocolVersion: 1, scope: fixture.scope })
    expect(snapshot.state.interactions[0]?.interactionId).toBe(fixture.interaction.id)
    expect(snapshot.state.reviews[0]?.reviewJobId).toBe(fixture.job.id)
  })
})
