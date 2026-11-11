import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client';
import { agents, crewMembers, crews, type Crew } from '../../db/schema';
import { badRequest, notFound } from '../../http/errors';

/** Upper bound on roster size; larger crews multiply cost without adding review coverage. */
export const MAX_CREW_MEMBERS = 8;

export interface CrewView extends Crew {
  /** Members in roster order. */
  agentIds: string[];
}

async function loadRosters(crewIds: string[]): Promise<Map<string, string[]>> {
  const rosters = new Map<string, string[]>(crewIds.map((id) => [id, []]));
  if (crewIds.length === 0) return rosters;
  const rows = await db
    .select()
    .from(crewMembers)
    .where(inArray(crewMembers.crewId, crewIds))
    .orderBy(asc(crewMembers.position));
  for (const row of rows) rosters.get(row.crewId)?.push(row.agentId);
  return rosters;
}

async function findCrew(userId: string, crewId: string): Promise<Crew> {
  const [crew] = await db
    .select()
    .from(crews)
    .where(and(eq(crews.id, crewId), eq(crews.userId, userId)))
    .limit(1);
  if (!crew) throw notFound('Crew not found');
  return crew;
}

async function validateRoster(userId: string, agentIds: string[]): Promise<string[]> {
  const roster = [...new Set(agentIds)];
  if (roster.length !== agentIds.length) {
    throw badRequest('invalid_roster', 'An agent can appear in a crew only once');
  }
  if (roster.length === 0 || roster.length > MAX_CREW_MEMBERS) {
    throw badRequest('invalid_roster', `A crew needs between 1 and ${MAX_CREW_MEMBERS} agents`);
  }
  const owned = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, userId), inArray(agents.id, roster)));
  if (owned.length !== roster.length) {
    throw badRequest('invalid_roster', 'One or more agents do not exist');
  }
  return roster;
}

export async function listCrews(userId: string): Promise<CrewView[]> {
  const rows = await db
    .select()
    .from(crews)
    .where(eq(crews.userId, userId))
    .orderBy(asc(crews.createdAt));
  const rosters = await loadRosters(rows.map((r) => r.id));
  return rows.map((row) => ({ ...row, agentIds: rosters.get(row.id)! }));
}

export async function getCrew(userId: string, crewId: string): Promise<CrewView> {
  const crew = await findCrew(userId, crewId);
  const rosters = await loadRosters([crew.id]);
  return { ...crew, agentIds: rosters.get(crew.id)! };
}

export async function createCrew(
  userId: string,
  input: { name: string; description?: string; agentIds: string[] }
): Promise<CrewView> {
  const roster = await validateRoster(userId, input.agentIds);
  const crewId = await db.transaction(async (tx) => {
    const [crew] = await tx
      .insert(crews)
      .values({ userId, name: input.name, description: input.description ?? '' })
      .returning({ id: crews.id });
    await tx
      .insert(crewMembers)
      .values(roster.map((agentId, position) => ({ crewId: crew!.id, agentId, position })));
    return crew!.id;
  });
  return getCrew(userId, crewId);
}

/** A supplied roster replaces the existing one wholesale, keeping positions dense. */
export async function updateCrew(
  userId: string,
  crewId: string,
  input: { name?: string; description?: string; agentIds?: string[] }
): Promise<CrewView> {
  await findCrew(userId, crewId);
  const roster = input.agentIds ? await validateRoster(userId, input.agentIds) : null;
  await db.transaction(async (tx) => {
    await tx
      .update(crews)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: new Date(),
      })
      .where(eq(crews.id, crewId));
    if (roster) {
      await tx.delete(crewMembers).where(eq(crewMembers.crewId, crewId));
      await tx
        .insert(crewMembers)
        .values(roster.map((agentId, position) => ({ crewId, agentId, position })));
    }
  });
  return getCrew(userId, crewId);
}

export async function deleteCrew(userId: string, crewId: string): Promise<void> {
  const deleted = await db
    .delete(crews)
    .where(and(eq(crews.id, crewId), eq(crews.userId, userId)))
    .returning({ id: crews.id });
  if (deleted.length === 0) throw notFound('Crew not found');
}
