interface ExpectedField {
  id: string;
  type: string;
}

/** Parse the Base v3 batch_get parallel-array data object by ID, never by display name. */
export function parseRecordMatrix(
  data: unknown,
  recordId: string,
  expected: readonly ExpectedField[],
): ReadonlyMap<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw new Error("invalid_shape");
  const matrix = data as Record<string, unknown>;
  const {
    timezone,
    fields,
    field_id_list: ids,
    field_type_list: types,
    record_id_list: records,
    data: rows,
    ignored_fields: ignored,
    record_not_found: missing,
    has_more: more,
  } = matrix;
  if (
    typeof timezone !== "string" ||
    !timezone.trim() ||
    !Array.isArray(fields) ||
    !Array.isArray(ids) ||
    !Array.isArray(types) ||
    !Array.isArray(records) ||
    !Array.isArray(rows)
  )
    throw new Error("invalid_shape");
  if (
    fields.length !== ids.length ||
    ids.length !== types.length ||
    fields.some((x) => typeof x !== "string") ||
    ids.some((x) => typeof x !== "string") ||
    types.some((x) => typeof x !== "string") ||
    new Set(ids).size !== ids.length
  )
    throw new Error("invalid_shape");
  if (ignored != null && (!Array.isArray(ignored) || ignored.length !== 0))
    throw new Error("field_permission");
  if (missing != null && (!Array.isArray(missing) || missing.length !== 0))
    throw new Error("not_found");
  if (more !== undefined && more !== false) throw new Error("invalid_shape");
  if (
    records.length !== 1 ||
    records[0] !== recordId ||
    rows.length !== 1 ||
    !Array.isArray(rows[0]) ||
    rows[0].length !== ids.length
  )
    throw new Error("scope_mismatch");
  if (
    new Set(expected.map((field) => field.id)).size !== expected.length ||
    ids.length !== expected.length
  )
    throw new Error("invalid_shape");
  const result = new Map<string, unknown>();
  for (const field of expected) {
    const index = ids.indexOf(field.id);
    if (index < 0 || types[index] !== field.type)
      throw new Error("unsupported_field_shape");
    result.set(field.id, rows[0][index]);
  }
  return result;
}
