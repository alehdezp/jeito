type Schema = Record<string, unknown>;

export const S = {
  string(description?: string): Schema {
    return description ? { type: "string", description } : { type: "string" };
  },
  number(description?: string): Schema {
    return description ? { type: "number", description } : { type: "number" };
  },
  boolean(description?: string): Schema {
    return description ? { type: "boolean", description } : { type: "boolean" };
  },
  array(items: Schema, description?: string): Schema {
    return description ? { type: "array", items, description } : { type: "array", items };
  },
  union(anyOf: Schema[], description?: string): Schema {
    return description ? { anyOf, description } : { anyOf };
  },
  object(properties: Record<string, Schema>, required: string[]): Schema {
    return { type: "object", properties, required, additionalProperties: false };
  },
};
