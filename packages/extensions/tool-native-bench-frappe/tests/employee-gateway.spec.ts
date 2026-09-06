/** Run the POSIX gateway's credential-free HTTP and identity regressions in CI. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('isolates employee SSO routes and rejects replay through real HTTP', () => {
  const directory = fileURLToPath(new URL('.', import.meta.url))
  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([key]) => !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key),
  ))
  const result = spawnSync('python3', [
    '-B', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_employee_gateway.py',
  ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 256_000, env })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
}, 25_000)
