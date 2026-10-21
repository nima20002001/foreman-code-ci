import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const generator = fileURLToPath(new URL('./verification-volume-unit.sh', import.meta.url));

test('verification volumes release deleted backing blocks through discard while retaining quotas', () => {
  const unit = execFileSync('/bin/sh', [generator, '/storage/verification.ext4', '/storage/volume'],
    { encoding: 'utf8', timeout: 5000 });
  const options = /^Options=(.+)$/m.exec(unit)?.[1].split(',');
  for (const option of ['loop', 'nosuid', 'nodev', 'prjquota', 'discard']) {
    assert.ok(options?.includes(option), `Missing mount option ${option}`);
  }
  assert.match(unit, /^What=\/storage\/verification.ext4$/m);
  assert.match(unit, /^Where=\/storage\/volume$/m);
});
