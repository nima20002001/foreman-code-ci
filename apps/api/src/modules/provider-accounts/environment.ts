import type { AccountProvider } from '@foreman-code/contracts/provider-accounts'

export function providerAccountEnvironment(
  provider: AccountProvider, homePath: string, userHome: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...inherited }
  if (provider === 'codex') {
    environment.HOME = userHome
    environment.XDG_CONFIG_HOME = `${userHome}/.config`
  }
  for (const name of Object.keys(environment)) {
    if (/^(?:OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|AZURE_|VERTEX_|BEDROCK_)/.test(name)) {
      delete environment[name]
    }
  }
  if (provider === 'codex') environment.CODEX_HOME = homePath
  else environment.CLAUDE_CONFIG_DIR = homePath
  return environment
}
