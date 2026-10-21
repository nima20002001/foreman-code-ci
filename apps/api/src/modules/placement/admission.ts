import { DeviceRegistrationSchema, type DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { AcceptedDestinationSchema, SavedNodePlacementSchema, type AcceptedNodePlacement, type SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { posix } from 'node:path'
import { DomainError } from '../errors.js'
import { freezePlacement } from './binding.js'

/** W07 authenticates the destination. W09 owns exact source/materialization proof.
 * This port MUST verify worker signatures/connection and filesystem access on that host.
 * It is called before acquiring G1/SQL admission locks, never by a DB worker. */
export interface PlacementValidationPort {
  validate(saved: SavedNodePlacement, access: 'read-only' | 'read-write'): Promise<{
    hostRef: AcceptedNodePlacement['hostRef']; registration: DeviceRegistration | null
    destination: AcceptedNodePlacement['destination']; source: AcceptedNodePlacement['source']
    payload: AcceptedNodePlacement['payload']
  }>
}
export interface PlacementCommitFence {
  /** Read SQL-only live registration/grants/config/root-policy revisions using the
   * existing admission transaction. No remote filesystem IO inside this callback. */
  assertCurrent(placement: AcceptedNodePlacement): Promise<void>
  assertAllCurrent?(placements: readonly AcceptedNodePlacement[]): Promise<void>
}
export async function preparePlacementForRun(port: PlacementValidationPort, saved: SavedNodePlacement,
  identity: Pick<AcceptedNodePlacement, 'mainId' | 'mainInstallationId' | 'nodeId' | 'labelAtAcceptance'>,
  expectedPayload: AcceptedNodePlacement['payload'], access: 'read-only' | 'read-write'): Promise<(runId: string) => AcceptedNodePlacement> {
  saved = SavedNodePlacementSchema.parse(structuredClone(saved))
  identity = structuredClone(identity)
  expectedPayload = structuredClone(expectedPayload)
  const evidence = structuredClone(await port.validate(structuredClone(saved), access))
  const fail = () => { throw new DomainError('PLACEMENT_CONFLICT', 'Destination evidence does not match the selected immutable placement.', 409) }
  if (!sameWorkflowValue(evidence.hostRef, saved.hostRef) || saved.hostRef.mainId !== identity.mainId) fail()
  const destination = AcceptedDestinationSchema.parse(evidence.destination)
  if (saved.relativeCwd.includes('\0') || posix.isAbsolute(saved.relativeCwd)
    || saved.relativeCwd.split('/').includes('..')
    || (saved.cwdPolicy === 'project-root' && saved.relativeCwd !== '')
    || destination.canonicalCwd !== posix.join(destination.canonicalProjectRoot, saved.relativeCwd)) fail()
  if (destination.rootPolicyId !== saved.rootPolicyId || destination.rootPolicyRevision !== saved.rootPolicyRevision
    || destination.locationRevision !== saved.locationRevision) fail()
  if (!sameWorkflowValue(evidence.payload, expectedPayload)) fail()
  if (evidence.payload.kind === 'agent' && (evidence.payload.instanceId !== saved.instanceId
    || evidence.payload.instanceRevision !== saved.instanceRevision || evidence.payload.harnessInstallationId !== saved.harnessInstallationId)) fail()
  const registration = evidence.registration === null ? null : DeviceRegistrationSchema.parse(evidence.registration)
  if (saved.hostRef.kind === 'device') {
    if (!registration || registration.status !== 'paired' || registration.mainId !== identity.mainId
      || registration.deviceId !== saved.hostRef.deviceId) fail()
  } else if (registration !== null) fail()
  const pins = { schemaVersion: 1 as const, ...identity, hostRef: saved.hostRef,
    registration: registration === null ? null : { workerInstallationId: registration.workerInstallationId,
      keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision },
    destination, source: evidence.source, payload: expectedPayload }
  return (runId) => freezePlacement({ ...pins, runId })
}

export async function preparePlacement(port: PlacementValidationPort, saved: SavedNodePlacement,
  identity: Pick<AcceptedNodePlacement, 'mainId' | 'mainInstallationId' | 'runId' | 'nodeId' | 'labelAtAcceptance'>,
  expectedPayload: AcceptedNodePlacement['payload'], access: 'read-only' | 'read-write'): Promise<AcceptedNodePlacement> {
  const { runId, ...node } = structuredClone(identity)
  const bind = await preparePlacementForRun(port, saved, node, expectedPayload, access)
  return bind(runId)
}
