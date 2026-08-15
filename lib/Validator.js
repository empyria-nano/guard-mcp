import { createValidator } from '@principia/common'

/**
 * @typedef {Object} JsonSchemaValidatorResult
 * @property {boolean} valid
 * @property {*} [data]
 * @property {string} [errorMessage]
 */

/**
 * The MCP SDK's `jsonSchemaValidator` provider interface (see
 * `@modelcontextprotocol/server`'s `fromJsonSchema`), backed by
 * `@principia/common`'s `createValidator` — no Ajv, no Zod.
 *
 * `createValidator` throws a `PrincipiaError` on invalid input; this adapts
 * that into the provider's `{valid, data, errorMessage}` result shape.
 */
export const principiaJsonSchemaValidator = {
	/**
	 * @param {Object} schema - A JSON schema (Draft 2020-12-compatible).
	 * @returns {(input: unknown) => JsonSchemaValidatorResult}
	 */
	getValidator(schema) {
		const validate = createValidator(schema)

		return (input) => {
			try {
				return { valid: true, data: validate(input) }
			} catch (err) {
				return { valid: false, errorMessage: err.message }
			}
		}
	},
}
