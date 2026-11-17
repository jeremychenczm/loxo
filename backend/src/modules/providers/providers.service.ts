import { and, eq, ne } from 'drizzle-orm';
import { db } from '../../db/client';
import { providers, type Provider } from '../../db/schema';
import { openSecret, sealSecret } from '../../crypto/secretbox';
import { notFound } from '../../http/errors';

export const PROVIDER_VENDORS = ['anthropic', 'openai'] as const;
export type ProviderVendor = (typeof PROVIDER_VENDORS)[number];

/** API shape: key is never returned, only a short prefix for identification. */
export interface ProviderView {
  id: string;
  name: string;
  vendor: string;
  apiKeyPrefix: string;
  baseUrl: string | null;
  models: string[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toView(row: Provider): ProviderView {
  const apiKey = openSecret(row.apiKeyEncrypted);
  return {
    id: row.id,
    name: row.name,
    vendor: row.vendor,
    apiKeyPrefix: apiKey.slice(0, 8) + '…',
    baseUrl: row.baseUrl,
    models: row.models,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface UpsertProviderInput {
  name: string;
  vendor: ProviderVendor;
  apiKey?: string;
  baseUrl?: string | null;
  models?: string[];
  isDefault?: boolean;
}

export async function listProviders(userId: string): Promise<ProviderView[]> {
  const rows = await db.select().from(providers).where(eq(providers.userId, userId));
  return rows.map(toView);
}

export async function createProvider(
  userId: string,
  input: UpsertProviderInput & { apiKey: string }
): Promise<ProviderView> {
  const [row] = await db
    .insert(providers)
    .values({
      userId,
      name: input.name,
      vendor: input.vendor,
      apiKeyEncrypted: sealSecret(input.apiKey),
      baseUrl: input.baseUrl ?? null,
      models: input.models ?? [],
      isDefault: input.isDefault ?? false,
    })
    .returning();
  if (input.isDefault) {
    await clearOtherDefaults(userId, row!.id, input.vendor);
  }
  return toView(row!);
}

export async function updateProvider(
  userId: string,
  providerId: string,
  input: Partial<UpsertProviderInput>
): Promise<ProviderView> {
  const [existing] = await db
    .select()
    .from(providers)
    .where(and(eq(providers.id, providerId), eq(providers.userId, userId)))
    .limit(1);
  if (!existing) throw notFound('Provider not found');

  const [updated] = await db
    .update(providers)
    .set({
      name: input.name ?? existing.name,
      vendor: input.vendor ?? existing.vendor,
      apiKeyEncrypted: input.apiKey ? sealSecret(input.apiKey) : existing.apiKeyEncrypted,
      baseUrl: input.baseUrl !== undefined ? input.baseUrl : existing.baseUrl,
      models: input.models ?? existing.models,
      isDefault: input.isDefault ?? existing.isDefault,
      updatedAt: new Date(),
    })
    .where(eq(providers.id, providerId))
    .returning();

  if (input.isDefault) {
    await clearOtherDefaults(userId, providerId, updated!.vendor);
  }
  return toView(updated!);
}

export async function deleteProvider(userId: string, providerId: string): Promise<void> {
  const result = await db
    .delete(providers)
    .where(and(eq(providers.id, providerId), eq(providers.userId, userId)))
    .returning({ id: providers.id });
  if (result.length === 0) throw notFound('Provider not found');
}

/** Internal use only (runner, health checks): includes the decrypted key. */
export async function getProviderCredentials(
  userId: string,
  providerId: string
): Promise<{ vendor: string; apiKey: string; baseUrl: string | null; models: string[] } | null> {
  const [row] = await db
    .select()
    .from(providers)
    .where(and(eq(providers.id, providerId), eq(providers.userId, userId)))
    .limit(1);
  if (!row) return null;
  return {
    vendor: row.vendor,
    apiKey: openSecret(row.apiKeyEncrypted),
    baseUrl: row.baseUrl,
    models: row.models,
  };
}

async function clearOtherDefaults(userId: string, keepId: string, vendor: string): Promise<void> {
  await db
    .update(providers)
    .set({ isDefault: false })
    .where(
      and(eq(providers.userId, userId), eq(providers.vendor, vendor), ne(providers.id, keepId))
    );
}
