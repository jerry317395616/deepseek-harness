/** Exercise metadata denial in the ordinary CI lane without a Frappe site. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('rejects direct and indirect DocType changes in the Python adapter', () => {
  const directory = fileURLToPath(new URL('.', import.meta.url))
  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([key]) => !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(key),
  ))
  const result = spawnSync('python3', [
    '-B', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_schema_freeze.py',
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 128_000, env })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
}, 15_000)
