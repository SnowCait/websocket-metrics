# websocket-metrics

A small library that wraps the browser's `WebSocket` and measures the bytes and messages of its application payloads, in total and per WebSocket URL.

**This library is browser-only.** It targets the Window context and uses `WebSocket`, `requestAnimationFrame`, `TextEncoder` and `Blob` directly. Node.js and Workers are not supported. It is published as ESM only.

## Installation

```sh
npm install websocket-metrics
```

## Usage

```ts
import { createWebSocketMetrics } from 'websocket-metrics';

const { WebSocket: MetricsWebSocket, metrics } = createWebSocketMetrics();

const socket = new MetricsWebSocket('wss://example.com');

socket.addEventListener('open', () => {
  socket.send('hello');

  const snapshot = metrics.getSnapshot();
  console.log(snapshot.total.sent.bytes);
});

const unsubscribe = metrics.subscribe((snapshot) => {
  console.log(snapshot.total.received.bytes);
});
```

`MetricsWebSocket` extends the native `WebSocket` and can be used in its place. The global `WebSocket` is not modified, so only sockets created through `MetricsWebSocket` are measured. Events and payloads are passed to your application unchanged.

### `metrics.getSnapshot()`

Returns the metrics as of the call. Counters are updated as soon as traffic happens, so the result is always current. The returned snapshot is immutable and never changes afterwards. `total` is derived from `byUrl`, so both always agree.

### `metrics.subscribe(listener)`

Calls `listener` immediately with the current snapshot, then again after the metrics change. Notifications are batched with `requestAnimationFrame`, so `listener` is called at most once per animation frame and all subscribers of one notification receive the same snapshot object. Nothing is scheduled while there are no subscribers.

Returns a function that unsubscribes the listener.

## Types

```ts
interface WebSocketDirectionMetrics {
  readonly bytes: number;
  readonly messages: number;
}

interface WebSocketTrafficMetrics {
  readonly sent: WebSocketDirectionMetrics;
  readonly received: WebSocketDirectionMetrics;
}

interface WebSocketMetricsSnapshot {
  readonly total: WebSocketTrafficMetrics;
  readonly byUrl: ReadonlyMap<string, WebSocketTrafficMetrics>;
}

type WebSocketMetricsListener = (snapshot: WebSocketMetricsSnapshot) => void;

interface WebSocketMetrics {
  getSnapshot(): WebSocketMetricsSnapshot;
  subscribe(listener: WebSocketMetricsListener): () => void;
}
```

`byUrl` is keyed by `WebSocket.url` as exposed by the socket (no extra normalization). Sockets with the same URL are summed together, and a URL appears once it has sent or received a message.

## What is measured

- **Bytes** are the size of the WebSocket application payload: the UTF-8 byte length for strings, and the byte length for `Blob`, `ArrayBuffer` and ArrayBuffer views. WebSocket frame headers, TLS, TCP/IP and handshake overhead are not included.
- **Sent messages** are counted only when the socket is `OPEN` and the native `send()` returns without throwing.
- **Received messages** are counted for every `message` event the browser fires, whether or not your code listens for it.

Only totals are kept. Payloads are neither stored nor parsed.

## Not measured

This version does not measure connections, open/close/error/reconnect counts, latency, connection duration, throughput or size distributions.
