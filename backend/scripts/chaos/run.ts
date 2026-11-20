import { parseArgs } from 'node:util';
import { CRASH_POINTS, type CrashPoint } from '../../src/modules/ownership/crash-points';
import { prepareTemplate } from './harness';
import { RUN_KINDS, type RunKind } from './scenarios';
import { runTrial, type NamedFault, type TrialSpec } from './trial';

/**
 * Chaos driver. Needs the chaos Postgres: `docker compose --profile chaos up -d --wait`.
 *
 *   npm run chaos -w backend -- --kind read --first run.before_settle
 *   npm run chaos -w backend -- --kind edit-dirty --first run.before_settle --second decision.before_commit --answer discard
 *   npm run chaos -w backend -- --kind read --first random --no-launcher
 */

function namedFault(value: string): NamedFault {
  const [point, hit] = value.split('@');
  if (!CRASH_POINTS.includes(point as CrashPoint)) {
    throw new Error(`Unknown crash point "${point}"; one of: ${CRASH_POINTS.join(', ')}`);
  }
  return { point: point as CrashPoint, ...(hit ? { hit: Number(hit) } : {}) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      kind: { type: 'string' },
      first: { type: 'string' },
      second: { type: 'string' },
      answer: { type: 'string' },
      seed: { type: 'string' },
      'no-launcher': { type: 'boolean' },
      failures: { type: 'string' },
    },
  });
  const kind = values.kind as RunKind | undefined;
  if (!kind || !RUN_KINDS.includes(kind)) throw new Error(`--kind is one of: ${RUN_KINDS.join(', ')}`);
  if (!values.first) throw new Error('--first is a crash point or "random"');
  if (values.answer && !['continue', 'discard', 'stop'].includes(values.answer)) {
    throw new Error('--answer is continue, discard, or stop');
  }
  const spec: TrialSpec = {
    kind,
    first: values.first === 'random' ? 'random' : namedFault(values.first),
    ...(values.second ? { second: namedFault(values.second) } : {}),
    ...(values.answer ? { answer: values.answer as TrialSpec['answer'] } : {}),
    ...(values['no-launcher'] ? { launcher: false } : {}),
    seed: values.seed ? Number(values.seed) : Date.now() % 1_000_000,
  };

  await prepareTemplate();
  const result = await runTrial(spec, { failuresDir: values.failures });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.error || result.violations.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
