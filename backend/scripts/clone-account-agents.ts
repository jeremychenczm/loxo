/**
 * Dev utility: clone one account's agents (rows + on-disk dirs) and the
 * providers they reference onto another account.
 *
 *   npx tsx scripts/clone-account-agents.ts <source-email> <target-email>
 *
 * Group links are dropped.
 */
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client';
import { agents, providers, users } from '../src/db/schema';
import { storage } from '../src/storage/layout';

async function findUser(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new Error(`No user with email ${email}`);
  return user;
}

async function main() {
  const [sourceEmail, targetEmail] = process.argv.slice(2);
  if (!sourceEmail || !targetEmail) {
    throw new Error('Usage: tsx scripts/clone-account-agents.ts <source-email> <target-email>');
  }
  const source = await findUser(sourceEmail);
  const target = await findUser(targetEmail);

  const providerMap = new Map<string, string>();
  const sourceProviders = await db.select().from(providers).where(eq(providers.userId, source.id));
  for (const p of sourceProviders) {
    const [existing] = await db
      .select()
      .from(providers)
      .where(
        and(eq(providers.userId, target.id), eq(providers.name, p.name), eq(providers.vendor, p.vendor))
      )
      .limit(1);
    if (existing) {
      providerMap.set(p.id, existing.id);
      console.log(`provider "${p.name}" (${p.vendor}) already present`);
      continue;
    }
    const [clone] = await db
      .insert(providers)
      .values({
        userId: target.id,
        name: p.name,
        vendor: p.vendor,
        apiKeyEncrypted: p.apiKeyEncrypted,
        baseUrl: p.baseUrl,
        models: p.models,
        isDefault: p.isDefault,
      })
      .returning();
    providerMap.set(p.id, clone!.id);
    console.log(`provider "${p.name}" (${p.vendor}) cloned`);
  }

  const sourceAgents = await db.select().from(agents).where(eq(agents.userId, source.id));
  for (const a of sourceAgents) {
    const [duplicate] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, target.id), eq(agents.name, a.name)))
      .limit(1);
    if (duplicate) {
      console.log(`agent "${a.name}" already present, skipped`);
      continue;
    }
    const [clone] = await db
      .insert(agents)
      .values({
        userId: target.id,
        name: a.name,
        description: a.description,
        runtime: a.runtime,
        manifest: a.manifest,
        tags: a.tags,
        providerId: a.providerId ? (providerMap.get(a.providerId) ?? null) : null,
        model: a.model,
        avatarFile: a.avatarFile,
        status: 'idle',
        execution: a.execution,
      })
      .returning();

    const from = storage.agentPaths(source.id, a.id);
    const to = storage.agentPaths(target.id, clone!.id);
    fs.cpSync(from.root, to.root, { recursive: true, force: true });
    console.log(`agent "${a.name}" cloned (${a.runtime})`);
  }

  console.log('Done.');
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
