import { randomBytes } from 'node:crypto';
import os from 'node:os';

/** This backend process as recorded in runs.owner_instance; unique per start. */
export const instanceId = `${os.hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
