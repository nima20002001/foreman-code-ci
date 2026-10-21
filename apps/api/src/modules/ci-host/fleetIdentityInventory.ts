import { z } from 'zod'
import { DomainError } from '../errors.js'
import type { HostCiPorts } from './runner.js'

const PeerSchema = z.object({
  HostName: z.string().min(1), TailscaleIPs: z.array(z.string().min(1)).min(1),
})
const InventorySchema = z.object({
  BackendState: z.literal('Running').optional(),
  Self: PeerSchema,
  Peer: z.record(z.string(), PeerSchema).optional(),
  MagicDNSSuffix: z.string().optional(),
  User: z.record(z.string(), z.object({ LoginName: z.string().optional() })).optional(),
})

/** Publication always requires the configured fleet inventory; command diagnostics stay private. */
export async function readFleetIdentityInventory(ports: HostCiPorts) {
  try {
    const result = await ports.run('tailscale', ['status', '--json'], { timeoutMs: 15_000 })
    if (result.code !== 0) throw new Error('Fleet inventory command failed.')
    return InventorySchema.parse(JSON.parse(result.stdout))
  } catch {
    throw new DomainError('CI_FLEET_INVENTORY_UNAVAILABLE',
      'Not published: the fleet identity inventory is unavailable. Restore Tailscale inventory access and retry.', 503)
  }
}
