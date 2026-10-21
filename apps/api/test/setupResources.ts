import { ownedTestDatabaseUrl } from './helpers/testResources.js'
import { installTestConnectionGuard } from '../../../scripts/test-postgres-guard.mjs'
import { recordIntegrationStartup } from '../../../scripts/integration-startup.mjs'

ownedTestDatabaseUrl()
installTestConnectionGuard()
recordIntegrationStartup('worker-setup')
// Production retries wait 10 s, 30 s, then 60 s; tests keep the attempt order without the wait.
process.env.FOREMAN_EXECUTION_RETRY_BACKOFF_MS ??= '20'
