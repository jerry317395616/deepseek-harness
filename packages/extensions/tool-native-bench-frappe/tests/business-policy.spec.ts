/** Configuration and direct-call denials for the Native Bench business reader. */

import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { NativeFrappeClient, resolveNativeFrappeSpec } from '../src/native.ts'

const business = {
  accessMode: 'business' as const,
  frappeUser: 'teacher@example.test',
  actorTokenFile: '/private/teacher.assertion',
  businessDoctypes: ['Student'],
}

describe('Native Bench business policy', () => {
  it('requires explicit identity, private assertion path, and bounded DocType scope', () => {
    expect(() => resolveNativeFrappeSpec({ ...business, accessMode: 'invalid' })).toThrow('accessMode must')
    expect(() => resolveNativeFrappeSpec({ ...business, frappeUser: '' })).toThrow('explicit expected')
    expect(() => resolveNativeFrappeSpec({ ...business, frappeUser: 'Guest' })).toThrow('explicit expected')
    expect(() => resolveNativeFrappeSpec({ ...business, actorTokenFile: '' })).toThrow('absolute private')
    expect(() => resolveNativeFrappeSpec({ ...business, actorTokenFile: 'relative' })).toThrow('absolute private')
    expect(() => resolveNativeFrappeSpec({ ...business, businessDoctypes: [] })).toThrow('explicit DocTypes')
    expect(() => resolveNativeFrappeSpec({ ...business, businessDoctypes: [' Student'] })).toThrow('explicit DocTypes')
    expect(() => resolveNativeFrappeSpec({ ...business, accessMode: 'maintenance' })).toThrow('require business')
    expect(resolveNativeFrappeSpec({ ...business, businessDoctypes: ['Student', 'Student'] }).businessDoctypes)
      .toEqual(['Student'])
  })

  it('does not let schema defaults grant Administrator in business mode', () => {
    const { frappeUser: _expectedUser, ...withoutUser } = business
    const parsed = Config({ ...withoutUser, timeoutMs: 5000 })
    expect(() => resolveNativeFrappeSpec(parsed)).toThrow('explicit expected')
    expect(resolveNativeFrappeSpec(Config({ timeoutMs: 5000 })).frappeUser).toBe('Administrator')
  })

  it('denies write, discovery, and out-of-scope calls in the executor without a tool registry', async () => {
    // An unusable Context proves rejected requests cannot reach the process provider.
    const client = new NativeFrappeClient({} as Context, resolveNativeFrappeSpec(business))
    const signal = new AbortController().signal
    for (const operation of ['frappe_platform_catalog', 'frappe_preview_document_update', 'frappe_apply_document_update']) {
      await expect(client.call(operation, { doctype: 'Student' }, signal)).rejects.toThrow('only permits scoped reads')
    }
    await expect(client.call('frappe_get_document', { doctype: 'User', name: 'Administrator' }, signal))
      .rejects.toThrow('outside the configured business scope')
  })
})
