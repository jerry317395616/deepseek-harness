/** Typed Frappe-MCP transport used by the Tongjianyun nutrition-rule tools. */

import { createHmac } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

const ACTOR_TOKEN_PREFIX = 'ione1'
const ACTOR_TOKEN_TTL_SECONDS = 600

/** Fully resolved transport configuration, validated before tools register. */
export interface NutritionMcpSpec {
  endpoint: URL
  credentialRef: CredentialRef
  actorTokenRef?: CredentialRef
  identitySecretRef?: CredentialRef
  identityEmail?: string
  identityUserHint?: string
  identityAudience: string
}

/**
 * Resolve public configuration into request-time-safe transport facts.
 * @param config - deployment-owned endpoint and credential-reference settings.
 * @returns validated endpoint and opaque credential references for one MCP client.
 * @throws when the endpoint is not an absolute HTTP(S) URL.
 */
export function resolveNutritionMcpSpec(config: {
  endpoint: string
  credentialRef: string
  actorTokenRef?: string
  identitySecretRef?: string
  identityEmail?: string
  identityUserHint?: string
  identityAudience?: string
}): NutritionMcpSpec {
  let endpoint: URL
  try {
    endpoint = new URL(config.endpoint)
  } catch {
    throw new Error('tongjianyun-nutrition-rules: endpoint must be an absolute HTTP(S) URL')
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new Error('tongjianyun-nutrition-rules: endpoint must use HTTP or HTTPS')
  }
  const identitySecretRef = config.identitySecretRef?.trim()
  const identityEmail = config.identityEmail?.trim()
  if ((identitySecretRef === undefined) !== (identityEmail === undefined)) {
    throw new Error('tongjianyun-nutrition-rules: identitySecretRef and identityEmail must be configured together')
  }
  return {
    endpoint,
    credentialRef: credentialRef(config.credentialRef),
    ...(config.actorTokenRef === undefined ? {} : { actorTokenRef: credentialRef(config.actorTokenRef) }),
    ...(identitySecretRef === undefined || identityEmail === undefined
      ? {}
      : {
        identitySecretRef: credentialRef(identitySecretRef),
        identityEmail,
        ...(config.identityUserHint === undefined ? {} : { identityUserHint: config.identityUserHint }),
      }),
    identityAudience: config.identityAudience?.trim().toLowerCase() || endpoint.hostname.toLowerCase(),
  }
}

/** A per-plugin Frappe-MCP client that resolves credentials immediately before each operation. */
export class NutritionMcpClient {
  private nextRequestId = 0

  constructor(
    private readonly ctx: Context,
    private readonly spec: NutritionMcpSpec,
  ) {}

  /**
   * Call one registered Frappe MCP tool without exposing transport credentials to the model.
   * @param tool - server-side Frappe MCP tool name.
   * @param arguments_ - JSON-safe arguments validated by the Harness tool schema.
   * @param signal - cancellation signal from the Harness tool runtime.
   * @returns the server's structured MCP result.
   * @throws when credential resolution, transport, or the server-side operation fails.
   */
  async call(tool: string, arguments_: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue> {
    const authorization = await this.resolveCredential(this.spec.credentialRef, 'MCP credential')
    const actorToken = await this.resolveActorToken()
    const body = {
      jsonrpc: '2.0',
      id: ++this.nextRequestId,
      method: 'tools/call',
      params: {
        name: tool,
        arguments: {
          ...arguments_,
          ...(actorToken === undefined ? {} : { actor_token: actorToken }),
        },
      },
    }
    let response: Response
    try {
      response = await fetch(this.spec.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `token ${authorization}`,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new Error(`tongjianyun-nutrition-rules: MCP request failed: ${describeError(error)}`, { cause: error })
    }

    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(
        `tongjianyun-nutrition-rules: MCP request failed with HTTP ${response.status}${errorDetail(payload)}`,
      )
    }
    return readToolResult(payload)
  }

  private async resolveCredential(ref: CredentialRef, label: string): Promise<string> {
    const credentials = this.ctx.get('credentials') as { resolve: (value: CredentialRef) => Promise<{ value?: string } | undefined> } | undefined
    if (credentials === undefined) {
      throw new Error('tongjianyun-nutrition-rules: credential service is not mounted; configure native mode or mount credentials')
    }
    const hit = await credentials.resolve(ref)
    if (hit?.value) return hit.value
    throw new Error(
      `tongjianyun-nutrition-rules: ${label} ${String(ref)} is not configured; set it in the Harness credential store`,
    )
  }

  /** Mint a fresh short-lived actor assertion so it cannot expire in the credential store. */
  private async resolveActorToken(): Promise<string | undefined> {
    if (this.spec.identitySecretRef !== undefined && this.spec.identityEmail !== undefined) {
      const secret = await this.resolveCredential(this.spec.identitySecretRef, 'identity signing secret')
      return issueActorToken({
        email: this.spec.identityEmail,
        audience: this.spec.identityAudience,
        secret,
        ...(this.spec.identityUserHint === undefined ? {} : { userHint: this.spec.identityUserHint }),
      })
    }
    if (this.spec.actorTokenRef === undefined) return undefined
    return this.resolveCredential(this.spec.actorTokenRef, 'current-user identity token')
  }
}

/** Issue the same bounded HMAC assertion format as the I-ONE Agent bridge. */
function issueActorToken({
  email,
  userHint,
  audience,
  secret,
}: {
  email: string
  userHint?: string
  audience: string
  secret: string
}): string {
  if (secret.length < 32) throw new Error('tongjianyun-nutrition-rules: identity signing secret is not configured')
  const issuedAt = Math.floor(Date.now() / 1000)
  const payload = {
    aud: audience,
    email,
    exp: issuedAt + ACTOR_TOKEN_TTL_SECONDS,
    iat: issuedAt,
    iss: 'ione-agent',
    user: userHint ?? '',
    v: 1,
  }
  const segment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signed = `${ACTOR_TOKEN_PREFIX}.${segment}`
  const signature = createHmac('sha256', secret).update(signed, 'ascii').digest('base64url')
  return `${signed}.${signature}`
}

/** Read a JSON response while preserving abort semantics. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new Error('tongjianyun-nutrition-rules: MCP endpoint returned invalid JSON', { cause: error })
  }
}

/** Unwrap Frappe's JSON-RPC response and return the MCP structured result. */
function readToolResult(payload: unknown): JsonValue {
  const envelope = isRecord(payload) && isRecord(payload.message) ? payload.message : payload
  if (!isRecord(envelope)) throw new Error('tongjianyun-nutrition-rules: MCP endpoint returned an invalid response')
  if (isRecord(envelope.error)) {
    throw new Error(`tongjianyun-nutrition-rules: ${stringField(envelope.error, 'message') ?? 'MCP request was rejected'}`)
  }
  const result = envelope.result
  if (!isRecord(result)) throw new Error('tongjianyun-nutrition-rules: MCP endpoint returned no tool result')
  if (result.isError === true) {
    throw new Error(`tongjianyun-nutrition-rules: ${contentText(result.content) ?? 'Frappe rejected the operation'}`)
  }
  if ('structuredContent' in result) return result.structuredContent as JsonValue
  return { content: result.content as JsonValue }
}

/** Add a bounded textual detail for HTTP failures without ever serializing credentials. */
function errorDetail(payload: unknown): string {
  if (!isRecord(payload)) return ''
  const message = stringField(payload, 'message')
    ?? stringField(payload, 'exception')
    ?? contentText(payload._server_messages)
  return message === undefined ? '' : `: ${message.slice(0, 500)}`
}

/** Read the first useful text item from a standard MCP content array. */
function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') return item.text
  }
  return undefined
}

/** Test whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read an optional text property. */
function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key]
  return typeof item === 'string' ? item : undefined
}

/** Keep cancellation visible to the tool runtime. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Turn unknown transport failures into a stable diagnostic. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
