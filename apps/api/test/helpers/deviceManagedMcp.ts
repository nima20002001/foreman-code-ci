import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyMcpEdits, fingerprint, mcpEdits, type NativeMcpAdapter, type NativeMcpSnapshot }
  from '../../src/modules/harnesses/nativeMcpCommon.js'

export async function deviceManagedMcpFixture() {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'device-managed-mcp-'))
  let writes = 0
  const adapter = (harness: 'codex' | 'claude'): NativeMcpAdapter => {
    const file = join(directory, `${harness}.json`)
    return {
      async read() {
        let user = { example: { url: 'https://example.test/mcp' } }
        try { user = JSON.parse(await readFile(file, 'utf8')) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        return { harness, file, user, effective: user, userConfig: { setting: 'retained' },
          version: 'fixture', revision: fingerprint(user) } as NativeMcpSnapshot
      },
      async apply(snapshot, change, _signal, managed) {
        writes++
        await writeFile(file, JSON.stringify(applyMcpEdits(snapshot.user, mcpEdits(snapshot, change, managed))))
      },
    }
  }
  return { directory, adapters: { codex: adapter('codex'), claude: adapter('claude') }, writes: () => writes }
}
