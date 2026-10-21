import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import type { AcceptedProfileSelector } from './instanceSettings/acceptedProfile.js'
import { DomainError } from '../errors.js'

export function workflowProfileSelection(context: NativeManagerResolutionContext,
  canonicalWorkingDirectory?: string): AcceptedProfileSelector | undefined {
  const placement = context.acceptedPlacement
  if (!placement) {
    return context.harness === 'claude' ? context.configuration.harnessProfileSelection : undefined
  }
  if (placement.payload.kind !== 'agent' || placement.payload.agentId !== context.agentId
    || placement.payload.agentConfigurationVersionId !== context.configuration.id
    || placement.runId !== context.runId
    || (canonicalWorkingDirectory ?? placement.destination.canonicalCwd) !== context.workingDirectory
    || placement.payload.driverId !== context.harness) {
    throw new DomainError('PLACEMENT_BINDING_CONFLICT',
      'The native role must use its exact accepted workflow placement.', 409)
  }
  return { instanceId: placement.payload.instanceId, instanceRevision: placement.payload.instanceRevision,
    target: { hostRef: placement.hostRef, applicationInstallationId: placement.hostRef.kind === 'main'
      ? placement.hostRef.mainId : placement.registration!.workerInstallationId,
    harnessInstallationId: placement.payload.harnessInstallationId,
    installationFingerprint: placement.payload.installationFingerprint } }
}
