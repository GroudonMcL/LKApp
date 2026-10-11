import Ajv2020 from 'ajv/dist/2020'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Validates request bodies against the official LegendKeeper OpenAPI spec shipped inside
 * `@legendkeeper/sdk` (openapi.json). This proves our generated content matches the
 * documented schema without calling the live API.
 */
const require = createRequire(import.meta.url)
// openapi.json ships in the package root but is not in its "exports", so read it from disk.
const sdkEntry = require.resolve('@legendkeeper/sdk')
const spec = JSON.parse(readFileSync(join(dirname(sdkEntry), '..', 'openapi.json'), 'utf8')) as {
  openapi: string
  components: { schemas: Record<string, unknown> }
}

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
ajv.addSchema({ $id: 'lk-openapi', components: spec.components }, 'lk-openapi')

export function validateAgainstSpec(schemaName: string, value: unknown): { valid: boolean; errors: string[] } {
  const validate = ajv.getSchema(`lk-openapi#/components/schemas/${schemaName}`)
  if (!validate) throw new Error(`No schema ${schemaName} in the LegendKeeper OpenAPI spec`)
  const valid = validate(value) as boolean
  return {
    valid,
    errors: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''} ${JSON.stringify(e.params)}`),
  }
}

export const LK_OPENAPI_VERSION = spec.openapi
