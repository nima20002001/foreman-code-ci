import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { processIdentity } from '../../src/modules/harnesses/recovery/linuxIdentity.js'
import { hungQualificationDiagnostic, jobQualificationFaultFixture } from '../helpers/jobQualificationFaultFixture.js'

const f = await jobQualificationFaultFixture()
const claim = await f.claimQuota()
const marker = join(f.directory, 'crashed-diagnostic')
const argv = ['-e', hungQualificationDiagnostic, marker]
const native = f.reserved.native
const launchId = await native.reserveProcess(process.execPath, argv)
const child = native.spawnProcess(launchId, process.execPath, argv, {
  shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: f.input.candidate.controllerEnvironment,
})
child.stdout!.resume()
child.stderr!.resume()
const identities = []
for (const path of [marker, `${marker}.descendant`]) {
  let identity
  const deadline = Date.now() + 10_000
  while (!identity && Date.now() < deadline) {
    try { identity = processIdentity(Number(await readFile(path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!identity) await delay(25)
  }
  if (!identity) throw new Error('Qualification fault process did not start.')
  identities.push(identity)
}
process.send!({ directory: f.directory, journalPath: f.journalPath, registryPath: f.registryPath,
  owner: f.owner, admission: f.input.admission, identities, claim })
