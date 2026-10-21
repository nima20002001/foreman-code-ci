import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectChromiumNotices, copyNativeLicenses } from '../../../scripts/browser-runtime-install.mjs';

test('bundled native module notices come from the package owning a nested module boundary', async t => {
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, 'browser-notices-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageRoot = join(directory, 'node_modules/example-package');
  await mkdir(join(packageRoot, 'lib'), { recursive: true });
  const manifest = { name: 'example-package', version: '1.2.3', license: 'MIT' };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(packageRoot, 'LICENSE'), 'Complete upstream notice retained verbatim.');
  await writeFile(join(packageRoot, 'lib/package.json'), JSON.stringify({ type: 'module' }));
  const unit = join(directory, 'unit');
  await copyNativeLicenses(['node_modules/example-package/lib/index.js'], directory, unit);
  const notices = join(unit, 'licenses/native-packages/example-package-1.2.3');
  assert.equal(await readFile(join(notices, 'LICENSE'), 'utf8'), 'Complete upstream notice retained verbatim.');
  assert.deepEqual(JSON.parse(await readFile(join(notices, 'package.json'), 'utf8')), manifest);
});

test('collects the internal Chromium credits page through the supported headless interface', async t => {
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, 'browser-credits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const html = `<html><body>${'Copyright and license terms retained.\n'.repeat(80)}</body></html>`;
  // Chrome 123+ requires explicit chrome:// access for headless DOM collection.
  const browser = async (_file, args) => ({ stdout: args.includes('--allow-chrome-scheme-url')
    && args.at(-1) === 'chrome://credits/' ? html : '<html><body></body></html>' });
  await collectChromiumNotices('chromium', directory, directory, browser);
  assert.equal(await readFile(join(directory, 'licenses/chromium-credits.html'), 'utf8'), html);
});
