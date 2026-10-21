import { workflowPreparationExtension } from './preparationExtension.js'
import type { DeviceExtensionRegistration } from '../../devices/deviceApplicationChannel.js'
import { RemoteExecutionHost, type RemoteExecutionHostPorts } from './executionHost.js'
import { RemoteJobExecutionHost, type RemoteJobExecutionHostPorts } from './jobExecutionHost.js'
import { createRemoteExecutionHandler } from './executionRouter.js'
import { WorkerConversationHost, type WorkerConversationHostPorts } from '../../conversations/workerHost.js'

/** Installer supplies actual admitted host/journal/source/OCI ports. No actor,
 * lease, readiness or private repository is synthesized by this composition. */
export function createWorkerExecutionDomains(input: { workflows: RemoteExecutionHostPorts;
  jobs?: RemoteJobExecutionHostPorts; conversations?: WorkerConversationHostPorts }) {
  const jobConnection = input.jobs?.connection
  if (jobConnection && ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'bootId'].some(key =>
    Reflect.get(jobConnection, key) !== Reflect.get(input.workflows.connection, key))) throw new Error('Worker domains must share their actual authenticated host identity.')
  const workflows = new RemoteExecutionHost(input.workflows), jobs = input.jobs ? new RemoteJobExecutionHost(input.jobs) : undefined
  const conversations = input.conversations ? new WorkerConversationHost(input.conversations) : undefined
  let closing = false
  const extensions: DeviceExtensionRegistration[] = [{ namespace: 'execution-v1', version: 1, role: 'duplex',
    maxJsonBytes: 1024 * 1024, maxBinaryBytes: 0, async handle(payload, context) {
      context.signal.throwIfAborted()
      if (closing || ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'bootId'].some(key =>
        Reflect.get(context.binding, key) !== Reflect.get(input.workflows.connection, key))) throw new Error('Worker execution generation is unavailable.')
      if (context.bytes !== undefined) throw new Error('Native execution requests cannot contain binary bytes.')
      const result = await createRemoteExecutionHandler(workflows, jobs, conversations ? {
        handle: raw => conversations.handle(raw, context.binding, context.signal),
      } : undefined)(payload)
      context.signal.throwIfAborted()
      return { payload: result }
    } }]
  extensions.push(workflowPreparationExtension(extensions[0]!))
  return { extensions, workflows, jobs, conversations, async close() {
    closing = true
    await Promise.all([workflows.shutdown(), jobs?.shutdown(), conversations?.shutdown()])
  } }
}
