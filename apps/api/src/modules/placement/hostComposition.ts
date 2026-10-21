import type { AcceptedNodePlacement, DispatchIntent, OwnerControl, PlacementDispatchPort, WorkerObservation } from '@foreman-code/contracts/node-placement'
import { DispatchIntentSchema, OwnerControlSchema, WorkerObservationSchema } from '@foreman-code/contracts/node-placement'
import { DomainError } from '../errors.js'
import { readPlacement } from './binding.js'

/** Supplied by the approved W07 connection and W08-B receipt bridge. Allocation
 * cannot grant dispatch scope; absence of this bridge must reject remote work. */
export interface AuthorizedPlacementTransport extends PlacementDispatchPort {
  assertAuthorized(placement: AcceptedNodePlacement, action: 'deliver' | 'reconcile' | 'control'): Promise<void>
}

export class HostAwarePlacementDispatch implements PlacementDispatchPort {
  constructor(private readonly mainId: string, private readonly local: AuthorizedPlacementTransport,
    private readonly remote?: AuthorizedPlacementTransport) {}

  private select(raw: AcceptedNodePlacement): { placement: AcceptedNodePlacement; transport: AuthorizedPlacementTransport } {
    const placement = readPlacement(raw)
    if (placement.mainId !== this.mainId) throw new DomainError('PLACEMENT_MAIN_MISMATCH', 'Placement belongs to another main.', 409)
    const transport = placement.hostRef.kind === 'main' ? this.local : this.remote
    if (!transport) throw new DomainError('REMOTE_DISPATCH_UNAVAILABLE', 'The approved worker connection has no execution dispatch capability.', 503)
    return { placement, transport }
  }

  private assertIntent(intent: DispatchIntent, placement: AcceptedNodePlacement): void {
    if (intent.mainId !== placement.mainId || intent.runId !== placement.runId
      || intent.nodeId !== placement.nodeId || intent.bindingHash !== placement.bindingHash) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'Dispatch must use the exact accepted node placement.', 409)
    }
  }

  async deliver(raw: DispatchIntent, pin: AcceptedNodePlacement): Promise<void> {
    const intent = DispatchIntentSchema.parse(raw)
    const { placement, transport } = this.select(pin)
    this.assertIntent(intent, placement)
    await transport.assertAuthorized(placement, 'deliver')
    // Retrying transport delivery means the SAME durable operation, never a new
    // native attempt. The W08-B bridge owns receipt/reservation/entry fencing.
    await transport.deliver(intent, placement)
  }

  async reconcile(raw: DispatchIntent, pin: AcceptedNodePlacement): Promise<WorkerObservation | null> {
    const intent = DispatchIntentSchema.parse(raw)
    const { placement, transport } = this.select(pin)
    this.assertIntent(intent, placement)
    await transport.assertAuthorized(placement, 'reconcile')
    const rawObservation = await transport.reconcile(intent, placement)
    if (rawObservation === null) return null // unknown: never negative native-entry evidence
    const observation = WorkerObservationSchema.parse(rawObservation)
    const registration = placement.registration
    if (observation.operationId !== intent.operationId || observation.attemptId !== intent.attemptId
      || observation.executionId !== intent.executionId || observation.bindingHash !== intent.bindingHash
      || observation.connection.mainId !== this.mainId || placement.hostRef.kind !== 'device'
      || observation.connection.deviceId !== placement.hostRef.deviceId || !registration
      || observation.connection.workerInstallationId !== registration.workerInstallationId
      || observation.connection.keyRevision !== registration.keyRevision
      || observation.connection.authorizationRevision !== registration.authorizationRevision) {
      throw new DomainError('WORKER_OBSERVATION_CONFLICT', 'Worker observation does not match the accepted host and operation.', 409)
    }
    return observation
  }

  async control(raw: OwnerControl, pin: AcceptedNodePlacement): Promise<void> {
    const command = OwnerControlSchema.parse(raw)
    const { placement, transport } = this.select(pin)
    if (command.bindingHash !== placement.bindingHash) throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'Control cannot change accepted placement.', 409)
    await transport.assertAuthorized(placement, 'control')
    await transport.control(command, placement)
  }
}
