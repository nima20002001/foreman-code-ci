import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const help = `Usage: node scripts/ci-runtime-qualification.mjs --config FILE --evidence-dir DIRECTORY

Orchestrator-only physical qualification through the authenticated main API.
Uses an existing persisted captured candidate. Does not approve, install, pull an
image, change settings, invoke a model or directly spawn a runtime.

Config (outside source/build mounts): schemaVersion:1 (build) or 2 (verification), apiBaseUrl, workspaceId,
approvalId, commandId (retain on retry), authorizationEnvironmentVariable,
humanGates:{hostReady:true,runtimeInstallation:true,image:true,rootAndQuota:true}.
The selected host/root/runtime/image fingerprint is read from the saved candidate.
Verification readback must include the separate version 2 measurement, all
requested suites, their cold-cache byte/inode peaks and measured concurrency.
This tool does not convert build qualification into verification qualification.
Evidence contains authoritative readback and excludes authorization headers.
`

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(help); return }
  if (argv.length !== 4 || argv[0] !== '--config' || argv[2] !== '--evidence-dir') throw new Error(help)
  const configBytes = await readFile(resolve(argv[1]))
  if (configBytes.length > 16384) throw new Error('Qualification config exceeds its byte bound.')
  const config = JSON.parse(configBytes.toString('utf8'))
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  if (![1, 2].includes(config.schemaVersion) || !uuid.test(config.approvalId) || !uuid.test(config.commandId) ||
    typeof config.workspaceId !== 'string' || !config.workspaceId || !/^[A-Z][A-Z0-9_]{0,63}$/.test(config.authorizationEnvironmentVariable ?? '') ||
    ['hostReady', 'runtimeInstallation', 'image', 'rootAndQuota'].some(key => config.humanGates?.[key] !== true)) throw new Error('Exact IDs, authorization reference and every explicit human gate are required.')
  const base = new URL(config.apiBaseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid approved main API URL.')
  const token = process.env[config.authorizationEnvironmentVariable]
  if (!token) throw new Error('Approved authorization environment variable is unavailable.')
  const path = `/api/management/workspaces/${encodeURIComponent(config.workspaceId)}/jobs/runtime-qualifications/${encodeURIComponent(config.approvalId)}`
  const request = async (suffix, method = 'GET', body) => {
    const response = await fetch(new URL(path + suffix, base), { method, redirect: 'error', signal: AbortSignal.timeout(300000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(`Qualification API returned HTTP ${response.status}; reconcile the original command before retrying.`)
    const chunks = []; let size = 0
    for await (const part of response.body) {
      size += part.byteLength
      if (size > 1048576) throw new Error('Qualification response exceeds its byte bound.')
      chunks.push(Buffer.from(part))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  const before = await request('')
  const candidate = before.approval
  const pendingEntry = ['captured','awaiting-approval','approved'].includes(candidate?.status)
  if (candidate?.id !== config.approvalId
    || !['captured','awaiting-approval','approved','qualifying','recovery-required','failed','complete'].includes(candidate.status)
    || !Number.isFinite(Date.parse(candidate.expiresAt))
    || pendingEntry && Date.parse(candidate.expiresAt) <= Date.now()) {
    throw new Error('A persisted captured candidate or original recoverable operation is required.')
  }
  const evidenceDir = resolve(argv[3])
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  const evidencePath = resolve(evidenceDir, `qualification-${config.approvalId}-${config.commandId}.json`)
  const evidence = { schemaVersion: 1, invocationId: randomUUID(), commandId: config.commandId, qualificationId: before.approval.qualificationId,
    approvalId: config.approvalId, startedAt: new Date().toISOString(), before, after: null, outcome: 'pending' }
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  try {
    if (before.approval.status !== 'complete') await request('/run', 'POST', { commandId: config.commandId })
    const after = await request('')
    if (after.approval?.qualificationId !== before.approval.qualificationId
      || after.approval?.fingerprintDigest !== before.approval.fingerprintDigest
      || after.measurement?.origin !== 'real-runtime' || after.readiness?.ready !== true) {
      throw new Error('Original physical qualification is incomplete or its fingerprint changed; read and reconcile the same approval.')
    }
    if (config.schemaVersion === 2) {
      const { JobVerificationProfileSchema, JobVerificationRuntimeMeasurementSchema } =
        await import('../packages/contracts/dist/jobVerificationRuntime.js');
      const measurement = JobVerificationRuntimeMeasurementSchema.parse(after.measurement);
      const profile = JobVerificationProfileSchema.parse(after.profile);
      if (measurement.identity.qualificationId !== before.approval.qualificationId
        || measurement.identity.fingerprintDigest !== before.approval.fingerprintDigest
        || measurement.identity.approvalId !== config.approvalId || profile.status !== 'qualified'
        || JSON.stringify(profile.measurement) !== JSON.stringify(measurement)) {
        throw new Error('The persisted verification profile does not retain this separate physical measurement.');
      }
      evidence.resources = measurement.suites.map(suite => ({ suite: suite.suite,
        coldCachePeakBytes: suite.coldCachePeakBytes, coldCachePeakInodes: suite.coldCachePeakInodes,
        resources: suite.resources, maxConcurrentHeavyJobs: suite.maxConcurrentHeavyJobs,
        maxUnitWorkers: suite.maxUnitWorkers, maxIntegrationShards: suite.maxIntegrationShards }));
    } else if (after.measurement?.schemaVersion !== 1
      || after.measurement.qualificationId !== before.approval.qualificationId) {
      throw new Error('Original build measurement missing; verification cannot replace historical build evidence.');
    }
    evidence.after = after; evidence.outcome = 'qualified'
    process.stdout.write(`Qualification evidence: ${evidencePath}\n`)
  } catch (error) { evidence.outcome = 'reconciliation_required'; throw error }
  finally { await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }) }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Qualification command failed.'}\n`); process.exitCode = 1 })
