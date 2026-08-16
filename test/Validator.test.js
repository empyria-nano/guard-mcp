import { describe, test, expect } from 'bun:test'
import { empyriaJsonSchemaValidator } from '../lib/Validator.js'

describe('empyriaJsonSchemaValidator', () => {
	const schema = {
		type: 'object',
		properties: { name: { type: 'string' }, age: { type: 'number', default: 0 } },
		required: ['name'],
	}

	test('getValidator returns a reusable validator function', () => {
		const validate = empyriaJsonSchemaValidator.getValidator(schema)
		expect(typeof validate).toBe('function')
	})

	test('valid input resolves with the (defaulted) data', () => {
		const validate = empyriaJsonSchemaValidator.getValidator(schema)
		const result = validate({ name: 'Bob' })
		expect(result.valid).toBe(true)
		expect(result.data).toEqual({ name: 'Bob', age: 0 })
	})

	test('invalid input resolves with an error message, not a throw', () => {
		const validate = empyriaJsonSchemaValidator.getValidator(schema)
		const result = validate({})
		expect(result.valid).toBe(false)
		expect(typeof result.errorMessage).toBe('string')
		expect(result.errorMessage).toContain('name')
	})
})
