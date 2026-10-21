import { isDeepStrictEqual } from 'node:util'
import { lstat } from 'node:fs/promises'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { RSYNC_STAGE_EXTENSION, RsyncTransferAuthorizeRequestSchema, TransferIntentSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import { readProtectedInstalledRsyncSelection, readProtectedInstalledRsyncWriterSelection, createInstalledRsyncSelectionProvider } from './installedRsyncSelection.js'
import { authenticatedTransferAuthority, transferContextForBinding, type AcceptedTransferAuthority } from './carrier.js'
import { ResumableByteTransferService } from './service.js'
import type { InstalledMainRsyncProviders, InstalledRsyncProviders } from './productionComposition.js'
import type { RsyncWriterOwnership } from './rsyncWriterOwnership.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { PostgresTrustedConnectionSetup } from '../devices/trustedConnectionSetup.js'
import { DomainError } from '../errors.js'

const unavailable = (reason: string): never => { throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', reason, 409) }
/** No source/native path fallback: domain composition must supply retained immutable bytes and canonical ACK. */
const domainSource: InstalledRsyncProviders['resolveSource'] = async () => unavailable('No original immutable source reader owns this selected transfer.')
const domainAcknowledged: InstalledRsyncProviders['acknowledged'] = async () => unavailable('No canonical publication or delivery owns this selected transfer.')
function stopped(ownership: () => RsyncWriterOwnership | undefined) {
  return async (intent: TransferIntent, signal: AbortSignal) => {
    const original = ownership()
    if (!original || !original.inventory().some(value => isDeepStrictEqual(value, intent))) unavailable('The original selected transfer has no physical writer registry.')
    await original!.quiescent(intent, signal)
  }
}

/** Shipped worker loads only the installer-owned selection, including protected Node/writer bundle pins. */
export async function loadWorkerRsyncEntrypoint(input: { path: string; pairing: WorkerPairingConfiguration;
  entryPoint: string;
  current(): Readonly<DeviceSessionBinding> | undefined;
  request(payload: unknown, signal: AbortSignal): Promise<{ payload: unknown; bytes?: Uint8Array }>;
  ownership(): RsyncWriterOwnership | undefined }) {
  const selected = await readProtectedInstalledRsyncWriterSelection(input.path, input.pairing, AbortSignal.timeout(10_000))
  if (!selected) return { kind: 'unavailable' as const, reason: 'No protected rsync-selection.json is installed.' }
  if (selected.entryPoint !== input.entryPoint) unavailable('The selected writer must be the packaged rsync-writer.mjs from this installation.')
  const current = () => input.current() ?? unavailable('The original paired Main rsync channel is unavailable.')
  const accepted: AcceptedTransferAuthority = {
    async intent(id, binding) {
      if (!isDeepStrictEqual(current(), binding)) unavailable('The original rsync authorization generation changed.')
      const reply = await input.request(RsyncTransferAuthorizeRequestSchema.parse({ kind: 'rsync-stage-v1', method: 'transfer-authorize', transferId: id }), AbortSignal.timeout(10_000))
      const intent = TransferIntentSchema.parse(reply.payload)
      // Admission keeps its original epoch; Main reauthorizes it on this live channel.
      const identityChanged = (['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const)
        .some(key => intent[key] !== binding[key])
      if (reply.bytes !== undefined || intent.transferId !== id || identityChanged
        || !isDeepStrictEqual(current(), binding)) unavailable('Main rsync authorization returned another original transfer or generation.')
      return intent
    },
    async authorize(intent, context) {
      const binding = current()
      if (!isDeepStrictEqual(transferContextForBinding(binding), context) || !isDeepStrictEqual(await accepted.intent(intent.transferId, binding), intent))
        unavailable('The actual original Main transfer authority changed.')
    },
  }
  const receiver = new ResumableByteTransferService(`${selected.stagingRoot}/canonical`, authenticatedTransferAuthority(
    deviceId => { const binding = input.current(); return binding?.deviceId === deviceId ? binding : undefined }, accepted))
  try {
    await receiver.recoverOwnership()
  } catch (error) {
    await receiver.close()
    throw error
  }
  const providers: InstalledRsyncProviders = { ...selected, accepted, receiver, resolveSource: domainSource,
    acknowledged: domainAcknowledged, quiescent: stopped(input.ownership) }
  return { kind: 'configured' as const, providers, close: () => receiver.close() }
}

/** Main supports the exact device selected in its protected installation record. Missing selection is explicit unavailability. */
export async function readMainRsyncEntrypoint(path: string) {
  const present = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
  if (!present) return { kind: 'unavailable' as const, reason: 'No protected rsync-selection.json is installed.' }
  const selected = await readProtectedInstalledRsyncSelection(path, AbortSignal.timeout(10_000))
  if (!selected) return { kind: 'unavailable' as const, reason: 'No protected rsync-selection.json is installed.' }
  return { kind: 'configured' as const, selected, path }
}
export type MainRsyncEntrypoint = Awaited<ReturnType<typeof readMainRsyncEntrypoint>>
export function createMainRsyncEntrypoint(input: { installation: Extract<MainRsyncEntrypoint, { kind: 'configured' }>;
  endpoint(): DeviceEndpoint; setup: Pick<PostgresTrustedConnectionSetup, 'checkAcceptedTransfer' | 'readAcceptedTransfer'>;
  accepted: AcceptedTransferAuthority; ownership(): RsyncWriterOwnership | undefined }) {
  const { selected, path } = input.installation, deviceId = selected.registration.deviceId
  const capture = () => input.endpoint().captureRequest(deviceId, RSYNC_STAGE_EXTENSION.namespace)
  const receiver = new ResumableByteTransferService(`${selected.endpoint.localRoot}/canonical`, authenticatedTransferAuthority(
    id => id === deviceId ? capture()?.binding : undefined, input.accepted))
  const selection = createInstalledRsyncSelectionProvider({ accepted: input.accepted, setup: input.setup,
    capture: id => id === deviceId ? capture()?.binding : undefined,
    installed: async (id, signal) => {
      const record = await readProtectedInstalledRsyncSelection(path, signal)
      if (id !== deviceId || !record || !isDeepStrictEqual(record, selected)) unavailable('The original protected Main rsync installation changed.')
      return record
    } })
  const providers: InstalledMainRsyncProviders = { stagingRoot: selected.endpoint.localRoot, accepted: input.accepted, receiver,
    selection: selection.selection, peer: { capture }, resolveSource: domainSource, acknowledged: domainAcknowledged, quiescent: stopped(input.ownership) }
  return { providers, recover: () => receiver.recoverOwnership(), close: () => receiver.close() }
}
