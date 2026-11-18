/**
 * Named places where a test can make the backend fail mid-operation, to prove
 * the surrounding transaction leaves nothing half-written. An unarmed point
 * costs one Map lookup.
 */
export type CrashPoint = 'admission.after_claim';

const armed = new Map<CrashPoint, () => void>();

export function crashPoint(name: CrashPoint): void {
  armed.get(name)?.();
}

/** Makes `name` throw until the returned function disarms it. */
export function armCrashPointForTests(name: CrashPoint): () => void {
  armed.set(name, () => {
    throw new Error(`crash point ${name}`);
  });
  return () => armed.delete(name);
}
