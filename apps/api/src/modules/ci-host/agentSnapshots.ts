import type pg from 'pg'
import { z } from 'zod'
import { MaterializationReceiptSchema } from '@foreman-code/contracts/source-materialization'
import type { AgentSnapshots } from './service.js'
import { SourceError } from '../sources/manifest.js'

export type AgentHostRef = { kind: 'main'; mainId: string } | { kind: 'device'; mainId: string; deviceId: string }
export type ReadAgentFiles = (hostRef: AgentHostRef, path: string, baseCommit: string) => Promise<{ commit: string; bundle: Buffer | null }>

/** The few facts CI needs from an Agent's accepted native placement. */
const AgentPlacementFacts = z.object({
  materialization: z.object({ receipt: z.object({ binding: z.object({ mainId: z.uuid(), deviceId: z.uuid().nullable() }).loose(),
    worktree: MaterializationReceiptSchema.shape.worktree }).loose() }).loose(),
  workingTree: z.object({ canonicalProjectRoot: z.string().startsWith('/') }).loose(),
}).loose()

/** An Agent's CI tests its current files: read them from the computer it runs on as a commit on its worktree base. */
export function agentSnapshots(pool: pg.Pool, read: ReadAgentFiles): AgentSnapshots {
  return async executionId => {
    const row = (await pool.query<{ record: unknown }>('select record from execution_native_placements where execution_id=$1',
      [executionId])).rows[0]
    if (!row) return null
    const placement = AgentPlacementFacts.parse(row.record)
    const worktree = placement.materialization.receipt.worktree
    if (!worktree) return null
    const binding = placement.materialization.receipt.binding
    const hostRef: AgentHostRef = binding.deviceId ? { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId }
      : { kind: 'main', mainId: binding.mainId }
    const baseCommit = worktree.startCommit ?? worktree.commit
    const snapshot = await read(hostRef, placement.workingTree.canonicalProjectRoot, baseCommit)
    if (snapshot.bundle === null && snapshot.commit !== baseCommit) {
      throw new SourceError('SOURCE_SNAPSHOT_INVALID', 'Unchanged Agent files must name their Run-start commit.')
    }
    return { baseCommit, ...snapshot }
  }
}
