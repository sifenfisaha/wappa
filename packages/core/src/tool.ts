import { ZodType, prettifyError, toJSONSchema } from 'zod';
import type { infer as zInfer } from 'zod';
import type { JsonSchema } from './provider.js';
import type { Context } from './context.js';

/** Tool names must match this (letters, digits, underscore, hyphen; 1–64 chars). */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * User-facing tool definition for {@link defineTool}.
 *
 * S is either a zod schema (args inferred) or a raw JSON Schema (args = Record).
 * NOTE: the union lives in the CONSTRAINT, not in the property type — this is what
 * makes both paths infer correctly (verified against TS 5.9 + zod 4).
 */
export interface ToolDefinition<S extends ZodType | JsonSchema = JsonSchema> {
  name: string;
  description: string;
  /** Zod schema (recommended) or raw JSON Schema object. Omitted = no parameters. */
  parameters?: S;
  execute(
    args: S extends ZodType ? zInfer<S> : Record<string, unknown>,
    ctx: Context
  ): Promise<unknown> | unknown;
}

/** A resolved tool as the agent loop consumes it. */
export interface Tool {
  name: string;
  description: string;
  /** Resolved JSON Schema (zod converted via z.toJSONSchema with io:'input' — the type the model must SEND, not the parsed output; default {type:'object',properties:{}}). */
  parameters: JsonSchema;
  /** Validates args (zod .parse when zod was given), runs execute, stringifies result. */
  invoke(args: Record<string, unknown>, ctx: Context): Promise<string>;
}

/** Runtime zod detection: instanceof, with a duck-type fallback for cross-realm schemas. */
function isZodSchema(value: unknown): value is ZodType {
  return (
    value instanceof ZodType ||
    typeof (value as { safeParse?: unknown } | null | undefined)?.safeParse === 'function'
  );
}

/** Stringify a tool result per the invoke contract. */
function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'ok';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Create a {@link Tool} from a definition. Validates the tool name eagerly and resolves
 * zod schemas to JSON Schema. `invoke` never throws: zod validation failures and
 * execute() errors are returned as result strings so the agent loop can continue.
 */
export function defineTool<S extends ZodType | JsonSchema = JsonSchema>(
  def: ToolDefinition<S>
): Tool {
  if (!TOOL_NAME_RE.test(def.name)) {
    throw new Error(
      `defineTool: invalid tool name ${JSON.stringify(def.name)} (must match ${TOOL_NAME_RE})`
    );
  }

  const zodSchema = isZodSchema(def.parameters) ? def.parameters : undefined;
  let parameters: JsonSchema;
  if (zodSchema) {
    // io:'input' — emit what the model must SEND. The default (io:'output') throws on
    // .transform() schemas and emits the parsed output type for .pipe() schemas.
    const { $schema: _dialect, ...schema } = toJSONSchema(zodSchema, { io: 'input' }) as Record<
      string,
      unknown
    >;
    parameters = schema;
  } else if (def.parameters !== undefined) {
    parameters = def.parameters as JsonSchema;
  } else {
    parameters = { type: 'object', properties: {} };
  }

  const execute = def.execute as (args: unknown, ctx: Context) => Promise<unknown> | unknown;

  return {
    name: def.name,
    description: def.description,
    parameters,
    async invoke(args: Record<string, unknown>, ctx: Context): Promise<string> {
      let resolvedArgs: unknown = args;
      if (zodSchema) {
        const parsed = zodSchema.safeParse(args);
        if (!parsed.success) {
          return `Error: invalid arguments for tool "${def.name}": ${prettifyError(parsed.error)}`;
        }
        resolvedArgs = parsed.data;
      }
      try {
        return stringifyResult(await execute(resolvedArgs, ctx));
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
