import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyToken } from '../modules/auth/tokens';
import { handleChatFrame } from './chat-channel';

export interface WsGateway {
  wss: WebSocketServer;
  shutdown: () => Promise<void>;
}

const WS_PATH = '/ws';
const HEARTBEAT_INTERVAL_MS = 30_000;

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
  userId?: string;
}

/**
 * Attaches the WebSocket endpoint to the HTTP server via upgrade so REST and
 * realtime traffic share one port.
 */
export function attachWsGateway(server: Server): WsGateway {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    const token = url.searchParams.get('token') ?? '';

    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const claims = verifyToken(token);
    if (!claims) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as TrackedSocket).userId = claims.sub;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: TrackedSocket) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      let message: { type?: string; payload?: Record<string, unknown> };
      try {
        message = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', payload: { code: 'invalid_frame' } }));
        return;
      }
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (typeof message.type === 'string' && message.type.startsWith('chat.')) {
        void handleChatFrame(ws, ws.userId!, { type: message.type, payload: message.payload });
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const tracked = client as TrackedSocket;
      if (tracked.isAlive === false) {
        tracked.terminate();
        continue;
      }
      tracked.isAlive = false;
      tracked.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  const shutdown = async (): Promise<void> => {
    clearInterval(heartbeat);
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  return { wss, shutdown };
}
