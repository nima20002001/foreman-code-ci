import { WorkerError } from './diagnostics.mjs';

export function renderUserService(template, { node, app, state, home, path, entrypoint = `${app}/current/src/cli.mjs` }) {
  const values = { NODE: node, APP: app, CLI: entrypoint, STATE: state, HOME: home, PATH: path };
  for (const [key, value] of Object.entries(values)) {
    // Refuse systemd specifiers, shell expansions and whitespace instead of constructing
    // an ambiguous service command. The approved directories must be absolute.
    if (typeof value !== 'string' || !value.startsWith('/') || !/^[/a-zA-Z0-9_.:-]+$/.test(value)) throw new WorkerError('service_path_invalid');
    if (key === 'PATH' && value.split(':').some((entry) => !entry.startsWith('/'))) throw new WorkerError('service_path_invalid');
  }
  return template.replace(/@(NODE|APP|CLI|STATE|HOME|PATH)@/g, (_, key) => values[key]);
}
