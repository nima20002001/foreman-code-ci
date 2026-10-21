import { z } from 'zod'
import { BROWSER_DEVICE_EXTENSION, BrowserPrivateCommandSchema, BrowserPrivateEnvelopeSchema,
  BrowserKeyRequestSchema, BrowserKeyEnvelopeSchema, BrowserPrivateResultSchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { BrowserDeviceCodecs, BrowserDeviceCommand, BrowserDeviceUpload, BrowserDeviceDownload } from '../browser-runtime/deviceExtension.js'
import type { BrowserInstallationBinding } from '../browser-profiles/keys.js'
import { DomainError } from '../errors.js'

export type BrowserInvocation = z.infer<typeof BrowserPrivateEnvelopeSchema>
const sessionMethods = new Set(['authorizeUpload', 'open', 'list', 'get', 'reconnect', 'close', 'action', 'perform',
  'observe', 'screenshot', 'tabs', 'tab', 'acquire', 'release', 'pause', 'input', 'viewOpen', 'viewRead', 'viewClose', 'openLocal'])
const profileMethods = new Set(['status', 'create', 'remove', 'export', 'apply', 'prune', 'checkOrigin'])

/** The paired decoder obtains a fresh principal from the originating Main request, never from wire JSON. */
export function createBrowserDeviceCodecs(options: {
  issue(kind: BrowserInvocation['kind'], value: unknown, principal?: ManagementPrincipal): BrowserInvocation
  authorize(binding: BrowserInstallationBinding, envelope: BrowserInvocation): Promise<ManagementPrincipal | undefined>
}): BrowserDeviceCodecs<ManagementPrincipal> {
  const decode = async (binding: BrowserInstallationBinding, raw: unknown, kind: BrowserInvocation['kind']) => {
    const envelope = BrowserPrivateEnvelopeSchema.parse(raw)
    if (envelope.kind !== kind) throw new DomainError('BROWSER_DEVICE_SCOPE', 'The browser transport operation changed.', 403)
    const principal = await options.authorize(binding, envelope)
    return { value: envelope.value, principal }
  }
  const requireCaller = (principal: ManagementPrincipal | undefined) => {
    if (!principal) throw new DomainError('BROWSER_DEVICE_SCOPE', 'The browser operation has no authenticated caller.', 403)
    return principal
  }
  return {
    descriptor: BROWSER_DEVICE_EXTENSION,
    encodeCommand(input) {
      if (input.kind === 'profile') return options.issue('command', input)
      const { principal, ...value } = input
      return options.issue('command', value, principal)
    },
    async decodeCommand(binding, raw) {
      const { value, principal } = await decode(binding, raw, 'command')
      const command = BrowserPrivateCommandSchema.parse(value)
      const allowed = command.kind === 'profile' ? profileMethods : sessionMethods
      if (!allowed.has(command.method)) throw new DomainError('BROWSER_DEVICE_METHOD', 'Unknown browser host operation.', 400)
      return { ...command, ...(command.kind === 'session' ? { principal: requireCaller(principal) } : {}) } as BrowserDeviceCommand<ManagementPrincipal>
    },
    encodeResult: (_input, value) => ({ value: value ?? null }),
    decodeResult: (_input, value) => BrowserPrivateResultSchema.parse(value).value,
    encodeUpload(input) {
      if (input.kind === 'snapshot') return options.issue('upload', input)
      const { principal, ...value } = input
      return options.issue('upload', value, principal)
    },
    async decodeUpload(binding, raw) {
      const { value, principal } = await decode(binding, raw, 'upload')
      const input = value as Omit<BrowserDeviceUpload<ManagementPrincipal>, 'principal'>
      if (input.kind !== 'snapshot' && input.kind !== 'file') throw new DomainError('BROWSER_DEVICE_METHOD', 'Unknown browser upload.', 400)
      return { ...input, ...(input.kind === 'file' ? { principal: requireCaller(principal) } : {}) } as BrowserDeviceUpload<ManagementPrincipal>
    },
    encodeUploadResult: (_input, value) => ({ value: value ?? null }),
    decodeUploadResult: (_input, value) => BrowserPrivateResultSchema.parse(value).value,
    encodeDownload(input) {
      if (input.kind === 'snapshot') return options.issue('download', input)
      const { principal, ...value } = input
      return options.issue('download', value, principal)
    },
    async decodeDownload(binding, raw) {
      const { value, principal } = await decode(binding, raw, 'download')
      const input = value as Omit<BrowserDeviceDownload<ManagementPrincipal>, 'principal'>
      if (!['snapshot', 'file', 'screenshot'].includes(input.kind)) throw new DomainError('BROWSER_DEVICE_METHOD', 'Unknown browser download.', 400)
      return { ...input, ...(input.kind !== 'snapshot' ? { principal: requireCaller(principal) } : {}) } as BrowserDeviceDownload<ManagementPrincipal>
    },
    encodeKey: input => BrowserKeyRequestSchema.parse(input),
    decodeKey: async (_binding, value) => BrowserKeyRequestSchema.parse(value),
    encodeKeyResult: ({ encrypted, ...value }) => BrowserKeyEnvelopeSchema.parse({ ...value, contentBase64: Buffer.from(encrypted).toString('base64') }),
    decodeKeyResult: value => {
      const { contentBase64, ...metadata } = BrowserKeyEnvelopeSchema.parse(value)
      return { ...metadata, encrypted: Buffer.from(contentBase64, 'base64') }
    },
  }
}
