/* global process, URL */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { it, onTestFinished } from 'vitest';

it('remote Codex fixture exposes its managed connection in the native user configuration layer', async () => {
  const storage = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(storage, { recursive: true });
  const directory = await mkdtemp(join(storage, 'remote-codex-config-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'codex'), 'fixture executable');
  const launcher = join(directory, 'graphql-mcp.mjs');
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ launcher }));
  const result = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath,
      [new URL('./remote-review-codex.mjs', import.meta.url).pathname, directory, 'app-server'],
      { env: { ...process.env, CODEX_HOME: directory }, timeout: 5000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(JSON.parse(stdout));
      });
    child.stdin.end(`${JSON.stringify({ id: 1, method: 'config/read', params: { includeLayers: true } })}\n`);
  });
  assert.equal(result.id, 1);
  const layer = result.result.layers.find(layer => layer.name.type === 'user');
  assert.ok(layer, 'Managed setup requires the native user layer');
  assert.equal(layer.name.file, join(directory, 'config.toml'));
  assert.equal(typeof layer.version, 'string');
  assert.deepEqual(layer.config.mcp_servers, result.result.config.mcp_servers);
  assert.equal(layer.config.mcp_servers['foreman-code'].command, process.execPath);
  assert.deepEqual(layer.config.mcp_servers['foreman-code'].args, [launcher]);
  assert.equal(result.result.config.approval_policy, 'never');
});
