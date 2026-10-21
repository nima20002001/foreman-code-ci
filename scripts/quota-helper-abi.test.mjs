import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaHelperRequirements, validateQuotaHelperRequirements } from './quota-helper-abi.mjs';

const target = { arch: 'x64', libc: 'glibc-2.39' };
const requirements = {
  interpreter: '/lib64/ld-linux-x86-64.so.2', libraries: ['libc.so.6'],
  versions: ['GLIBC_2.2.5', 'GLIBC_2.28', 'GLIBC_2.39'],
};

test('allows older libc requirements on each approved Ubuntu libc', () => {
  const relocated = { ...requirements, versions: [...requirements.versions, 'GLIBC_ABI_DT_RELR'] };
  for (const libc of ['glibc-2.39', 'glibc-2.43']) {
    assert.deepEqual(validateQuotaHelperRequirements(requirements, { ...target, libc }), requirements);
    assert.deepEqual(validateQuotaHelperRequirements(relocated, { ...target, libc }), relocated);
  }
  assert.throws(() => validateQuotaHelperRequirements({ ...requirements,
    versions: ['GLIBC_2.2.5', 'GLIBC_ABI_DT_RELR'] }, { ...target, libc: 'glibc-2.35' }), /exceeding glibc-2.35/);
});

test('refuses host-built symbols newer than the declared target', () => {
  for (const version of ['GLIBC_2.40', 'GLIBC_2.43', 'GLIBC_3.0', 'GLIBC_2.39.1']) {
    assert.throws(() => validateQuotaHelperRequirements({ ...requirements, versions: [version] }, target),
      /exceeding glibc-2.39/);
  }
});

test('refuses unknown ABI tags, loaders and additional shared dependencies', () => {
  for (const change of [
    { versions: ['GLIBC_PRIVATE'] }, { versions: ['GLIBC_UNKNOWN_FEATURE'] }, { versions: [] },
    { interpreter: '/lib/ld-musl-x86_64.so.1' }, { interpreter: undefined },
    { libraries: ['libc.so.6', 'libgcc_s.so.1'] }, { libraries: [] },
  ]) {
    assert.throws(() => validateQuotaHelperRequirements({ ...requirements, ...change }, target));
  }
});

test('reads the ELF architecture and native loader and version metadata', () => {
  const header = Buffer.alloc(64);
  Buffer.from('7f454c460201', 'hex').copy(header);
  header.writeUInt16LE(62, 18);
  const metadata = `
      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]
 0x0000000000000001 (NEEDED) Shared library: [libc.so.6]
  0x0010: Name: GLIBC_2.28  Flags: none  Version: 3
  0x0020: Name: GLIBC_2.2.5  Flags: none  Version: 2
  0x0030: Name: GLIBC_2.28  Flags: none  Version: 3
`;
  assert.deepEqual(quotaHelperRequirements(header, metadata), {
    interpreter: requirements.interpreter, libraries: ['libc.so.6'], versions: ['GLIBC_2.28', 'GLIBC_2.2.5'],
  });
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(64), Buffer.from(header)]) {
    if (invalid.equals(header)) invalid[4] = 1;
    assert.throws(() => quotaHelperRequirements(invalid, metadata), /Linux x64 ELF/);
  }
  header.writeUInt16LE(183, 18);
  assert.throws(() => quotaHelperRequirements(header, metadata), /Linux x64 ELF/);
});
