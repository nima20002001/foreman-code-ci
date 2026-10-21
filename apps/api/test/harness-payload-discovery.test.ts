import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { passiveDriverPayloads } from '../src/modules/harnesses/payloadDiscovery.js'

it('recognizes direct executable payloads without executing arbitrary launcher scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hrt-payload-'))
  try {
    const image = join(root, 'image')
    const shim = join(root, 'shim')
    await writeFile(image, Buffer.from('7f454c46', 'hex'))
    await writeFile(shim, '#!/bin/sh\nexit 99\n')
    expect(await passiveDriverPayloads('codex', image)).toEqual({ complete: true, paths: [] })
    expect(await passiveDriverPayloads('codex', shim)).toEqual({ complete: false, paths: [] })
  } finally { await rm(root, { recursive: true, force: true }) }
})
