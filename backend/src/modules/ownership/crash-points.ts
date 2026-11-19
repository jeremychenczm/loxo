/**
 * Named places where a test can make the backend fail mid-operation, to prove
 * the surrounding transaction leaves nothing half-written. An unarmed point
 * costs one Map lookup.
 */
export type CrashPoint =
  | 'admission.after_claim'
  | 'run.after_before_ref'
  | 'run.after_spawn_before_pid_recorded'
  | 'recovery.before_assess'
  | 'recovery.before_resolve'
  | 'run.before_capture'
  | 'control_plane.before_record'
  | 'wake.before_start';

const armed = new Map<CrashPoint, () => void>();

export function crashPoint(name: CrashPoint): void {
  armed.get(name)?.();
}

/** Runs `action` (by default: throw) at `name` until the returned function disarms it. */
export function armCrashPointForTests(
  name: CrashPoint,
  action: () => void = () => {
    throw new Error(`crash point ${name}`);
  }
): () => void {
  armed.set(name, action);
  return () => armed.delete(name);
}
