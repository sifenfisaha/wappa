import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from './tool.js';
import type { Context } from './context.js';

const ctx = {} as Context;

describe('defineTool', () => {
  it('validates the tool name eagerly', () => {
    expect(() => defineTool({ name: 'bad name!', description: 'x', execute: () => 'y' })).toThrow(
      /invalid tool name/
    );
    expect(() => defineTool({ name: '', description: 'x', execute: () => 'y' })).toThrow();
    expect(() =>
      defineTool({ name: 'a'.repeat(65), description: 'x', execute: () => 'y' })
    ).toThrow();
    expect(() =>
      defineTool({ name: 'Good_name-123', description: 'x', execute: () => 'y' })
    ).not.toThrow();
  });

  it('converts a zod schema to JSON Schema for parameters', () => {
    const tool = defineTool({
      name: 'search',
      description: 'search things',
      parameters: z.object({ query: z.string(), limit: z.number().optional() }),
      execute: (args) => args.query,
    });
    expect(tool.parameters['type']).toBe('object');
    const props = tool.parameters['properties'] as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['query', 'limit']);
    expect(tool.parameters['required']).toEqual(['query']);
    expect(tool.parameters['$schema']).toBeUndefined();
  });

  it('emits the INPUT type for transform/pipe schemas and still validates via safeParse', async () => {
    // With the default io:'output' this would throw at defineTool() time (.transform())
    // and a .pipe() would emit the parsed OUTPUT type instead of what the model sends.
    const tool = defineTool({
      name: 'transformer',
      description: 'x',
      parameters: z.object({
        upper: z.string().transform((s) => s.toUpperCase()),
        n: z.string().pipe(z.coerce.number()),
      }),
      execute: (args) => `${args.upper}:${args.n * 2}`,
    });
    const props = tool.parameters['properties'] as Record<string, { type?: string }>;
    expect(props['upper']!.type).toBe('string');
    expect(props['n']!.type).toBe('string'); // input side of the pipe, not the output
    await expect(tool.invoke({ upper: 'hey', n: '21' }, ctx)).resolves.toBe('HEY:42');
  });

  it('passes a raw JSON Schema through untouched', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const tool = defineTool({
      name: 'raw',
      description: 'raw schema',
      parameters: schema,
      execute: (args) => JSON.stringify(args),
    });
    expect(tool.parameters).toBe(schema);
  });

  it('defaults parameters to an empty object schema when omitted', () => {
    const tool = defineTool({ name: 'noargs', description: 'no args', execute: () => 'done' });
    expect(tool.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('parses args with zod and passes typed values to execute', async () => {
    const tool = defineTool({
      name: 'upper',
      description: 'uppercase',
      parameters: z.object({ value: z.string() }),
      // args.value is statically typed as string here (inference check).
      execute: (args) => args.value.toUpperCase(),
    });
    await expect(tool.invoke({ value: 'hey' }, ctx)).resolves.toBe('HEY');
  });

  it('returns zod validation errors as the result string instead of throwing', async () => {
    const tool = defineTool({
      name: 'strict',
      description: 'strict args',
      parameters: z.object({ n: z.number() }),
      execute: (args) => args.n * 2,
    });
    const result = await tool.invoke({ n: 'nope' } as never, ctx);
    expect(result).toMatch(/^Error: invalid arguments for tool "strict"/);
    expect(result).toContain('n');
  });

  it('passes raw-JSON-schema args to execute without validation', async () => {
    let seen: unknown;
    const tool = defineTool({
      name: 'passthrough',
      description: 'x',
      parameters: { type: 'object' },
      execute: (args) => {
        seen = args;
        return 'ok!';
      },
    });
    await tool.invoke({ anything: true }, ctx);
    expect(seen).toEqual({ anything: true });
  });

  it('stringifies results: string as-is, null/undefined -> "ok", objects -> JSON, primitives -> String', async () => {
    const make = (value: unknown) =>
      defineTool({ name: 'r', description: 'x', execute: () => value }).invoke({}, ctx);
    await expect(make('plain')).resolves.toBe('plain');
    await expect(make(null)).resolves.toBe('ok');
    await expect(make(undefined)).resolves.toBe('ok');
    await expect(make({ a: 1 })).resolves.toBe('{"a":1}');
    await expect(make([1, 2])).resolves.toBe('[1,2]');
    await expect(make(42)).resolves.toBe('42');
    await expect(make(true)).resolves.toBe('true');
  });

  it('returns thrown errors as "Error: <message>" instead of rejecting', async () => {
    const tool = defineTool({
      name: 'boom',
      description: 'x',
      execute: () => {
        throw new Error('kaput');
      },
    });
    await expect(tool.invoke({}, ctx)).resolves.toBe('Error: kaput');

    const asyncTool = defineTool({
      name: 'async_boom',
      description: 'x',
      execute: async () => {
        throw new Error('later');
      },
    });
    await expect(asyncTool.invoke({}, ctx)).resolves.toBe('Error: later');
  });

  it('awaits async execute results', async () => {
    const tool = defineTool({
      name: 'slow',
      description: 'x',
      execute: async () => ({ done: true }),
    });
    await expect(tool.invoke({}, ctx)).resolves.toBe('{"done":true}');
  });

  it('passes the context through to execute', async () => {
    let received: Context | undefined;
    const tool = defineTool({
      name: 'ctxcheck',
      description: 'x',
      execute: (_args, c) => {
        received = c;
      },
    });
    const fake = { state: { marker: 1 } } as unknown as Context;
    await tool.invoke({}, fake);
    expect(received).toBe(fake);
  });
});
