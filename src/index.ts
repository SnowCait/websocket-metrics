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
  readonly byUrl: ReadonlyMap<string, WebSocketTrafficMetrics>;
}

export type WebSocketMetricsListener = (
  snapshot: WebSocketMetricsSnapshot,
) => void;

export interface WebSocketMetrics {
  getSnapshot(): WebSocketMetricsSnapshot;

  subscribe(listener: WebSocketMetricsListener): () => void;
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

class ReadonlyTrafficMap extends Map<string, WebSocketTrafficMetrics> {
  constructor(entries: Iterable<readonly [string, WebSocketTrafficMetrics]>) {
    super(entries);
    Object.freeze(this);
  }

  override set(url: string, traffic: WebSocketTrafficMetrics): this {
    this.assertMutable();
    return super.set(url, traffic);
  }

  override delete(url: string): boolean {
    this.assertMutable();
    return super.delete(url);
  }

  override clear(): void {
    this.assertMutable();
    super.clear();
  }

  // The map is frozen right after construction, which ends the mutable phase.
  private assertMutable(): void {
    if (Object.isFrozen(this)) {
      throw new TypeError('WebSocket metrics snapshots are read-only');
    }
  }
}

const createSnapshot = (
  trafficByUrl: ReadonlyMap<string, MutableTrafficMetrics>,
): WebSocketMetricsSnapshot => {
  const total = createTraffic();
  const entries: [string, WebSocketTrafficMetrics][] = [];

  for (const [url, traffic] of trafficByUrl) {
    entries.push([url, freezeTraffic(traffic)]);
    total.sent.bytes += traffic.sent.bytes;
    total.sent.messages += traffic.sent.messages;
    total.received.bytes += traffic.received.bytes;
    total.received.messages += traffic.received.messages;
  }

  return Object.freeze({
    total: freezeTraffic(total),
    byUrl: new ReadonlyTrafficMap(entries),
  });
};

export function createWebSocketMetrics(): CreateWebSocketMetricsResult {
  const trafficByUrl = new Map<string, MutableTrafficMetrics>();
  const subscriptions = new Set<Subscription>();
  const encoder = new TextEncoder();
  const scratch = new Uint8Array(4096);

  let snapshot: WebSocketMetricsSnapshot | undefined;
  let frameId: number | undefined;

  // Encodes into a reusable buffer in chunks so no per-message copy is made.
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
    (snapshot ??= createSnapshot(trafficByUrl));

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
    url: string,
    direction: keyof MutableTrafficMetrics,
    payload: Payload,
  ) => {
    const bytes = payloadBytes(payload);
    let traffic = trafficByUrl.get(url);
    if (traffic === undefined) {
      traffic = createTraffic();
      trafficByUrl.set(url, traffic);
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
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', (event) => {
        record(this.url, 'received', event.data);
      });
    }

    override send(data: Payload): void {
      const wasOpen = this.readyState === WebSocket.OPEN;
      super.send(data);
      if (wasOpen) {
        record(this.url, 'sent', data);
      }
    }
  }

  return { WebSocket: MetricsWebSocket, metrics };
}
