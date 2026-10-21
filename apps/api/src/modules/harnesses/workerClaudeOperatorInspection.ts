import { isDeepStrictEqual } from 'node:util'
import { OperatorChatSetupSchema } from '@foreman-code/contracts'
import { HARNESS_PROFILE_CHECK_NAMESPACE, HostHarnessConfigurationInspectionRequestSchema } from '@foreman-code/contracts/harness-registry'
import { DomainError } from '../errors.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { matchesHarnessConnectionGeneration } from './hostConnectionGeneration.js'
import type { AcceptedClaudeProfile } from './instanceSettings/acceptedProfile.js'

export async function inspectWorkerClaudeOperatorConfiguration(input: {
  accepted: AcceptedClaudeProfile
  endpoint: Pick<DeviceEndpoint, 'captureRequest' | 'currentBinding' | 'clockReason'>
  expectedEndpoint: string
  signal: AbortSignal
  revalidate(): Promise<void>
}) {
  const host = input.accepted.override.target.hostRef
  if (host.kind !== 'device') throw new DomainError('HARNESS_HOST_MISMATCH',
    'Worker configuration inspection requires a Worker profile.', 409)
  const captured = input.endpoint.captureRequest(host.deviceId, HARNESS_PROFILE_CHECK_NAMESPACE)
  if (!captured) throw new DomainError('HARNESS_REMOTE_CHECK_UNAVAILABLE',
    'The selected Worker configuration inspector is unavailable.', 409)
  const revalidate = async () => {
    input.signal.throwIfAborted()
    await input.revalidate()
    const current = input.endpoint.currentBinding(host.deviceId)
    if (!isDeepStrictEqual(current, captured.binding) || captured.binding.mainId !== host.mainId
      || captured.binding.deviceId !== host.deviceId
      || captured.binding.workerInstallationId !== input.accepted.override.target.applicationInstallationId
      || !matchesHarnessConnectionGeneration(captured.binding, input.accepted.currentBinding.connectionGeneration)) {
      throw new DomainError('HARNESS_INVENTORY_STALE', 'The selected Worker inspection connection changed.', 409)
    }
    const clockReason = input.endpoint.clockReason(host.deviceId)
    if (clockReason) throw new DomainError('WORKER_CLOCK_UNTRUSTED', clockReason, 409)
    input.signal.throwIfAborted()
  }
  await revalidate()
  const request = HostHarnessConfigurationInspectionRequestSchema.parse({
    operation: 'operator-configuration-inspect', override: input.accepted.override,
    proof: input.accepted.persistedProof, endpoint: input.expectedEndpoint,
  })
  const reply = await captured.request(request, { signal: input.signal, timeoutMs: 30_000 })
  await revalidate()
  const setup = OperatorChatSetupSchema.parse(reply.payload)
  if (reply.bytes !== undefined || setup.harness !== 'claude' || setup.endpoint !== input.expectedEndpoint
    || setup.routing !== 'fixed' || setup.configurationVersionId !== undefined) {
    throw new DomainError('HARNESS_CONFIGURATION_MISMATCH',
      'The Worker returned an unrelated Operator configuration inspection.', 409)
  }
  return setup
}
