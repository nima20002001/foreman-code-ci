import { it } from 'vitest'
import { runNativeConfigFault } from './helpers/nativeConfigFaults.js'

it('preserves native configuration and reconciles external-after-write through authenticated MCP', async () => {
  await runNativeConfigFault('external-after-write')
}, 240_000)
