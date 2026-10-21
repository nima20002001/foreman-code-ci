import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import {
  AcceptedNodePlacementSchema, DispatchIntentSchema, type AcceptedNodePlacement, type DispatchIntent,
} from '@foreman-code/contracts/node-placement'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'

export function placementDigest(value: unknown): string {
  return createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
}
export function directoryIdentityHash(hostRef: AcceptedNodePlacement['hostRef'], device: string, inode: string): string {
  return placementDigest({ hostRef, device, inode })
}
function contains(root: string, child: string): boolean { return child === root || child.startsWith(`${root === '/' ? '' : root}/`) }
export function assertDestinationPolicy(placement: AcceptedNodePlacement): void {
  const d = placement.destination
  for (const path of [d.canonicalProjectRoot, d.canonicalCwd, d.managedRuntimeRoot]) {
    if (path.includes('\0') || path !== posix.normalize(path) || !posix.isAbsolute(path)) {
      throw new DomainError('PLACEMENT_INVALID_ROOT', 'Destination paths must be native canonical absolute paths.', 409)
    }
  }
  if (!contains(d.canonicalProjectRoot, d.canonicalCwd)
    || contains(d.canonicalProjectRoot, d.managedRuntimeRoot) || contains(d.managedRuntimeRoot, d.canonicalProjectRoot)) {
    throw new DomainError('PLACEMENT_INVALID_ROOT', 'Destination CWD containment or managed-runtime separation failed.', 409)
  }
}
/** Parse/copy accepted evidence; caller-owned mutation cannot change retained pins. */
export function freezePlacement(input: Omit<AcceptedNodePlacement, 'bindingHash'>): AcceptedNodePlacement {
  const placement = AcceptedNodePlacementSchema.parse({ ...structuredClone(input), bindingHash: placementDigest(input) })
  assertDestinationPolicy(placement)
  return freeze(placement)
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export function readPlacement(input: unknown): AcceptedNodePlacement {
  const parsed = AcceptedNodePlacementSchema.parse(input)
  const { bindingHash, ...pins } = parsed
  if (bindingHash !== placementDigest(pins)) throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'Accepted placement hash does not match its immutable pins.', 409)
  assertDestinationPolicy(parsed)
  return freeze(parsed)
}
/** Called lazily for an eligible occurrence; never reads a current Board/configuration. */
export function deriveDispatch(placement: AcceptedNodePlacement, identity: Omit<DispatchIntent, 'schemaVersion' | 'protocolVersion' | 'mainId' | 'runId' | 'nodeId' | 'bindingHash'>): DispatchIntent {
  const pins = readPlacement(placement)
  return freeze(DispatchIntentSchema.parse({ ...identity, schemaVersion: 1, protocolVersion: 1,
    mainId: pins.mainId, runId: pins.runId, nodeId: pins.nodeId, bindingHash: pins.bindingHash }))
}
