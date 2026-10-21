import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const cases = ['happy-path', 'lost-start-ack', 'worker-restart', 'worker-sleep', 'main-restart',
  'lease-expiry-live-process', 'late-result', 'revocation', 'placement-change']
const fail = (message) => { throw new Error(message) }
const hash = (value) => /^[a-f0-9]{64}$/.test(value ?? '')
const loopback = (url) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(url).hostname)

export function validateManifest(m, name, now = Date.now()) {
  if (!cases.includes(name) || m.formatVersion !== 1 || m.topology !== 'production-two-host') fail('Explicit production two-host manifest and named case required')
  if (!m.mainId || !m.runId || !m.mainEndpoint || !m.diagnosticPath?.startsWith('/api/')) fail('Exact main, Run and main-owned diagnostic route required')
  const hosts = m.hosts
  if (!Array.isArray(hosts) || hosts.length !== 2 || new Set(hosts.map(h => h.machineId)).size !== 2
    || hosts.some(h => !h.machineId || !h.hostname || !h.endpoint || loopback(h.endpoint) || !h.allowedRoot?.startsWith('/'))) fail('Distinct non-loopback registered hosts and approved roots required')
  if (!m.credentialReference || Object.keys(m).some(k => k !== 'credentialReference' && /secret|token|password|credential/i.test(k))) fail('Manifest carries credential-reference names, never secrets')
  const approval = m.approvals?.[name]
  if (!approval || approval.mainId !== m.mainId || approval.runId !== m.runId || !approval.approvedBy
    || !approval.operationIds?.length || approval.hostIds?.length !== 2
    || !hosts.every(h => approval.hostIds.includes(h.machineId))
    || !(Date.parse(approval.from) <= now && now < Date.parse(approval.until))) fail('Specific main, hosts, Run, operations and approval window required')
  // Disruption remains a human-owned step. This collector cannot restart/sleep/
  // revoke hosts or replay uncertain native work through arbitrary commands.
  if (name !== 'happy-path' && !approval.faultPerformedAt) fail('Record the separately approved human fault step before collection')
  return approval
}

export function validateEvidence(e, m, name) {
  if (e.synthetic || e.runId !== m.runId || e.mainId !== m.mainId || e.productionBinding !== true
    || !e.commit || !hash(e.lockfileDigest) || !e.runtimeVersion || !e.protocolVersion
    || !hash(e.acceptedSnapshotHash) || e.acceptedSnapshotHash !== e.finalSnapshotHash) fail('Missing immutable production Run/version readback')
  if (!Array.isArray(e.nodes) || e.nodes.length !== 2) fail('Actual A and B native evidence required')
  const [a, b] = e.nodes
  for (const [i, n] of e.nodes.entries()) {
    const h = m.hosts[i]
    if (n.machineId !== h.machineId || n.hostname !== h.hostname || !n.bootId || !n.workerIncarnationId
      || !hash(n.bindingHash) || n.bindingHash !== n.finalBindingHash || !n.operationId || !n.attemptId || !n.ownerGrantId || !n.ownerEpoch
      || !m.approvals[name].operationIds.includes(n.operationId)
      || (n.cwd !== h.allowedRoot && !n.cwd?.startsWith(`${h.allowedRoot}/`))
      || !Array.isArray(n.ackSequence) || !n.ackSequence.length || n.ackSequence.some((v,j,arr) => !Number.isSafeInteger(v) || v < 1 || (j && v <= arr[j-1]))) fail('Missing or mismatched host/native/operation attribution')
    const nativeObserved = Number.isInteger(n.pid) && n.pid > 0 && Number.isInteger(n.ppid) && n.ppid > 0 && n.processStartedAt && n.sessionId && n.turnId
    if (!nativeObserved && (name === 'happy-path' || e.recovery !== 'recovery_required' || n.nativeEvidence !== 'unavailable'
      || n.recoveryRequired !== true || n.pid || n.sessionId || n.turnId)) fail('Missing native proof requires explicit recovery-required evidence, never fabricated process facts')
  }
  if (a.bootId === b.bootId || !e.freshNonce || !hash(a.outputDigest) || a.outputDigest !== e.edge?.payloadDigest
    || e.edge?.payloadDigest !== b.inputDigest || !e.edge?.revisionId || !e.edge?.artifactRevisionId
    || e.edge?.producerExecutionId !== a.executionId || e.edge?.consumerExecutionId !== b.executionId
    || e.edge?.canonicalReadback !== true || e.database?.uniqueRun !== true || e.database?.uniqueEdgeConsumption !== true || e.finalAuthoritativeReadback !== true) fail('Fresh actual A output, immutable edge and exact B input readback required')
  if (name === 'happy-path' && (!hash(e.result?.digest) || !e.result?.verifiedDerivedDigest || e.result.digest !== e.result.verifiedDerivedDigest || e.outcome !== 'succeeded')) fail('Deterministic B derived result not verified')
  if (name !== 'happy-path' && (!['safely_reconciled_original', 'recovery_required'].includes(e.recovery)
    || e.unauthorizedAlternateExecution !== false || e.unsafeReplay !== false)) fail('Fault case must reconcile original work or report explicit uncertainty without replay')
  return e
}

export async function collect(manifestPath, name, evidenceDir) {
  if (!isAbsolute(manifestPath) || !isAbsolute(evidenceDir)) fail('Manifest and evidence directory must be absolute paths')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  validateManifest(manifest, name)
  const credential = process.env[manifest.credentialReference]
  if (!credential) fail('Main diagnostic credential reference is unavailable')
  const endpoint = new URL(manifest.diagnosticPath, manifest.mainEndpoint)
  if (endpoint.origin !== new URL(manifest.mainEndpoint).origin) fail('Diagnostic route must remain on the selected main')
  endpoint.searchParams.set('runId', manifest.runId); endpoint.searchParams.set('case', name)
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${credential}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) fail(`Main diagnostic read failed: HTTP ${response.status}`)
  const evidence = validateEvidence(await response.json(), manifest, name)
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  // The diagnostic contract is a redacted allowlist; never persist raw provider
  // logs, environment, authorization headers, prompts or private artifact bytes.
  const safe = { runId: evidence.runId, mainId: evidence.mainId, productionBinding: evidence.productionBinding,
    commit: evidence.commit, lockfileDigest: evidence.lockfileDigest, runtimeVersion: evidence.runtimeVersion, protocolVersion: evidence.protocolVersion,
    acceptedSnapshotHash: evidence.acceptedSnapshotHash, finalSnapshotHash: evidence.finalSnapshotHash, freshNonce: evidence.freshNonce,
    nodes: evidence.nodes.map(n => Object.fromEntries(['executionId','machineId','hostname','bootId','workerIncarnationId','bindingHash','finalBindingHash',
      'operationId','attemptId','ownerGrantId','ownerEpoch','nativeEvidence','recoveryRequired','pid','ppid','processStartedAt','cwd','sessionId','turnId','ackSequence','outputDigest','inputDigest'].map(k => [k,n[k]]))),
    edge: Object.fromEntries(['payloadDigest','revisionId','artifactRevisionId','producerExecutionId','consumerExecutionId','canonicalReadback'].map(k => [k,evidence.edge[k]])),
    database: { uniqueRun: evidence.database.uniqueRun, uniqueEdgeConsumption: evidence.database.uniqueEdgeConsumption },
    finalAuthoritativeReadback: evidence.finalAuthoritativeReadback, outcome: evidence.outcome,
    result: evidence.result ? { digest: evidence.result.digest, verifiedDerivedDigest: evidence.result.verifiedDerivedDigest } : undefined,
    recovery: evidence.recovery, unauthorizedAlternateExecution: evidence.unauthorizedAlternateExecution, unsafeReplay: evidence.unsafeReplay }
  const report = { case: name, collectedAt: new Date().toISOString(), manifestDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), evidence: safe }
  await writeFile(`${evidenceDir}/${name}.json`, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
  return `${evidenceDir}/${name}.json`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = new Map()
  for (let i = 0; i < args.length; i += 2) {
    if (!['--manifest', '--case', '--evidence-dir'].includes(args[i]) || !args[i + 1] || options.has(args[i])) fail('Use --manifest PATH --case NAME --evidence-dir PATH')
    options.set(args[i], args[i + 1])
  }
  collect(options.get('--manifest') ?? '', options.get('--case'), options.get('--evidence-dir') ?? '')
    .then(path => process.stdout.write(`${path}\n`)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
