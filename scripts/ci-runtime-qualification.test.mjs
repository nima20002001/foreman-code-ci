import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

async function fixture(status,expiresAt = '2099-01-01T00:00:00Z') {
  const directory = await mkdtemp(join(tmpdir(),'qualification-script-'))
  const approvalId = randomUUID()
  const commandId = randomUUID()
  const qualificationId = randomUUID()
  const fingerprintDigest = 'a'.repeat(64)
  const calls = []
  let completed = status === 'complete'
  const server = createServer(async (request,response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    calls.push({ method:request.method,path:request.url,authorization:request.headers.authorization,
      body:chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null })
    if (request.method === 'POST') completed = true
    const approval = { id:approvalId,qualificationId,fingerprintDigest,status:completed ? 'complete' : status,expiresAt }
    response.writeHead(200,{ 'Content-Type':'application/json' })
    response.end(JSON.stringify({ approval,readiness:{ ready:completed && Date.parse(expiresAt) > Date.now() },
      measurement:completed ? { schemaVersion:1,origin:'real-runtime',qualificationId } : null }))
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const configPath = join(directory,'config.json')
  const evidenceDirectory = join(directory,'evidence')
  await writeFile(configPath,JSON.stringify({ schemaVersion:1,apiBaseUrl:`http://127.0.0.1:${server.address().port}`,
    workspaceId:'workspace',approvalId,commandId,authorizationEnvironmentVariable:'CI_QUALIFICATION_TEST_AUTH',
    humanGates:{ hostReady:true,runtimeInstallation:true,image:true,rootAndQuota:true } }))
  return { calls,commandId,approvalId,qualificationId,evidenceDirectory,
    run:() => promisify(execFile)(process.execPath,['scripts/ci-runtime-qualification.mjs','--config',configPath,
      '--evidence-dir',evidenceDirectory],{ env:{ ...process.env,CI_QUALIFICATION_TEST_AUTH:'fixture-token' } }),
    async readEvidence() {
      return JSON.parse(await readFile(join(evidenceDirectory,`qualification-${approvalId}-${commandId}.json`),'utf8'))
    },
    async close() {
      await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()))
      await rm(directory,{ recursive:true,force:true })
    },
  }
}

for (const status of ['captured','qualifying','recovery-required','failed','complete']) {
  test(`qualifies a ${status} candidate using its original command without approver fields`,async () => {
    const f = await fixture(status)
    try {
      await f.run()
      const evidence = await f.readEvidence()
      assert.equal(evidence.outcome,'qualified')
      assert.equal(evidence.qualificationId,f.qualificationId)
      assert.equal(evidence.commandId,f.commandId)
      assert.equal(evidence.before.approval.approvedAt,undefined)
      assert.equal(evidence.before.approval.approvedByPrincipalId,undefined)
      assert.ok(!JSON.stringify(evidence).includes('fixture-token'))
      const posts = f.calls.filter(call => call.method === 'POST')
      assert.equal(posts.length,status === 'complete' ? 0 : 1)
      if (posts.length) {
        assert.deepEqual(posts[0].body,{ commandId:f.commandId })
        assert.ok(posts[0].path.endsWith(`/${f.approvalId}/run`))
      }
      assert.ok(f.calls.every(call => call.authorization === 'Bearer fixture-token'))
    } finally { await f.close() }
  })
}

test('rejects expired new entry while permitting original recovery readback',async () => {
  for (const status of ['captured','recovery-required']) {
    const f = await fixture(status,'2020-01-01T00:00:00Z')
    try {
      if (status === 'captured') {
        await assert.rejects(f.run(),/persisted captured candidate/)
        assert.equal(f.calls.filter(call => call.method === 'POST').length,0)
      } else {
        await assert.rejects(f.run(),/Original physical qualification is incomplete/)
        assert.equal((await f.readEvidence()).outcome,'reconciliation_required')
        assert.deepEqual(f.calls.find(call => call.method === 'POST').body,{ commandId:f.commandId })
      }
    } finally { await f.close() }
  }
})
