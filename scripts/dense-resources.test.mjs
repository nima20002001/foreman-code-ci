import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createPressureSampler, readProfiles, startProcessMetrics, timeoutScale, writeProfiles } from './dense-resources.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dense-resources-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('profiles round trip atomically and retain absent measurements without inventing values', t => {
  const path = join(fixture(t), 'profiles.json')
  assert.deepEqual(readProfiles(path), {})
  const profiles = { full: { durationMs: 120, peakRssBytes: 4000, cpuSeconds: 0.2 },
    short: { durationMs: 3 } }
  writeProfiles(path, profiles)
  assert.deepEqual(readProfiles(path), profiles)
  assert.throws(() => writeProfiles(path, { invalid: { durationMs: -1 } }), /durationMs/)
  assert.deepEqual(readProfiles(path), profiles)
  writeFileSync(path, '{bad json')
  assert.throws(() => readProfiles(path), /Cannot read test profiles/)
})

test('samples CPU counter differences, PSI and available memory as normalized fractions', t => {
  const procRoot = fixture(t)
  mkdirSync(join(procRoot, 'pressure'))
  writeFileSync(join(procRoot, 'stat'), 'cpu 100 0 100 800 0 0 0 0\ncpu0 1 0 1 8\ncpu1 1 0 1 8\n')
  writeFileSync(join(procRoot, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 300 kB\n')
  writeFileSync(join(procRoot, 'pressure', 'cpu'), 'some avg10=20.00 avg60=10.00 avg300=5.00 total=99\n')
  writeFileSync(join(procRoot, 'pressure', 'memory'),
    'some avg10=2.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=1.00 avg60=0.00 avg300=0.00 total=0\n')
  const sample = createPressureSampler({ procRoot })
  writeFileSync(join(procRoot, 'stat'), 'cpu 150 0 110 840 0 0 0 0\ncpu0 1 0 1 8\ncpu1 1 0 1 8\n')
  const pressure = sample()
  assert.equal(pressure.cpuUtilization, 0.6)
  assert.equal(pressure.cpuPressure, 0.2)
  assert.equal(pressure.memoryPressure, 0.02)
  assert.equal(pressure.memoryUtilization, 0.7)
  assert.equal(pressure.totalMemoryBytes, 1000 * 1024)
  assert.equal(pressure.cpuCount, 2)
  assert.equal(sample().cpuUtilization, 0)
})

function writeProcess(root, { pid, parent, group, ticks, pages }) {
  mkdirSync(join(root, String(pid)), { recursive: true })
  const fields = Array(22).fill('0')
  fields[0] = 'S'
  fields[1] = String(parent)
  fields[2] = String(group)
  fields[11] = String(ticks)
  fields[19] = String(pid * 10)
  fields[21] = String(pages)
  writeFileSync(join(root, String(pid), 'stat'), `${pid} (command with ) parentheses) ${fields.join(' ')}\n`)
}

test('metrics include tree and group descendants, count CPU used while tracked, and retain it after parent exit', t => {
  const procRoot = fixture(t)
  writeProcess(procRoot, { pid: 100, parent: 1, group: 100, ticks: 10, pages: 2 })
  writeProcess(procRoot, { pid: 200, parent: 100, group: 200, ticks: 20, pages: 3 })
  writeProcess(procRoot, { pid: 201, parent: 1, group: 100, ticks: 30, pages: 5 })
  writeProcess(procRoot, { pid: 300, parent: 1, group: 300, ticks: 999, pages: 999 })
  const monitor = startProcessMetrics(100, { procRoot, intervalMs: 10_000,
    clockTicksPerSecond: 100, pageSizeBytes: 4096 })
  t.after(() => monitor.stop())
  assert.deepEqual(monitor.processGroups().sort(), [100, 200])
  rmSync(join(procRoot, '100'), { recursive: true })
  writeProcess(procRoot, { pid: 200, parent: 1, group: 200, ticks: 40, pages: 20 })
  const metrics = monitor.stop()
  // Ticks already used when tracking began (a reused coordinator's earlier files) are not this job's CPU.
  assert.equal(metrics.cpuSeconds, 0.2)
  assert.equal(metrics.peakRssBytes, 25 * 4096)
  assert.ok(metrics.durationMs >= 0)
  assert.equal(monitor.stop(), metrics)
})

test('timeout scaling grows under load and remains bounded', () => {
  assert.equal(timeoutScale({ cpuUtilization: 0.1, memoryUtilization: 0.1 }), 1)
  assert.ok(timeoutScale({ cpuUtilization: 0.95 }) > 1)
  assert.ok(timeoutScale({ memoryPressure: 0.8 }) > 1)
  assert.equal(timeoutScale({ cpuPressure: 50, memoryPressure: 50 }), 3)
})
