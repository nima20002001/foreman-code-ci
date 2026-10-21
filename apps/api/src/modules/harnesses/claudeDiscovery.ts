import type { PassiveDriverInstallationDeclaration } from './passiveDiscoveryChannel.js'

/** Provider-owned resolved CLI and SDK payload paths only; discovery never constructs the SDK or claims qualification. */
export function claudeDiscoveryDeclaration(input: {
  harnessInstallationId: string
  requestedLauncher: string
  payloadPaths: readonly string[]
  protocolRevision: string
}): PassiveDriverInstallationDeclaration {
  if (!input.harnessInstallationId || !input.requestedLauncher.startsWith('/') || input.payloadPaths.length === 0
    || input.payloadPaths.some(path => !path.startsWith('/')) || !input.protocolRevision) {
    throw new Error('Claude discovery requires explicit resolved launcher and SDK payload paths.')
  }
  return Object.freeze({ ...input, payloadPaths: Object.freeze([...input.payloadPaths]), driverId: 'claude', driverRevision: '1' })
}
