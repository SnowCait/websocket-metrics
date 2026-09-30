export interface WebSocketDirectionMetrics {
  readonly bytes: number;
  readonly messages: number;
}

export interface WebSocketTrafficMetrics {
  readonly sent: WebSocketDirectionMetrics;
  readonly received: WebSocketDirectionMetrics;
}

export interface WebSocketMetricsSnapshot {
  readonly total: WebSocketTrafficMetrics;
  readonly byKey: Readonly<Record<string, WebSocketTrafficMetrics>>;
}

export type WebSocketMetricsListener = (
  snapshot: WebSocketMetricsSnapshot,
) => void;

export interface WebSocketMetrics {
  getSnapshot(): WebSocketMetricsSnapshot;

  subscribe(listener: WebSocketMetricsListener): () => void;
}

export interface CreateWebSocketMetricsOptions {
  readonly groupBy?: (url: string) => string;
}

export interface CreateWebSocketMetricsResult {
  readonly WebSocket: typeof WebSocket;
  readonly metrics: WebSocketMetrics;
}

interface MutableDirectionMetrics {
  bytes: number;
  messages: number;
}

interface MutableTrafficMetrics {
  sent: MutableDirectionMetrics;
  received: MutableDirectionMetrics;
}

interface Subscription {
  readonly listener: WebSocketMetricsListener;
  lastNotified: WebSocketMetricsSnapshot | undefined;
}

type Payload = Parameters<WebSocket['send']>[0];

const createTraffic = (): MutableTrafficMetrics => ({
  sent: { bytes: 0, messages: 0 },
  received: { bytes: 0, messages: 0 },
});

const freezeTraffic = (
  traffic: MutableTrafficMetrics,
): WebSocketTrafficMetrics =>
  Object.freeze({
    sent: Object.freeze({ ...traffic.sent }),
    received: Object.freeze({ ...traffic.received }),
  });

const createSnapshot = (
  trafficByKey: ReadonlyMap<string, MutableTrafficMetrics>,
): WebSocketMetricsSnapshot => {
  const total = createTraffic();
  const entries: [string, WebSocketTrafficMetrics][] = [];

  for (const [key, traffic] of trafficByKey) {
    entries.push([key, freezeTraffic(traffic)]);
    total.sent.bytes += traffic.sent.bytes;
    total.sent.messages += traffic.sent.messages;
    total.received.bytes += traffic.received.bytes;
    total.received.messages += traffic.received.messages;
  }

  return Object.freeze({
    total: freezeTraffic(total),
    // Object.fromEntries() defines own data properties, so keys such as
    // "__proto__" never touch the prototype.
    byKey: Object.freeze(Object.fromEntries(entries)),
  });
};

export function createWebSocketMetrics(
  options: CreateWebSocketMetricsOptions = {},
): CreateWebSocketMetricsResult {
  const groupBy = options.groupBy ?? ((url: string) => url);
  const trafficByKey = new Map<string, MutableTrafficMetrics>();
  const subscriptions = new Set<Subscription>();
  const encoder = new TextEncoder();
  const scratch = new Uint8Array(4096);

  let snapshot: WebSocketMetricsSnapshot | undefined;
  let frameId: number | undefined;

  // Reuses a bounded encoding buffer to avoid allocating a full encoded copy.
  const utf8ByteLength = (text: string): number => {
    let bytes = 0;
    for (let offset = 0; offset < text.length;) {
      const { read, written } = encoder.encodeInto(
        offset === 0 ? text : text.slice(offset),
        scratch,
      );
      offset += read;
      bytes += written;
    }
    return bytes;
  };

  const payloadBytes = (payload: Payload): number => {
    if (typeof payload === 'string') {
      return utf8ByteLength(payload);
    }
    return 'size' in payload ? payload.size : payload.byteLength;
  };

  const getSnapshot = (): WebSocketMetricsSnapshot =>
    (snapshot ??= createSnapshot(trafficByKey));

  const notify = (
    subscription: Subscription,
    current: WebSocketMetricsSnapshot,
  ) => {
    subscription.lastNotified = current;
    try {
      subscription.listener(current);
    } catch (error) {
      reportError(error);
    }
  };

  const flush = () => {
    frameId = undefined;
    const current = getSnapshot();
    for (const subscription of subscriptions) {
      if (subscription.lastNotified !== current) {
        notify(subscription, current);
      }
    }
  };

  const record = (
    key: string,
    direction: keyof MutableTrafficMetrics,
    payload: Payload,
  ) => {
    const bytes = payloadBytes(payload);
    let traffic = trafficByKey.get(key);
    if (traffic === undefined) {
      traffic = createTraffic();
      trafficByKey.set(key, traffic);
    }
    traffic[direction].bytes += bytes;
    traffic[direction].messages += 1;

    snapshot = undefined;
    if (subscriptions.size > 0 && frameId === undefined) {
      frameId = requestAnimationFrame(flush);
    }
  };

  const metrics: WebSocketMetrics = {
    getSnapshot,

    subscribe(listener) {
      const subscription: Subscription = { listener, lastNotified: undefined };
      subscriptions.add(subscription);
      notify(subscription, getSnapshot());

      return () => {
        subscriptions.delete(subscription);
        if (subscriptions.size === 0 && frameId !== undefined) {
          cancelAnimationFrame(frameId);
          frameId = undefined;
        }
      };
    },
  };

  class MetricsWebSocket extends WebSocket {
    readonly #groupKey: string;

    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      try {
        this.#groupKey = groupBy(this.url);
      } catch (error) {
        // The caller never receives this socket, so it must not stay open.
        // close() without arguments does not throw.
        this.close();
        throw error;
      }
      this.addEventListener('message', (event) => {
        record(this.#groupKey, 'received', event.data);
      });
    }

    override send(data: Payload): void {
      const wasOpen = this.readyState === WebSocket.OPEN;
      super.send(data);
      if (wasOpen) {
        record(this.#groupKey, 'sent', data);
      }
    }
  }

  return { WebSocket: MetricsWebSocket, metrics };
}
