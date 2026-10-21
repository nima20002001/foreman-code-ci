import { it } from 'vitest'
import { runNativeConfigFault } from './helpers/nativeConfigFaults.js'

it('preserves native configuration and reconciles crash-during-write through authenticated MCP', async () => {
  await runNativeConfigFault('crash-during-write')
}, 240_000)
