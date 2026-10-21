const userAgent = process.env.npm_config_user_agent ?? ''

if (!userAgent.startsWith('pnpm/')) {
  process.stderr.write(
    'This workspace requires Corepack pnpm so the 48-hour dependency-age policy cannot be bypassed.\n'
      + 'Run: corepack pnpm install\n',
  )
  process.exit(1)
}
