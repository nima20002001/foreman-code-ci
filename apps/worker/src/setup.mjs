import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { installVersion } from './installation.mjs';
import { requirePrivateDirectory } from './diagnostics.mjs';
import { renderUserService } from './service.mjs';
import { workerPath } from './harnessPath.mjs';

async function publish(path, content, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}`;
  try { await writeFile(temporary, content, { mode, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

// This convenience installs files only. Starting/enabling the user service and
// enabling linger remain explicit actions by the approved OS user.
export async function setupCompanion({ home, node, artifact, approvedManifestSha256, facts, updatePolicy, serviceTemplate }) {
  const root = join(home, '.local/lib/graphql-worker');
  const state = join(home, '.local/state/graphql-worker');
  const path = workerPath(home, node);
  await mkdir(state, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(state);
  return installVersion({
    root,
    stateDirectory: state,
    artifact,
    approvedManifestSha256,
    facts,
    expected: { protocolVersion: 1, identityFormat: 1 },
    updatePolicy,
    publishInstallation: publishLaunchers,
  });

  async function publishLaunchers(result) {
    const release = join(root, 'versions', `${result.version}-${result.manifestSha256}`);
    const unit = renderUserService(serviceTemplate, {
      node, app: root, state, home, path,
    });
    const appMcpLauncher = join(home, '.local/share/graphql/mcp/launcher.mjs');
    await mkdir(dirname(appMcpLauncher), { recursive: true, mode: 0o700 });
    await requirePrivateDirectory(dirname(appMcpLauncher));
    const bridge = await readFile(join(release, 'artifacts/graphql-mcp.mjs'), 'utf8');
    await publish(appMcpLauncher, bridge, 0o600);
    const launcher = join(root, 'graphql-companion');
    await publish(launcher, `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH NODE_TLS_REJECT_UNAUTHORIZED\nexport HOME='${home}'\nexport PATH='${path}'\nexec '${node}' '${root}/current/src/companion.mjs' --state '${state}' "$@"\n`, 0o700);
    const desktop = join(home, '.local/share/applications/graphql-companion.desktop');
    const icon = join(home, '.local/share/icons/hicolor/scalable/apps/graphql-companion.svg');
    await publish(icon, await readFile(join(release, 'artifacts/graphql.svg')), 0o644);
    await publish(desktop, `[Desktop Entry]\nType=Application\nName=Foreman Code Companion\nComment=Computer connection and diagnostics\nExec=${launcher} --desktop\nIcon=${icon}\nTerminal=false\nCategories=Utility;\n`, 0o600);
    const proposedService = join(root, 'graphql-worker.service');
    try {
      const previousService = await readFile(proposedService);
      if (!previousService.equals(Buffer.from(unit))) {
        await publish(`${proposedService}.previous`, previousService, 0o600);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await publish(proposedService, unit, 0o600);
    Object.assign(result, { root, state, launcher, appMcpLauncher, desktop, proposedService,
      serviceActivation: 'not-requested' });
  }
}
