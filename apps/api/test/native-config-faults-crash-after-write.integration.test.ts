import { it } from 'vitest'
import { runNativeConfigFault } from './helpers/nativeConfigFaults.js'

it('preserves native configuration and reconciles crash-after-write through authenticated MCP', async () => {
  await runNativeConfigFault('crash-after-write')
}, 240_000)
