import { randomUUID } from 'node:crypto'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerConversationBinding, WorkerConversationConfiguration } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager } from '../../src/modules/harnesses/port.js'
import type { NativeLaunchObservation } from '../../src/modules/harnesses/recovery/processRegistry.js'
import type { WorkerConversationAllocation, WorkerConversationHostPorts } from '../../src/modules/conversations/workerHost.js'
import { recoverWorkerConversation } from '../../src/modules/conversations/recoverWorkerConversation.js'
import { workerConversationProcessDigest } from '../../src/modules/conversations/workerNativeOwner.js'
import type { WorkerConversationJournal } from '../../src/modules/conversations/workerJournal.js'

/** Record process identities at the native I/O boundary; use the production recovery path. */
export function recordedConversationRuntime(input: {
  connection: Readonly<DeviceSessionBinding>
  journal: WorkerConversationJournal
  manager(binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration): Promise<NativeHarnessSessionManager>
  released(conversationId: string): void
  authorize: WorkerConversationHostPorts['authorize']
}): Pick<WorkerConversationHostPorts, 'allocate' | 'recover'> {
  const launches: NativeLaunchObservation[] = []
  const registry = {
    snapshot: () => ({ revision: 'recorded', launches }),
    closeOwner: async (owner: string) => launches.filter(launch => launch.owner === owner)
      .every(launch => launch.lifecycle === 'closed' && Boolean(launch.closureEvidence)),
  }
  const allocate = async (binding: WorkerConversationBinding, configuration: WorkerConversationConfiguration):
    Promise<WorkerConversationAllocation> => {
    if (binding.owner.kind !== 'agent' || !('agentId' in configuration)) throw new Error('Agent fixture required')
    const owner = binding.owner
    const manager = await input.manager(binding, configuration)
    const index = launches.length
    const launch: NativeLaunchObservation = {
      owner: `conversation:${owner.conversationId}`, launchId: randomUUID(), bootId: input.connection.bootId,
      lifecycle: 'active', guardian: { pid: index + 100, startTicks: String(index + 100) },
      provider: { pid: index + 200, startTicks: String(index + 200) },
      boundary: { kind: 'cgroup-v2', path: `/recorded/cgroup/${index}`, device: '1', inode: String(index) },
    }
    launches.push(launch)
    return { manager, start: async ({ correlationId, instructionsDelivered }) => ({
      kind: 'agent-chat', configuration, conversationId: owner.conversationId,
      workflowId: owner.workflowId, workflowNodeId: owner.workflowNodeId,
      workingDirectory: binding.workingDirectory, correlationId, instructionsDelivered,
      ...(binding.systemPrompt ? { systemPrompt: binding.systemPrompt } : {}),
    }), nativeOwner: async session => ({ sessionId: session.nativeSessionId,
      processIdentityDigest: workerConversationProcessDigest(binding, launch) }),
    close: async () => {
      await manager.dispose?.()
      launches[index] = { ...launch, lifecycle: 'closed', closureEvidence: 'native_exit_removed_cgroup' }
      input.released(owner.conversationId)
    } }
  }
  return { allocate,
    recover: async (record, configuration, connection, signal, request) => recoverWorkerConversation({
      record, configuration, connection, signal, request, registry, journal: input.journal,
      allocate: () => allocate(configuration.id === record.binding.owner.configurationVersionId
        ? record.binding : request.binding, configuration),
      assertCurrent: () => input.authorize(request, connection, signal),
    }),
  }
}
