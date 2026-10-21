import { expect, it } from 'vitest'
import { CiCoverageSelectionSchema } from '@foreman-code/contracts'
import { CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('admits runner-selected integration partitions without repository coverage support', async () => {
  const f = await fixture({ cloud: true })
  f.computers.splice(0)
  try {
    const caller = await f.credential(CI_RUN_ACTIONS)
    const admitted = await f.ci.run(caller.principal, { workspaceId: f.workspaceId,
      suite: 'integration', partitions: 2, commandId: 'runner-selected-admission' })
    expect(admitted.partitions).toHaveLength(2)
    const saved = await f.pool.query<{ integration_selection: unknown }>(`select integration_selection from ci_runs
      where group_id=(select group_id from ci_runs where id=$1) and integration_selection is not null`, [admitted.ticketId])
    expect(saved.rows).toHaveLength(1)
    expect(CiCoverageSelectionSchema.parse(saved.rows[0]!.integration_selection)).toEqual({ changedFiles: [],
      reason: 'Repository ancestry or source trees are unavailable.' })
  } finally { await f.close() }
})
