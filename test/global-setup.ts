import type { TestProject } from 'vitest/node';
import { WebSocketServer } from 'ws';

declare module 'vitest' {
  export interface ProvidedContext {
    wsBaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));

  server.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => {
      socket.send(data, { binary: isBinary });
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Unexpected server address');
  }
  project.provide('wsBaseUrl', `ws://127.0.0.1:${address.port}`);

  return () =>
    new Promise<void>((resolve, reject) => {
      for (const client of server.clients) {
        client.terminate();
      }
      server.close((error) => (error ? reject(error) : resolve()));
    });
}
