import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageToolPath, imageToolVersion } from '../artifacts/ci-runtime/verification-observation.mjs';

test('observes PostgreSQL at the installed image location', () => {
  const path = '/usr/lib/postgresql/17/bin/postgres';
  assert.equal(imageToolPath({ kind: 'postgresql', executable: path }), path);
});

test('keeps other tool kinds and writable or traversing paths outside the observer', () => {
  for (const [kind, executable] of [
    ['codex', '/usr/lib/postgresql/17/bin/postgres'],
    ['postgresql', '/workspace/postgres'],
    ['postgresql', '/job-scratch/postgres'],
    ['postgresql', '/usr/lib/postgresql/17/bin/../postgres'],
    ['codex', '/opt/graphql-ci/tools/../../workspace/codex'],
  ]) assert.throws(() => imageToolPath({ kind, executable }), /Image-owned/);
  assert.equal(imageToolPath({ kind: 'codex', executable: '/opt/graphql-ci/tools/codex' }),
    '/opt/graphql-ci/tools/codex');
});

test('matches the PostgreSQL version captured by the installer', () => {
  assert.equal(imageToolVersion('postgresql', 'postgres (PostgreSQL) 17.6 (Debian 17.6-1.pgdg12+1)'), '17.6');
  assert.equal(imageToolVersion('codex', 'codex-cli 0.144.0'), 'codex-cli 0.144.0');
  assert.throws(() => imageToolVersion('postgresql', 'unknown'), /unsupported version/);
});
