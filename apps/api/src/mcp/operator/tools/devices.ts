import { DeviceSetupApproveInputSchema, DeviceSetupApproveResultSchema, DeviceSetupOptionsSchema } from '@foreman-code/contracts/device-setup'
import { z } from 'zod'
import { DeviceListResultSchema, DevicePairingGrantInputSchema, DevicePairingGrantResultSchema,
  DeviceRegistrationSchema, DeviceRevokeInputSchema, MainDeviceIdentityPublicSchema } from '@foreman-code/contracts/device-identity'
import { defineOperatorTool } from '../definition.js'

const reads = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
export const deviceOperatorTools = [
  defineOperatorTool({
    name: 'device_main_identity_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.devices,
    description: 'Read this main application UUID and public Ed25519 fingerprint for explicit selected-main pairing approval. Requires global settings:read. No private keys or credentials.',
    inputSchema: z.object({}).strict(), outputSchema: MainDeviceIdentityPublicSchema, annotations: reads,
    run: (context) => context.services.devices!.readMainIdentity(context.principal),
  }),
  defineOperatorTool({
    name: 'devices_list',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.devices,
    description: 'Read persisted device registration, least-privilege scopes and authorization revisions. Requires global settings:read. Connection state and remote task admission are separate.',
    inputSchema: z.object({}).strict(), outputSchema: DeviceListResultSchema, annotations: reads,
    run: async (context) => ({ devices: await context.services.devices!.list(context.principal) }),
  }),
  defineOperatorTool({
    name: 'device_pairing_grant_create',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.devices,
    description: 'Approve the exact worker fingerprint/scopes and issue a one-hour, single-use key-bound device pairing grant. Pairing issues a 100-year credential subject to revocation and scope checks. Requires global settings:update and explicit selected identity approval. Treat the returned grant as secret. No dispatch/transfer scopes or provider credentials.',
    inputSchema: DevicePairingGrantInputSchema, outputSchema: DevicePairingGrantResultSchema,
    annotations: { ...reads, readOnlyHint: false },
    run: (context, input) => context.services.devices!.createPairingGrant(context.principal, input, 'mcp'),
  }),
  defineOperatorTool({
    name: 'device_setup_options_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.devices,
    description: 'Read the explicitly configured public companion WSS endpoint and actual listener start state. Requires global settings:read; no guessed host, private TLS paths or connectivity claim.',
    inputSchema: z.object({}).strict(), outputSchema: DeviceSetupOptionsSchema, annotations: reads,
    run: (context) => context.services.devices!.readSetupOptions(context.principal),
  }),
  defineOperatorTool({
    name: 'device_setup_code_create',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.devices,
    description: 'Approve an exact companion public identity-request code and approved LAN WSS endpoint. Requires global settings:update; returns a private key-bound enrollment code valid for one hour. Pairing issues a 100-year credential subject to revocation and scope checks. Retries retain original approval facts and expiry; this does not prove connectivity.',
    inputSchema: DeviceSetupApproveInputSchema, outputSchema: DeviceSetupApproveResultSchema, annotations: { ...reads, readOnlyHint: false },
    run: (context, input) => context.services.devices!.createSetupCode(context.principal, input, 'mcp'),
  }),
  defineOperatorTool({
    name: 'device_revoke',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.devices,
    description: 'Revision-check and durably revoke device authorization before fencing connections. Requires global settings:update. Retries use commandId. An unreachable process cannot be physically stopped; task leases are separate.',
    inputSchema: DeviceRevokeInputSchema, outputSchema: DeviceRegistrationSchema,
    annotations: { ...reads, readOnlyHint: false, destructiveHint: true },
    run: (context, input) => context.services.devices!.revoke(context.principal, input.deviceId, input.expectedRevision, input.commandId, 'mcp'),
  }),
]
