import fs from 'node:fs';

/**
 * Named places in a run's life where the backend can be made to fail.
 *
 * Tests arm a point in-process (armCrashPointForTests) to prove the
 * surrounding transaction leaves nothing half-written. The chaos harness arms
 * one through the environment instead:
 *
 *   LOXO_CRASH_AT=<point>[@<n>]        on the n-th hit (default 1), append a
 *                                      line to LOXO_CRASH_LOG and SIGKILL
 *                                      this process: no finally blocks, no
 *                                      exit hooks, like an outside kill -9.
 *   LOXO_STALL_AT=<point>[@<n>]=<ms>   on the n-th hit, block the event loop
 *                                      for <ms>, like a long GC pause.
 *
 * An unknown point name fails at import, so a typo cannot pass for a trial
 * that never crashed. An unarmed point costs one Map lookup.
 */
export const CRASH_POINTS = [
  'wake.before_start',
  'admission.after_claim',
  'run.after_before_ref',
  'run.after_spawn_before_pid_recorded',
  'control_plane.before_record',
  'control_plane.after_commit',
  'run.before_capture',
  'run.before_settle',
  'run.after_settle',
  'recovery.before_assess',
  'recovery.before_resolve',
  'decision.before_commit',
] as const;

export type CrashPoint = (typeof CRASH_POINTS)[number];

interface Fault {
  point: CrashPoint;
  hit: number;
  /** Set for a stall; a crash otherwise. */
  stallMs?: number;
}

const SPEC = /^([a-z_.]+)(?:@([1-9]\d{0,5}))?$/;

function parseFault(variable: string, value: string | undefined, withDuration: boolean): Fault | null {
  const raw = value?.trim();
  if (!raw) return null;
  let target = raw;
  let stallMs: number | undefined;
  if (withDuration) {
    const eq = raw.lastIndexOf('=');
    const ms = eq === -1 ? NaN : Number(raw.slice(eq + 1));
    if (!Number.isInteger(ms) || ms <= 0) throw new Error(`${variable} must end with =<milliseconds>: "${raw}"`);
    target = raw.slice(0, eq);
    stallMs = ms;
  }
  const match = SPEC.exec(target);
  if (!match) throw new Error(`${variable} must look like <point>[@<n>]: "${raw}"`);
  const point = match[1] as CrashPoint;
  if (!CRASH_POINTS.includes(point)) {
    throw new Error(`${variable} names an unknown crash point "${match[1]}"`);
  }
  return { point, hit: match[2] ? Number(match[2]) : 1, stallMs };
}

let crashAt: Fault | null = null;
let stallAt: Fault | null = null;
const hits = new Map<CrashPoint, number>();
const armed = new Map<CrashPoint, () => void>();

/** Replaces the armed faults with those `env` names and restarts hit counting; throws on a malformed value. */
export function armFaultsFromEnv(env: NodeJS.ProcessEnv): void {
  const crash = parseFault('LOXO_CRASH_AT', env.LOXO_CRASH_AT, false);
  const stall = parseFault('LOXO_STALL_AT', env.LOXO_STALL_AT, true);
  crashAt = crash;
  stallAt = stall;
  hits.clear();
}

armFaultsFromEnv(process.env);

export function crashPoint(name: CrashPoint): void {
  armed.get(name)?.();
  if (!crashAt && !stallAt) return;
  const hit = (hits.get(name) ?? 0) + 1;
  hits.set(name, hit);
  if (stallAt && stallAt.point === name && stallAt.hit === hit) {
    logFault({ point: name, hit, stallMs: stallAt.stallMs });
    blockFor(stallAt.stallMs!);
  }
  if (crashAt && crashAt.point === name && crashAt.hit === hit) {
    logFault({ point: name, hit });
    process.kill(process.pid, 'SIGKILL');
    // TerminateProcess on Windows may return before the process is gone.
    blockFor(Infinity);
  }
}

/** Describes the faults armed through the environment, for the start-up log. */
export function describeArmedFaults(): string | null {
  const parts = [
    crashAt && `crash at ${crashAt.point}@${crashAt.hit}`,
    stallAt && `stall ${stallAt.stallMs} ms at ${stallAt.point}@${stallAt.hit}`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
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

function logFault(fault: Fault): void {
  const file = process.env.LOXO_CRASH_LOG;
  if (!file) return;
  fs.appendFileSync(file, `${JSON.stringify({ ...fault, pid: process.pid, at: new Date().toISOString() })}\n`);
}

function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
