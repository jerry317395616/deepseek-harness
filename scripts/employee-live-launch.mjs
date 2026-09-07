/** Resolve the shipped Web CLI through the same launcher used by process tests. */
import { resolveExampleLaunch } from '../packages/test-support/loader-smoke/lib/index.js'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repo = fileURLToPath(new URL('../', import.meta.url))
const patch = process.argv[2]
if (!patch) throw new Error('private model patch path required')
const launch = resolveExampleLaunch({
  srcBin: join(repo, 'apps/cli/src/bin.ts'), mode: 'lib',
  configArgs: ['--profile', 'web', '--patch',
    join(repo, 'apps/cli/config/examples/employee-readonly/cordis.yml'),
    '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'],
})
process.stdout.write(JSON.stringify(launch))
