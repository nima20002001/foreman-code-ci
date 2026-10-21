#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: Object.fromEntries([
  'pc-device-id','laptop-device-id','pc-root-binding','laptop-root-binding','main-endpoint',
  'fixture-manifest','credential-handle','evidence-out','fault',
].map(name => [name, { type: 'string' }])) })
const required = ['pc-device-id','laptop-device-id','pc-root-binding','laptop-root-binding','main-endpoint',
  'fixture-manifest','credential-handle','evidence-out']
for (const name of required) if (!values[name]) throw new Error(`Missing --${name}`)
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
for (const name of ['pc-device-id','laptop-device-id','pc-root-binding','laptop-root-binding']) {
  if (!uuid.test(values[name])) throw new Error(`Explicit UUID required for --${name}`)
}
const main = new URL(values['main-endpoint'])
if (!['http:','https:'].includes(main.protocol) || main.username || main.password || main.search || main.hash) throw new Error('Explicit main origin without embedded credentials required')
if (!/^[A-Z][A-Z0-9_]*$/.test(values['credential-handle'])) throw new Error('Credential handle must name an environment variable')
const credential = process.env[values['credential-handle']]
if (!credential || /[\r\n]/.test(credential)) throw new Error('Credential handle is unavailable')
if (values['pc-device-id'] === values['laptop-device-id'] || values['pc-root-binding'] === values['laptop-root-binding']) throw new Error('Independent devices and approved root bindings required')
const input = await readFile(values['fixture-manifest'], 'utf8')
const manifest = JSON.parse(input)
const fault = values.fault ?? 'none'
const phases = ['identity','source-materialization','producer-publication','edge-consumption','consumer-publication',
  'restart-readback','fault-recovery','expiry-denial','read-only-denial','scope-denial','write-conflict','disk-full','traversal-denial','bounded-overhead']
if (manifest.version !== 1 || !Array.isArray(manifest.operations) || manifest.operations.length > 256) throw new Error('Bounded version 1 fixture manifest required')
const operations = manifest.operations.filter(op => op.fault === undefined || op.fault === fault)
const completed = new Set()
const report = { version: 1, status: 'incomplete', fault,
  devices: { pc: values['pc-device-id'], laptop: values['laptop-device-id'] },
  roots: { pc: values['pc-root-binding'], laptop: values['laptop-root-binding'] },
  fixtureSha256: createHash('sha256').update(input).digest('hex'), steps: [], unmet: phases }
const dangerous = /token|password|secret|credential|authorization|privatekey|controlkey/i
const pointer = (value, path) => path === '' ? value : path.split('/').slice(1).reduce((v, key) => v?.[key.replaceAll('~1','/').replaceAll('~0','~')], value)
const safeEvidence = value => {
  if (typeof value === 'string') {
    if (value.includes(credential) || value.length > 500 || /gql_(?:file|operator|worker)_|sk-(?:proj-)?/.test(value)) throw new Error('Unsafe evidence string')
    return value
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  throw new Error('Evidence must select scalar pins/counts/status, never whole response or logs')
}
try {
  for (const op of operations) {
    if (!phases.includes(op.phase) || typeof op.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(op.id)
      || typeof op.path !== 'string' || !op.path.startsWith('/') || op.path.startsWith('//')
      || !['GET','POST'].includes(op.method) || !Array.isArray(op.assertions) || !op.assertions.length) throw new Error('Invalid production fixture operation')
    const endpoint = new URL(op.path, main)
    if (endpoint.origin !== main.origin) throw new Error('Fixture operation escaped selected main')
    const body = op.body === undefined ? undefined : JSON.stringify(op.body)
    if (body && Buffer.byteLength(body) > 1024 * 1024) throw new Error('Fixture request exceeds bounded budget')
    const response = await fetch(endpoint, { method: op.method, redirect: 'error', headers: {
      authorization: `Bearer ${credential}`, accept: 'application/json, text/event-stream',
      ...(body ? { 'content-type': 'application/json' } : {}),
    }, ...(body ? { body } : {}), signal: AbortSignal.timeout(120_000) })
    // Stream with a hard cap rather than buffering an unbounded debug/log response.
    const chunks = []; let size = 0
    if (!response.body) throw new Error('Missing production response')
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > 1024 * 1024) throw new Error('Production response exceeds evidence budget')
      chunks.push(Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks, size).toString('utf8')
    const line = raw.split('\n').find(v => v.startsWith('data: '))
    const data = JSON.parse(line ? line.slice(6) : raw)
    if (response.status !== op.expectedStatus) throw new Error(`Unexpected response status for ${op.id}`)
    for (const assertion of op.assertions) {
      if (typeof assertion.pointer !== 'string') throw new Error('Explicit response pointer required')
      const actual = pointer(data, assertion.pointer)
      if (JSON.stringify(actual) !== JSON.stringify(assertion.equals)) throw new Error(`Pin/count assertion failed for ${op.id}`)
    }
    const evidence = {}
    for (const [label, path] of Object.entries(op.evidence ?? {})) {
      if (dangerous.test(label) || dangerous.test(path) || typeof path !== 'string') throw new Error('Sensitive evidence selection denied')
      evidence[label] = safeEvidence(pointer(data, path))
    }
    report.steps.push({ id: op.id, phase: op.phase, httpStatus: response.status, evidence })
    completed.add(op.phase)
  }
  report.unmet = phases.filter(phase => !completed.has(phase))
  report.status = report.unmet.length ? 'incomplete' : 'passed'
} catch (error) {
  report.status = 'failed'
  // Never serialize network errors, response bodies or credentials.
  report.error = error instanceof Error && /^(Unexpected response status|Pin\/count assertion failed|Invalid production fixture|Fixture operation|Fixture request|Production response|Missing production|Explicit response pointer|Sensitive evidence|Unsafe evidence|Evidence must)/.test(error.message)
    ? error.message : 'Fixture operation failed; inspect sanitized server logs separately.'
  process.exitCode = 1
} finally {
  report.unmet = phases.filter(phase => !completed.has(phase))
  await writeFile(values['evidence-out'], `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  if (report.status !== 'passed') process.exitCode = 1
  process.stdout.write(`${report.status}: ${report.steps.length} operations, ${report.unmet.length} unmet phases\n`)
}
