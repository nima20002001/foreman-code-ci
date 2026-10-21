import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createCompanionServer } from '../src/companionServer.mjs';

async function pageFixture(t, outcome) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-page-'));
  const manifestFile = join(directory, 'manifest.json');
  const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' };
  await writeFile(manifestFile, JSON.stringify({ target }));
  let enabled = false;
  const gui = await createCompanionServer({
    stateDirectory: directory,
    manifestFile,
    installationRoot: join(directory, 'app'),
    runCli: async () => {
      if (enabled && outcome === 'unavailable') throw new Error('fixture status unavailable');
      return JSON.stringify({ versions: target, pairing: 'paired', connection: 'offline',
        service: { active: enabled && outcome === 'active', userManagerAvailable: true } });
    },
    serviceController: {
      plan: async () => ({ planSha256: 'a'.repeat(64), unitText: 'reviewed unit' }),
      enable: async () => { enabled = true; return { enabled: true }; },
    },
  });
  t.after(() => { gui.close(); return rm(directory, { recursive: true, force: true }); });
  const html = await (await fetch(gui.origin)).text();
  const elements = new Map();
  const ready = Promise.withResolvers();
  function getElementById(id) {
    if (!elements.has(id)) {
      const element = {
        dataset: {},
        style: {},
        events: {},
        addEventListener(name, callback) { this.events[name] = callback; },
        replaceChildren() {},
        append() {},
        toggleAttribute() {},
        setAttribute() {},
        click() { if (!this.disabled) return this.events.click(); },
      };
      if (id === 'state') {
        Object.defineProperty(element, 'textContent', { set(value) { ready.resolve(value); } });
      }
      elements.set(id, element);
    }
    return elements.get(id);
  }
  const location = new URL(gui.url);
  runInNewContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1], {
    URLSearchParams,
    location,
    history: { replaceState(_state, _title, path) { location.href = new URL(path, location).href; } },
    document: { getElementById, createElement: () => ({ style: {} }) },
    fetch: (path, options) => fetch(new URL(path, gui.origin), {
      ...options, headers: { ...options.headers, origin: gui.origin },
    }),
  });
  await ready.promise;
  return { elements };
}

for (const outcome of ['inactive', 'unavailable', 'active']) {
  test(`service feedback reflects ${outcome} status after the enable command`, { timeout: 5000 }, async (t) => {
    const { elements } = await pageFixture(t, outcome);
    await elements.get('plan').click();
    await elements.get('enable').click();
    const message = elements.get('m4');
    if (outcome === 'active') {
      assert.equal(message.dataset.tone, 'ok');
      assert.match(message.textContent, /background service is running/);
      assert.equal(elements.get('retry4').hidden, true);
    } else {
      assert.equal(message.dataset.tone, 'bad');
      assert.doesNotMatch(message.textContent, /installed and started|service is running/);
      assert.equal(elements.get('retry4').hidden, false);
      assert.equal(elements.get('retry4').disabled, false);
      await elements.get('retry4').click();
      assert.equal(elements.get('planBox').hidden, false);
    }
  });
}
