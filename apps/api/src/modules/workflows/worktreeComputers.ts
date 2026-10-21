import { worktreeComputerConflict, type WorktreeComputerSelection } from '@foreman-code/contracts/worktree-settings'
import { computerNameKey, readComputerNames } from '../computers/names.js'
import { DomainError } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'

export async function assertWorktreeComputers(sql: GraphSqlClient,
  selections: readonly WorktreeComputerSelection[]): Promise<void> {
  const conflict = worktreeComputerConflict(selections)
  if (!conflict) return
  const { first, second } = conflict
  const names = await readComputerNames(sql, first.hostRef.mainId)
  const label = ({ hostRef }: WorktreeComputerSelection) => names.get(computerNameKey(
    hostRef.mainId, hostRef.kind === 'device' ? hostRef.deviceId : undefined,
  )) ?? (hostRef.kind === 'main' ? 'Main' : `Computer ${hostRef.deviceId}`)
  throw new DomainError('WORKTREE_COMPUTER_CONFLICT',
    `Worktree prefix "${first.branchPrefix}" is used by ${first.agentName} on ${label(first)} `
    + `and ${second.agentName} on ${label(second)}. Place Agents using this worktree setting on one computer, `
    + 'or choose different branch prefixes.', 409)
}
