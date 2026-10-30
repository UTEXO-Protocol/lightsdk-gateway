import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, ERROR_CODES } from '../src/openapi.js';
import { findKeyMaterialFields } from '../src/schemas/scan.js';
import { testServer } from './helpers.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function generate(): Promise<Record<string, unknown>> {
  const app = await testServer();
  await app.ready();
  try {
    const { version } = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    return buildOpenApiDocument(app.routeSchemas, version);
  } finally {
    await app.close();
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && entry.name !== 'openapi.ts' ? [path] : [];
  });
}

function refsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) =>
    key === '$ref' && typeof item === 'string' ? [item] : refsIn(item),
  );
}

describe('OpenAPI document', () => {
  // Regenerate with `pnpm --filter @utexo/lightsdk-gateway openapi` after a
  // route or schema change, and review the diff: it is the contract change.
  it('matches the committed openapi.json', async () => {
    const document = await generate();
    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot('../openapi.json');
  });

  it('lists exactly the error codes the gateway raises, under their status', () => {
    const raised = new Map<string, number | undefined>();
    for (const file of sourceFiles(join(PACKAGE_ROOT, 'src'))) {
      const source = readFileSync(file, 'utf8');
      // `new HttpError(status, 'CODE', ...)`, including a code chosen by a
      // conditional; the status is checked where it is a literal.
      for (const match of source.matchAll(/new HttpError\(([^;]*)/g)) {
        const call = match[1] ?? '';
        const literal = /^\s*(\d{3}),\s*'([A-Z][A-Z0-9_]+)'/.exec(call);
        if (literal !== null) {
          raised.set(literal[2]!, Number(literal[1]));
          continue;
        }
        for (const code of call.matchAll(/'([A-Z][A-Z0-9_]+)'/g)) raised.set(code[1]!, undefined);
      }
      // Error bodies the central handler builds itself.
      for (const match of source.matchAll(/error: \{ code: '([A-Z][A-Z0-9_]+)'/g)) {
        raised.set(match[1]!, undefined);
      }
    }
    expect([...raised.keys()].sort()).toEqual(Object.keys(ERROR_CODES).sort());
    for (const [code, status] of raised) {
      if (status === undefined) continue;
      expect(ERROR_CODES[code as keyof typeof ERROR_CODES].status, code).toBe(status);
    }
  });

  it('resolves every $ref and declares no key-material field', async () => {
    const document = await generate();
    for (const ref of refsIn(document)) {
      const target = ref
        .replace(/^#\//, '')
        .split('/')
        .reduce<unknown>(
          (node, segment) =>
            node !== null && typeof node === 'object'
              ? (node as Record<string, unknown>)[segment]
              : undefined,
          document,
        );
      expect(target, ref).toBeDefined();
    }
    expect(findKeyMaterialFields(document)).toEqual([]);
  });
});
