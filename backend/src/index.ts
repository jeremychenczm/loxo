import { createServer } from 'node:http';
import { assertRequiredEnv, config } from './config';
import { closeDb } from './db/client';
import { configureEgressProxy } from './http/egress-proxy';
import { createApp } from './http/app';
import { attachWsGateway } from './ws/gateway';

assertRequiredEnv();
configureEgressProxy();

const app = createApp();
const server = createServer(app);
const gateway = attachWsGateway(server);

server.listen(config.port, () => {
  console.log(`Loxo backend listening on http://localhost:${config.port}`);
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down`);

  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out, exiting');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await gateway.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb();
    process.exit(0);
  } catch (error) {
    console.error('Shutdown error:', error);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
