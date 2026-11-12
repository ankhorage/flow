import type { DataContractValue, DataSchema, DataSchemaRegistry } from '@ankhorage/contracts/data';

/*** Validate serializable data against the supported portable schema vocabulary. */
export const validateFlowDataSchema = (
  value: DataContractValue,
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
): boolean => matchesSchema(value, resolveSchema(schema, schemas), schemas);

/*** Resolve a schema reference only from the explicit execution registry. */
const resolveSchema = (schema: DataSchema, schemas: DataSchemaRegistry | undefined): DataSchema => {
  if (!schema.ref) return schema;
  const resolved = schemas?.[schema.ref.id];
  if (!resolved) throw new Error(`FLOW_SCHEMA_REFERENCE_UNRESOLVED:${schema.ref.id}`);
  return resolved;
};

/*** Apply portable schema constraints without coercing a JSON-compatible value. */
const matchesSchema = (
  value: DataContractValue,
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
): boolean => {
  assertSupportedSchema(schema);
  const resolved = resolveSchema(schema, schemas);
  return (
    matchesTypes(value, resolved) &&
    matchesValues(value, resolved) &&
    matchesComposition(value, resolved, schemas) &&
    matchesStructure(value, resolved, schemas)
  );
};

/*** Reject portable annotations that require a validator capability this engine does not own. */
const assertSupportedSchema = (schema: DataSchema): void => {
  if (schema.format !== undefined) throw new Error(`FLOW_SCHEMA_UNSUPPORTED_CONSTRAINT:format`);
};

/*** Match the declared primitive type union and explicit nullability. */
const matchesTypes = (value: DataContractValue, schema: DataSchema): boolean => {
  if (value === null && schema.nullable) return true;
  if (schema.type === undefined) return true;
  if (typeof schema.type === 'string') return matchesType(value, schema.type);
  return schema.type.some((type) => matchesType(value, type));
};

/*** Match one JSON primitive category without coercion. */
const matchesType = (value: DataContractValue, type: string): boolean => {
  if (type === 'array') return isDataArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'null') return value === null;
  if (type === 'object') return isDataRecord(value);
  return typeof value === type;
};

/*** Apply constant and enumeration constraints using structural JSON equality. */
const matchesValues = (value: DataContractValue, schema: DataSchema): boolean =>
  (schema.const === undefined || structurallyEqual(value, schema.const)) &&
  (!schema.enum || schema.enum.some((candidate) => structurallyEqual(value, candidate)));

/*** Apply logical schema composition with its standard cardinality semantics. */
const matchesComposition = (
  value: DataContractValue,
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
): boolean =>
  (!schema.allOf || schema.allOf.every((candidate) => matchesSchema(value, candidate, schemas))) &&
  (!schema.anyOf || schema.anyOf.some((candidate) => matchesSchema(value, candidate, schemas))) &&
  (!schema.oneOf ||
    schema.oneOf.filter((candidate) => matchesSchema(value, candidate, schemas)).length === 1);

/*** Recursively apply object and array member constraints. */
const matchesStructure = (
  value: DataContractValue,
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
): boolean =>
  matchesItems(value, schema.items, schemas) &&
  (!schema.properties || !isDataRecord(value) || matchesProperties(value, schema, schemas));

/*** Validate array elements only when an item schema is declared. */
const matchesItems = (
  value: DataContractValue,
  items: DataSchema | undefined,
  schemas: DataSchemaRegistry | undefined,
): boolean =>
  !items || !isDataArray(value) || value.every((item) => matchesSchema(item, items, schemas));

/*** Validate required object members and declared or additional property schemas. */
const matchesProperties = (
  value: Readonly<Record<string, DataContractValue>>,
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
): boolean => {
  const properties = schema.properties ?? {};
  return (
    (schema.required ?? []).every((key) => Object.entries(value).some(([name]) => name === key)) &&
    Object.entries(value).every(([key, item]) => {
      const property = Object.entries(properties).find(([name]) => name === key)?.[1];
      if (property) return matchesSchema(item, property, schemas);
      if (schema.additionalProperties === false) return false;
      return (
        typeof schema.additionalProperties !== 'object' ||
        matchesSchema(item, schema.additionalProperties, schemas)
      );
    })
  );
};

/*** Compare JSON-compatible values independently of object key order. */
const structurallyEqual = (left: DataContractValue, right: DataContractValue): boolean =>
  JSON.stringify(normalizeValue(left)) === JSON.stringify(normalizeValue(right));

/*** Canonicalize object member ordering for structural comparison. */
const normalizeValue = (value: DataContractValue): DataContractValue => {
  if (isDataArray(value)) return value.map(normalizeValue);
  if (isDataRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeValue(item)]),
    );
  return value;
};

/*** Narrow a JSON-compatible object to a non-array member record. */
const isDataRecord = (
  value: DataContractValue,
): value is Readonly<Record<string, DataContractValue>> =>
  value !== null && typeof value === 'object' && !isDataArray(value);

/*** Narrow a JSON-compatible array without losing its serializable member type. */
const isDataArray = (value: DataContractValue): value is readonly DataContractValue[] =>
  Array.isArray(value);
