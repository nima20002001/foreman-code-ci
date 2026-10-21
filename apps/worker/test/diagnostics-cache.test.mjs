import assert from 'node:assert/strict';
import test from 'node:test';

test('host facts cache libc for the process while still observing storage paths on each call', async (t) => {
  const report = t.mock.method(process.report, 'getReport', () => ({ header: { glibcVersionRuntime: '2.40' } }));
  const { hostFacts } = await import('../src/diagnostics.mjs');
  const first = await hostFacts(process.cwd(), [process.cwd()]);
  const second = await hostFacts('/dev/null/storage-fixture', ['/dev/null/storage-fixture']);
  assert.equal(first.libc, 'glibc-2.40');
  assert.equal(second.libc, first.libc);
  assert.equal(second.homePersistent, false);
  assert.equal(second.storagePersistent, false);
  assert.equal(report.mock.callCount(), 1);
});
