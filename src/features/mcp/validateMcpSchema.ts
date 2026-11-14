import { createHash } from 'node:crypto';

import { McpToolError } from './McpToolError.js';

const MAX_DEPTH = 16;
const TYPES = new Set(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object']);
const KEYS = new Set([
  '$schema',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'properties',
  'required',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
]);

/*** Validates a closed supported JSON Schema and returns its stable argument matcher. */
export const validateMcpSchema = (schema: Readonly<Record<string, unknown>>) => {
  validateSchema(schema, 0);
  return {
    fingerprint: createHash('sha256').update(stableStringify(schema)).digest('hex'),
    matches: (value: unknown): boolean => matches(schema, value),
  };
};

/*** Rejects unsupported JSON Schema features instead of weakening validation. */
const validateSchema = (schema: Readonly<Record<string, unknown>>, depth: number): void => {
  if (depth > MAX_DEPTH)
    throw new McpToolError('invalid_schema', 'MCP schema exceeds depth limit.');
  if (Object.keys(schema).some((key) => !KEYS.has(key)))
    throw new McpToolError(
      'unsupported_schema',
      'The MCP tool schema uses unsupported constraints.',
    );
  const { type } = schema;
  if (typeof type !== 'string' || !TYPES.has(type))
    throw new McpToolError('invalid_schema', 'MCP schemas require one supported type.');
  validateJsonConstraints(schema);
  if (type === 'object') validateObject(schema, depth);
  if (type === 'array') validateArray(schema, depth);
  if (type === 'string') validateString(schema);
  if (type === 'number' || type === 'integer') validateNumber(schema);
};

/*** Validates portable const and enum declarations. */
const validateJsonConstraints = (schema: Readonly<Record<string, unknown>>): void => {
  if ('const' in schema && !isJson(schema.const))
    throw new McpToolError('invalid_schema', 'MCP schema const must be JSON data.');
  if (
    'enum' in schema &&
    (!Array.isArray(schema.enum) || !schema.enum.length || !schema.enum.every(isJson))
  )
    throw new McpToolError('invalid_schema', 'MCP schema enum must contain JSON data.');
};

/*** Requires a closed object schema with validated declared properties. */
const validateObject = (schema: Readonly<Record<string, unknown>>, depth: number): void => {
  const { properties, required, additionalProperties } = schema;
  if (additionalProperties !== false)
    throw new McpToolError(
      'unsupported_schema',
      'MCP object schemas must set additionalProperties to false.',
    );
  if (!isRecord(properties))
    throw new McpToolError('invalid_schema', 'MCP object schemas need property definitions.');
  Object.values(properties).forEach((property) => {
    if (!isRecord(property))
      throw new McpToolError('invalid_schema', 'MCP property schemas must be objects.');
    validateSchema(property, depth + 1);
  });
  if (
    required !== undefined &&
    (!isUniqueStrings(required) || required.some((key) => !(key in properties)))
  )
    throw new McpToolError(
      'invalid_schema',
      'MCP required properties must be declared exactly once.',
    );
  validateBounds(
    schema.minProperties,
    schema.maxProperties,
    'minProperties',
    'maxProperties',
    true,
  );
};

/*** Requires an item schema so every array value is validated. */
const validateArray = (schema: Readonly<Record<string, unknown>>, depth: number): void => {
  if (!isRecord(schema.items))
    throw new McpToolError('unsupported_schema', 'MCP array schemas require an item schema.');
  validateSchema(schema.items, depth + 1);
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean')
    throw new McpToolError('invalid_schema', 'MCP uniqueItems must be boolean.');
  validateBounds(schema.minItems, schema.maxItems, 'minItems', 'maxItems', true);
};

/*** Validates string bounds and regular-expression patterns. */
const validateString = (schema: Readonly<Record<string, unknown>>): void => {
  validateBounds(schema.minLength, schema.maxLength, 'minLength', 'maxLength', true);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string')
      throw new McpToolError('invalid_schema', 'MCP pattern must be a string.');
    try {
      new RegExp(schema.pattern, 'u');
    } catch {
      throw new McpToolError('invalid_schema', 'MCP pattern must compile.');
    }
  }
};

/*** Validates finite numeric constraints. */
const validateNumber = (schema: Readonly<Record<string, unknown>>): void => {
  const values = [
    schema.minimum,
    schema.maximum,
    schema.exclusiveMinimum,
    schema.exclusiveMaximum,
    schema.multipleOf,
  ];
  if (
    values.some(
      (value) => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)),
    )
  )
    throw new McpToolError('invalid_schema', 'MCP numeric constraints must be finite numbers.');
  if (typeof schema.multipleOf === 'number' && schema.multipleOf <= 0)
    throw new McpToolError('invalid_schema', 'MCP multipleOf must be positive.');
};

/*** Validates ordered numeric or integer bounds. */
const validateBounds = (
  minimum: unknown,
  maximum: unknown,
  minimumKey: string,
  maximumKey: string,
  integers: boolean,
): void => {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!integers || (Number.isSafeInteger(value) && value >= 0));
  if (minimum !== undefined && !valid(minimum))
    throw new McpToolError('invalid_schema', `MCP ${minimumKey} is invalid.`);
  if (maximum !== undefined && !valid(maximum))
    throw new McpToolError('invalid_schema', `MCP ${maximumKey} is invalid.`);
  if (typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum)
    throw new McpToolError('invalid_schema', `MCP ${minimumKey} cannot exceed ${maximumKey}.`);
};

/*** Matches supported JSON Schema constraints without coercion. */
const matches = (schema: Readonly<Record<string, unknown>>, value: unknown): boolean => {
  const { type } = schema;
  if (typeof type !== 'string' || !matchesType(type, value)) return false;
  if ('const' in schema && stableStringify(schema.const) !== stableStringify(value)) return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => stableStringify(item) === stableStringify(value))
  )
    return false;
  if (type === 'object') return matchesObject(schema, value);
  if (type === 'array') return matchesArray(schema, value);
  if (type === 'string') return matchesString(schema, value);
  return (type !== 'number' && type !== 'integer') || matchesNumber(schema, value as number);
};

/*** Matches a closed object and each declared property schema. */
const matchesObject = (schema: Readonly<Record<string, unknown>>, value: unknown): boolean => {
  const { properties, required } = schema;
  const minProperties = numberOr(schema.minProperties, 0);
  const maxProperties = numberOr(schema.maxProperties, Infinity);
  if (!isRecord(value) || !isRecord(properties)) return false;
  const entries = Object.entries(value);
  return (
    entries.length >= minProperties &&
    entries.length <= maxProperties &&
    (!Array.isArray(required) ||
      required.every((key) => typeof key === 'string' && key in value)) &&
    entries.every(([key, item]) => {
      const property = Object.entries(properties).find(([name]) => name === key)?.[1];
      return isRecord(property) && matches(property, item);
    })
  );
};

/*** Matches array items, bounds, and deterministic uniqueness. */
const matchesArray = (schema: Readonly<Record<string, unknown>>, value: unknown): boolean => {
  const { items, uniqueItems = false } = schema;
  const minItems = numberOr(schema.minItems, 0);
  const maxItems = numberOr(schema.maxItems, Infinity);
  return (
    Array.isArray(value) &&
    isRecord(items) &&
    value.length >= minItems &&
    value.length <= maxItems &&
    (!uniqueItems || new Set(value.map(stableStringify)).size === value.length) &&
    value.every((item) => matches(items, item))
  );
};

/*** Matches string constraints. */
const matchesString = (schema: Readonly<Record<string, unknown>>, value: unknown): boolean =>
  typeof value === 'string' &&
  [...value].length >= numberOr(schema.minLength, 0) &&
  [...value].length <= numberOr(schema.maxLength, Infinity) &&
  (typeof schema.pattern !== 'string' || new RegExp(schema.pattern, 'u').test(value));

/*** Matches finite number constraints. */
const matchesNumber = (schema: Readonly<Record<string, unknown>>, value: number): boolean =>
  (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
  (typeof schema.maximum !== 'number' || value <= schema.maximum) &&
  (typeof schema.exclusiveMinimum !== 'number' || value > schema.exclusiveMinimum) &&
  (typeof schema.exclusiveMaximum !== 'number' || value < schema.exclusiveMaximum) &&
  (typeof schema.multipleOf !== 'number' || Number.isInteger(value / schema.multipleOf));

/*** Matches a JSON Schema primitive type. */
const matchesType = (type: string, value: unknown): boolean =>
  (type === 'null' && value === null) ||
  (type === 'array' && Array.isArray(value)) ||
  (type === 'object' && isRecord(value)) ||
  (type === 'integer' && Number.isSafeInteger(value)) ||
  (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
  (type === 'string' && typeof value === 'string') ||
  (type === 'boolean' && typeof value === 'boolean');

/*** Narrows unknown data to a non-array object. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/*** Confirms a value is portable JSON data. */
const isJson = (value: unknown): boolean =>
  value === null ||
  ['string', 'boolean'].includes(typeof value) ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  (Array.isArray(value) && value.every(isJson)) ||
  (isRecord(value) && Object.values(value).every(isJson));
/*** Confirms a value is an array of unique non-empty strings. */
const isUniqueStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === 'string' && item.length > 0) &&
  new Set(value).size === value.length;
/*** Returns a numeric schema value or its validated default. */
const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' ? value : fallback;
/*** Serializes JSON data deterministically. */
const stableStringify = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stableStringify).join(',')}]`
    : isRecord(value)
      ? `{${Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
          .join(',')}}`
      : JSON.stringify(value);
