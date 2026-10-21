import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'

describe('local binary selection', () => {
  it('falls back to bundled Codex when PATH has no native installation', () => {
    const bundled = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
    expect(harnessBinaries({ PATH: '/unrelated' })).toEqual({ codexBinary: bundled,  })
    expect(harnessBinaries({ CODEX_BINARY: 'codex', PATH: '/unrelated' }).codexBinary).toBe('codex')
  })
  it('prefers a computer-local native installation for the default command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-native-selection-'))
    const binary = join(root, 'codex')
    try {
      await writeFile(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 })
      expect(harnessBinaries({ PATH: root }).codexBinary).toBe(binary)
      expect(harnessBinaries({ PATH: root, CODEX_BINARY: 'codex' }).codexBinary).toBe(binary)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('continues past the bundled pnpm launcher to the installed computer binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-path-precedence-'))
    const bundled = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
    const first = join(root, 'bundled-bin')
    const second = join(root, 'installed-bin')
    try {
      await mkdir(first)
      await mkdir(second)
      await symlink(bundled, join(first, 'codex'))
      const installed = join(second, 'codex')
      await writeFile(installed, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 })
      expect(harnessBinaries({ PATH: [first, second].join(delimiter) }).codexBinary).toBe(installed)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('keeps explicit overrides authoritative and rejects empty selections', () => {
    expect(harnessBinaries({ CODEX_BINARY: '/a path/codex',  })).toEqual({ codexBinary: '/a path/codex',  })
    expect(() => harnessBinaries({ CODEX_BINARY: ' ' })).toThrow('empty')
  })
})
