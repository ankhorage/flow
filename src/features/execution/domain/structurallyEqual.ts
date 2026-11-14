import type { DataContractValue } from '@ankhorage/contracts/data';

/** Compare serializable values with object-key-order independence. */
export const structurallyEqual = (left: DataContractValue, right: DataContractValue): boolean =>
  JSON.stringify(normalizeValue(left)) === JSON.stringify(normalizeValue(right));

/** Canonicalize object member ordering for structural equality. */
const normalizeValue = (value: DataContractValue): DataContractValue => {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeValue(item)]),
    );
  return value;
};
