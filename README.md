# WebSocket Metrics

A small library that wraps the browser's `WebSocket` and measures the bytes and messages of its application payloads, in total and per group of WebSocket URLs.

**This library is browser-only.** It targets the Window context and uses `WebSocket`, `requestAnimationFrame`, `TextEncoder` and `Blob` directly. Node.js and Workers are not supported. It is published as ESM only and targets ES2022 JavaScript environments.

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

### `createWebSocketMetrics(options?)`

By default, metrics are grouped by the whole `WebSocket.url` of each socket, with no further normalization. Pass `groupBy` to choose the key yourself:

```ts
const { WebSocket: MetricsWebSocket, metrics } = createWebSocketMetrics({
  groupBy(url) {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  },
});
```

`groupBy` receives `WebSocket.url` as exposed by the native socket, which is the URL serialized by the browser rather than the string passed to the constructor. It is called once per socket, when the socket is constructed. It must return a string. If it throws, the socket is closed and the error is rethrown from the constructor. If it returns anything else, the socket is closed and the constructor throws a `TypeError`. Sockets whose URLs map to the same key are summed together.

If your URLs contain secrets such as tokens, or query parameters that vary per connection such as session IDs, use `groupBy` to map them to a stable key. Otherwise these values become snapshot keys, and every distinct URL adds an entry that is kept for the lifetime of the metrics.

### `metrics.getSnapshot()`

Returns the metrics as of the call. Counters are updated as soon as traffic happens, without waiting for an animation frame, so the result is always current. The returned snapshot is immutable and never changes afterwards. `total` is derived from `byKey`, so both always agree.

### `metrics.subscribe(listener)`

Calls `listener` immediately with the current snapshot, then again after the metrics change. Notifications are batched with `requestAnimationFrame`, so `listener` is called at most once per animation frame and all subscribers of one notification receive the same snapshot object. Nothing is scheduled while there are no subscribers.

Because notifications follow animation frames, browsers may pause or throttle them while the page is in the background or not rendered. Counting is not affected, and `getSnapshot()` still returns the latest values.

Returns a function that unsubscribes the listener.

> [!NOTE]
> Sending metrics through a measured socket from inside `listener` changes the metrics, which triggers another notification on the next frame, and so on. The library does not prevent this loop. To report metrics, send them through a transport that is not measured, such as the native `WebSocket` or `fetch()`, or make sure the reporting does not feed back into the notifications.

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
  readonly byKey: Readonly<Record<string, WebSocketTrafficMetrics>>;
}

type WebSocketMetricsListener = (snapshot: WebSocketMetricsSnapshot) => void;

interface WebSocketMetrics {
  getSnapshot(): WebSocketMetricsSnapshot;
  subscribe(listener: WebSocketMetricsListener): () => void;
}

interface CreateWebSocketMetricsOptions {
  readonly groupBy?: (url: string) => string;
}

interface CreateWebSocketMetricsResult {
  readonly WebSocket: typeof WebSocket;
  readonly metrics: WebSocketMetrics;
}

function createWebSocketMetrics(
  options?: CreateWebSocketMetricsOptions,
): CreateWebSocketMetricsResult;
```

`byKey` is an ordinary object (not a `Map`) keyed by the grouping key, so a snapshot can be passed to `JSON.stringify()` as is. A key appears once a socket in its group has sent or received a message. Keys such as `__proto__` or `constructor` are stored as own properties like any other key.

## What is measured

- **Bytes** are the size of the WebSocket application payload: the UTF-8 byte length for strings, and the byte length for `Blob`, `ArrayBuffer` and ArrayBuffer views. WebSocket frame headers, TLS, TCP/IP and handshake overhead are not included.
- **Sent messages** are counted only when the socket is `OPEN` and the native `send()` returns without throwing.
- **Received messages** are counted for every `message` event the browser fires, whether or not your code listens for it.

Only totals are kept. Payloads are neither stored nor parsed.

## Not measured

This version does not measure connections, open/close/error/reconnect counts, latency, connection duration, throughput or size distributions.
