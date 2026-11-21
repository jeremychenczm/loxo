import { createServer } from 'node:http';
import { assertRequiredEnv, config } from './config';
import { closeDb } from './db/client';
import { describeArmedFaults } from './modules/ownership/crash-points';
import { runLeases } from './modules/ownership/lease';
import { startReconciler } from './modules/ownership/reconciler';
import { handOffActiveRuns } from './modules/runs/wake';
import { configureEgressProxy } from './http/egress-proxy';
import { createApp } from './http/app';
import { attachWsGateway } from './ws/gateway';

assertRequiredEnv();
configureEgressProxy();

const faults = describeArmedFaults();
if (faults) console.warn(`Fault injection armed: ${faults}`);

const app = createApp();
const server = createServer(app);
const gateway = attachWsGateway(server);

server.listen(config.port, () => {
  console.log(`Loxo backend listening on http://localhost:${config.port}`);
});

// Takes over runs whose owner died (this process included) and promotes waiting runs.
const stopReconciler = startReconciler(runLeases);

let shuttingDown = false;

/**
 * Graceful shutdown: stop starting runs, hand off the ones in flight (see
 * handOffActiveRuns), then close connections. HTTP stays open until the
 * handoffs are done, since agents reach the control plane through it. Past
 * the budget the process exits anyway, and runs it still held are recovered
 * by another instance once their leases lapse.
 */
async function shutdown(trigger: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${trigger}, handing off runs and shutting down`);

  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out, exiting');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    runLeases.drain();
    await stopReconciler();
    await handOffActiveRuns();
    await gateway.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runLeases.stop();
    await closeDb();
    process.exit(0);
  } catch (error) {
    console.error('Shutdown error:', error);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
// A parent process can ask for the same shutdown over IPC; on Windows a
// signal from outside cannot be caught, it simply ends the process.
process.on('message', (message) => {
  if ((message as { type?: unknown } | null)?.type === 'shutdown') void shutdown('a shutdown message');
});
