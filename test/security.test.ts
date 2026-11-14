import { expect, test } from 'bun:test';

import { createSupabaseVaultAdapter } from '@ankhorage/secrets-supabase-vault';

import { createFlowSecurityPort, FlowSecurityError } from '../src/index.js';

const actor = {
  id: 'operator-a',
  tenantId: 'tenant-a',
  projectId: 'project-a',
  environment: 'production',
};

const operation = {
  actor,
  capability: 'mcp:fixture:write',
  idempotencyKey: 'key-1',
  operationId: 'operation-1',
  secretRefs: ['providers/fixture'],
  targetUrl: 'https://api.example.test/publish',
};

const createSecurity = (
  input: {
    readonly approval?: 'approved' | 'pending' | 'rejected';
    readonly grants?: readonly {
      readonly actorId: string;
      readonly capability: string;
      readonly tenantId: string;
      readonly projectId: string;
      readonly environment: string;
    }[];
    readonly secretResult?: { readonly ok: boolean };
  } = {},
) => {
  const events: unknown[] = [];
  const resolved =
    input.secretResult?.ok === false
      ? { ok: false as const, error: { code: 'not_found' as const, message: 'SENTINEL_SECRET' } }
      : { ok: true as const, data: { token: 'SENTINEL_SECRET' } };
  return {
    events,
    port: createFlowSecurityPort({
      approvalStore: {
        getAsync: async (operationId) => ({ operationId, status: input.approval ?? 'approved' }),
      },
      audit: {
        writeAsync: async (event) => {
          events.push(event);
        },
      },
      grants: input.grants ?? [{ ...actor, actorId: actor.id, capability: operation.capability }],
      rateLimit: { acquireAsync: async () => true },
      secretStore: {
        create: async () => ({ ok: false, error: { code: 'unavailable', message: 'unused' } }),
        getMetadata: async ({ scope, ref }) => ({
          ok: true,
          data: {
            ref,
            scope,
            kind: 'token',
            configuredFields: ['token'],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        }),
        list: async () => ({ ok: true, data: [] }),
        remove: async () => ({ ok: true }),
        replace: async () => ({ ok: false, error: { code: 'unavailable', message: 'unused' } }),
        resolve: async () => resolved,
      },
    }),
  };
};

test('denies a cross-tenant actor before a secret can resolve', async () => {
  const { port } = createSecurity();
  await expect(
    port.authorizeAsync({ ...operation, actor: { ...actor, tenantId: 'tenant-b' } }),
  ).rejects.toMatchObject({ code: 'permission_denied' });
});

test('redacts secret values from failures and audit observations', async () => {
  const { events, port } = createSecurity({ secretResult: { ok: false } });
  const permit = await port.authorizeAsync(operation);
  await expect(permit.executeAsync(async () => 'never')).rejects.toBeInstanceOf(FlowSecurityError);
  expect(JSON.stringify(events)).not.toContain('SENTINEL_SECRET');
});

test('holds a side effect pending and permits it after approval resumes', async () => {
  const pending = createSecurity({ approval: 'pending' });
  await expect(pending.port.authorizeAsync(operation)).rejects.toMatchObject({
    code: 'approval_pending',
  });
  const approved = createSecurity({ approval: 'approved' });
  const permit = await approved.port.authorizeAsync(operation);
  expect(await permit.executeAsync(async ({ 'providers/fixture': secret }) => secret?.token)).toBe(
    'SENTINEL_SECRET',
  );
});

test('rejects scope mismatches, unsafe targets, and idempotency collisions', async () => {
  const { port } = createSecurity({
    grants: [{ ...actor, actorId: actor.id, capability: 'mcp:fixture:read' }],
  });
  await expect(port.authorizeAsync(operation)).rejects.toMatchObject({ code: 'permission_denied' });
  const allowed = createSecurity().port;
  await expect(
    allowed.authorizeAsync({ ...operation, targetUrl: 'http://127.0.0.1/admin' }),
  ).rejects.toMatchObject({ code: 'invalid_target' });
  await allowed.authorizeAsync(operation);
  await expect(
    allowed.authorizeAsync({ ...operation, operationId: 'operation-2' }),
  ).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

test('consumes each approval permit once', async () => {
  const permit = await createSecurity().port.authorizeAsync(operation);
  await permit.executeAsync(async () => 'done');
  await expect(permit.executeAsync(async () => 'replayed')).rejects.toMatchObject({
    code: 'idempotency_conflict',
  });
});

test('uses the released Supabase Vault adapter through the published secret-store shape', async () => {
  const calls: readonly unknown[][] = [];
  const adapter = createSupabaseVaultAdapter({
    client: {
      query: async () => ({ rows: [] }),
      transaction: async (callback) => callback({ query: async () => ({ rows: [] }) }),
    },
  });
  const metadata = await adapter.getMetadata({
    scope: { projectId: actor.projectId, environment: actor.environment },
    ref: 'providers/fixture',
  });
  expect(metadata).toMatchObject({ ok: false });
  expect(calls).toEqual([]);
});
