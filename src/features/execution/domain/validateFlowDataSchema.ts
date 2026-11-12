import type { DataContractValue, DataSchema, DataSchemaRegistry } from '@ankhorage/contracts/data';

const maximumSchemaDepth = 64;

/*** Validate serializable data against the supported portable schema vocabulary. */
export const validateFlowDataSchema = (
  value: DataContractValue,
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
): boolean => {
  assertFlowDataSchemaSupported(schema, schemas);
  return matchesSchema(value, schema, schemas, createTraversalState());
};

/*** Reject unsupported, unresolved, cyclic, or excessively nested portable schemas before use. */
export const assertFlowDataSchemaSupported = (
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
): void => assertSupportedSchema(schema, schemas, createTraversalState());

/*** Resolve a schema reference only from the explicit execution registry. */
const resolveSchema = (
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
  state: SchemaTraversalState,
): DataSchema => {
  if (!schema.ref) return schema;
  if (state.referenceIds.has(schema.ref.id))
    throw new Error(`FLOW_SCHEMA_REFERENCE_CYCLE:${schema.ref.id}`);
  const resolved = schemas?.[schema.ref.id];
  if (!resolved) throw new Error(`FLOW_SCHEMA_REFERENCE_UNRESOLVED:${schema.ref.id}`);
  return resolved;
};

/*** Apply portable schema constraints without coercing a JSON-compatible value. */
const matchesSchema = (
  value: DataContractValue,
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
  state: SchemaTraversalState,
): boolean => {
  const resolved = resolveSchema(schema, schemas, state);
  const nextState = advanceTraversalState(resolved, schema.ref?.id, state);
  return (
    matchesTypes(value, resolved) &&
    matchesValues(value, resolved) &&
    matchesComposition(value, resolved, schemas, nextState) &&
    matchesStructure(value, resolved, schemas, nextState)
  );
};

/*** Reject portable annotations that require a validator capability this engine does not own. */
const assertSupportedSchema = (
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
  state: SchemaTraversalState,
): void => {
  if (schema.format !== undefined) throw new Error(`FLOW_SCHEMA_UNSUPPORTED_CONSTRAINT:format`);
  const nextState = advanceTraversalState(schema, undefined, state);
  visitChildSchemas(schema, schemas, nextState);
  if (!schema.ref) return;
  const resolved = resolveSchema(schema, schemas, state);
  assertSupportedSchema(resolved, schemas, {
    ...nextState,
    referenceIds: new Set([...state.referenceIds, schema.ref.id]),
  });
};

/*** Visit every schema child so unsupported declarations fail before value matching begins. */
const visitChildSchemas = (
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
  state: SchemaTraversalState,
): void => {
  const children = [
    ...(schema.items ? [schema.items] : []),
    ...(typeof schema.additionalProperties === 'object' ? [schema.additionalProperties] : []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.allOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
  ];
  for (const child of children) assertSupportedSchema(child, schemas, state);
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
  state: SchemaTraversalState,
): boolean =>
  (!schema.allOf ||
    schema.allOf.every((candidate) => matchesSchema(value, candidate, schemas, state))) &&
  (!schema.anyOf ||
    schema.anyOf.some((candidate) => matchesSchema(value, candidate, schemas, state))) &&
  (!schema.oneOf ||
    schema.oneOf.filter((candidate) => matchesSchema(value, candidate, schemas, state)).length ===
      1);

/*** Recursively apply object and array member constraints. */
const matchesStructure = (
  value: DataContractValue,
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
  state: SchemaTraversalState,
): boolean =>
  matchesItems(value, schema.items, schemas, state) &&
  (!isDataRecord(value) || matchesProperties(value, schema, schemas, state));

/*** Validate array elements only when an item schema is declared. */
const matchesItems = (
  value: DataContractValue,
  items: DataSchema | undefined,
  schemas: DataSchemaRegistry | undefined,
  state: SchemaTraversalState,
): boolean =>
  !items ||
  !isDataArray(value) ||
  value.every((item) => matchesSchema(item, items, schemas, state));

/*** Validate required object members and declared or additional property schemas. */
const matchesProperties = (
  value: Readonly<Record<string, DataContractValue>>,
  schema: DataSchema,
  schemas: DataSchemaRegistry | undefined,
  state: SchemaTraversalState,
): boolean => {
  const properties = schema.properties ?? {};
  return (
    (schema.required ?? []).every((key) => Object.entries(value).some(([name]) => name === key)) &&
    Object.entries(value).every(([key, item]) => {
      const property = Object.entries(properties).find(([name]) => name === key)?.[1];
      if (property) return matchesSchema(item, property, schemas, state);
      if (schema.additionalProperties === false) return false;
      return (
        typeof schema.additionalProperties !== 'object' ||
        matchesSchema(item, schema.additionalProperties, schemas, state)
      );
    })
  );
};

interface SchemaTraversalState {
  readonly depth: number;
  readonly referenceIds: ReadonlySet<string>;
  readonly schemas: ReadonlySet<DataSchema>;
}

/*** Start bounded schema traversal without retaining mutable validation state. */
const createTraversalState = (): SchemaTraversalState => ({
  depth: 0,
  referenceIds: new Set(),
  schemas: new Set(),
});

/*** Advance a schema traversal while rejecting direct cycles and excessive nesting deterministically. */
const advanceTraversalState = (
  schema: DataSchema,
  referenceId: string | undefined,
  state: SchemaTraversalState,
): SchemaTraversalState => {
  if (state.depth >= maximumSchemaDepth) throw new Error('FLOW_SCHEMA_MAX_DEPTH');
  if (state.schemas.has(schema)) throw new Error('FLOW_SCHEMA_CYCLE');
  return {
    depth: state.depth + 1,
    referenceIds: referenceId ? new Set([...state.referenceIds, referenceId]) : state.referenceIds,
    schemas: new Set([...state.schemas, schema]),
  };
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
