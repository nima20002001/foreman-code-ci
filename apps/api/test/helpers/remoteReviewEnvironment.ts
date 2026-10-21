import { dirname, join } from 'node:path'

/** Native fixture processes must not discover the user's installed Worker or harness profiles. */
export function remoteReviewEnvironment(
  home: string,
  claudeProfile: string,
  launcher: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...source,
    HOME: home,
    PATH: [join(home, '.local', 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: claudeProfile,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: join(home, '.runtime'),
    FOREMAN_CODE_APP_MCP_DIRECTORY: dirname(launcher),
    LOG_LEVEL: source.LOG_LEVEL ?? 'warn',
  }
  environment.DBUS_SESSION_BUS_ADDRESS = `unix:path=${environment.XDG_RUNTIME_DIR}/bus`
  delete environment.GRAPHQL_APP_MCP_DIRECTORY
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  return environment
}
