import { AGENT_SNAPSHOT_NAMESPACE, AgentSnapshotResultSchema } from '@foreman-code/contracts/source-materialization'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { DomainError } from '../errors.js'
import { snapshotAgentWorktree } from '../sources/agentSnapshot.js'
import { systemGitWorktreePorts } from '../sources/gitWorktree.js'
import type { ReadAgentFiles } from './agentSnapshots.js'

export function agentFileReader(endpointForDomains: () => Pick<DeviceEndpoint, 'capabilities' | 'request'>): ReadAgentFiles {
  return async (hostRef, path, baseCommit) => {
    const signal = AbortSignal.timeout(150_000)
    if (hostRef.kind === 'main') return snapshotAgentWorktree(systemGitWorktreePorts(), { path, baseCommit }, signal)
    const endpoint = endpointForDomains()
    if (!endpoint.capabilities(hostRef.deviceId).some(value => value.namespace === AGENT_SNAPSHOT_NAMESPACE && value.mainCanRequest)) {
      throw new DomainError('COMPUTER_OFFLINE', 'The Agent\'s computer is offline or its app is too old to send its files.', 409)
    }
    const reply = AgentSnapshotResultSchema.parse((await endpoint.request(hostRef.deviceId, AGENT_SNAPSHOT_NAMESPACE,
      { path, baseCommit }, { signal, timeoutMs: 150_000 })).payload)
    return { commit: reply.commit, bundle: reply.bundleBase64 === null ? null : Buffer.from(reply.bundleBase64, 'base64') }
  }
}
