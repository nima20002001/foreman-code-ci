import { expect, it, vi } from 'vitest'
import { NativeConfigurationService } from '../src/modules/harnesses/nativeConfiguration.js'

it('does not offer an upstream cache update for Codex', async () => {
  const service = new NativeConfigurationService('unused', '/unused-workspace')
  const options = vi.spyOn(service, 'options')
  await expect(service.refreshOptions('codex', 'upstream'))
    .rejects.toMatchObject({ code: 'CODEX_MODEL_REFRESH_UNSUPPORTED' })
  expect(options).not.toHaveBeenCalled()
})
