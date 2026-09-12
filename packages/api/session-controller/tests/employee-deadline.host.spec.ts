import { expect, it } from 'vitest'
import { employeeRequestDeadline } from '../src/employee-access.ts'
it('separates multi-step prompt lifetime from tool and authentication deadlines', () => {
  const config = { timeoutMs: 90000, promptTimeoutMs: 600000 }
  expect(employeeRequestDeadline(config, 'POST', '/employee/session/prompt')).toBe(600000)
  for (const path of ['/employee/status', '/employee/session/read', '/employee/session/prompt?x=1'])
    expect(employeeRequestDeadline(config, 'POST', path)).toBe(90000)
  expect(employeeRequestDeadline(config, 'GET', '/employee/session/prompt')).toBe(90000)
  expect(employeeRequestDeadline({ timeoutMs: 100 }, 'POST', '/employee/session/prompt')).toBe(100)
})
