import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import { createWebSocketMetrics } from '../src/index.js';
import type {
  CreateWebSocketMetricsOptions,
  WebSocketMetricsSnapshot,
} from '../src/index.js';

const baseUrl = inject('wsBaseUrl');
const NativeWebSocket = globalThis.WebSocket;

const sockets: WebSocket[] = [];

const setup = (options?: CreateWebSocketMetricsOptions) => {
  const { WebSocket: MetricsWebSocket, metrics } =
    createWebSocketMetrics(options);

  const create = (path = '/', protocols?: string | string[]) => {
    const socket = new MetricsWebSocket(`${baseUrl}${path}`, protocols);
    sockets.push(socket);
    return socket;
  };

  const connect = async (path = '/', protocols?: string | string[]) => {
    const socket = create(path, protocols);
    await once(socket, 'open');
    return socket;
  };

  return { MetricsWebSocket, metrics, create, connect };
};

const once = (socket: WebSocket, type: 'open' | 'close') =>
  new Promise<void>((resolve) =>
    socket.addEventListener(type, () => resolve(), { once: true }),
  );

const manualAnimationFrames = () => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const request = vi.fn((callback: FrameRequestCallback) => {
    callbacks.set(nextId, callback);
    return nextId++;
  });
  const cancel = vi.fn((id: number) => {
    callbacks.delete(id);
  });
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);

  return {
    request,
    cancel,
    runFrame() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(performance.now()));
    },
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
});

describe('snapshot', () => {
  it('starts with all zeros and no keys', () => {
    const { metrics } = setup();

    const snapshot = metrics.getSnapshot();

    expect(snapshot.total).toEqual({
      sent: { bytes: 0, messages: 0 },
      received: { bytes: 0, messages: 0 },
    });
    expect(snapshot.byKey).toEqual({});
  });

  it('returns the latest values without waiting for a notification flush', async () => {
    const { metrics, connect } = setup();
    const frames = manualAnimationFrames();
    metrics.subscribe(() => {});
    const socket = await connect();

    socket.send('abc');

    expect(frames.request).toHaveBeenCalled();
    expect(metrics.getSnapshot().total.sent).toEqual({ bytes: 3, messages: 1 });
  });

  it('does not change a snapshot that was already returned', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();

    socket.send('abc');
    const before = metrics.getSnapshot();
    socket.send('defg');
    const after = metrics.getSnapshot();

    expect(before.total.sent).toEqual({ bytes: 3, messages: 1 });
    expect(before.byKey[socket.url]?.sent).toEqual({
      bytes: 3,
      messages: 1,
    });
    expect(after.total.sent).toEqual({ bytes: 7, messages: 2 });
  });

  it('keeps internal metrics intact when a snapshot is tampered with', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();
    socket.send('abc');

    const snapshot = metrics.getSnapshot();
    expect(() => {
      (snapshot.total.sent as { bytes: number }).bytes = 999;
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.byKey[socket.url]?.sent as { bytes: number }).bytes = 999;
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.byKey as Record<string, unknown>)['ws://other/'] = {};
    }).toThrow(TypeError);
    expect(() => {
      delete (snapshot.byKey as Record<string, unknown>)[socket.url];
    }).toThrow(TypeError);

    const next = metrics.getSnapshot();
    expect(next.total.sent).toEqual({ bytes: 3, messages: 1 });
    expect(next.byKey).toEqual({
      [socket.url]: {
        sent: { bytes: 3, messages: 1 },
        received: { bytes: 0, messages: 0 },
      },
    });
  });

  it('exposes byKey as an ordinary object that keeps every key in JSON', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();

    socket.send('abc');
    await vi.waitFor(() =>
      expect(metrics.getSnapshot().total.received.messages).toBe(1),
    );
    const snapshot = metrics.getSnapshot();

    const traffic = {
      sent: { bytes: 3, messages: 1 },
      received: { bytes: 3, messages: 1 },
    };
    expect(Object.getPrototypeOf(snapshot.byKey)).toBe(Object.prototype);
    expect(Object.keys(snapshot.byKey)).toEqual([socket.url]);
    expect(snapshot.byKey[socket.url]).toEqual(traffic);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual({
      total: traffic,
      byKey: { [socket.url]: traffic },
    });
  });
});

describe('sent metrics', () => {
  it('counts a string message', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();

    socket.send('hello');

    expect(metrics.getSnapshot().total.sent).toEqual({
      bytes: 5,
      messages: 1,
    });
  });

  it('counts UTF-8 bytes rather than string length', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();
    const text = 'aé日😀';

    socket.send(text);

    expect(text.length).toBe(5);
    expect(metrics.getSnapshot().total.sent.bytes).toBe(1 + 2 + 3 + 4);
  });

  it('counts strings longer than the internal encoding buffer', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();

    socket.send('a😀'.repeat(5000));

    expect(metrics.getSnapshot().total.sent).toEqual({
      bytes: 5000 * 5,
      messages: 1,
    });
  });

  it('counts a Blob', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();

    socket.send(new Blob(['あい', new Uint8Array(4)]));

    expect(metrics.getSnapshot().total.sent).toEqual({
      bytes: 6 + 4,
      messages: 1,
    });
  });

  it('counts a Blob created in another realm', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();
    const frame = document.body.appendChild(document.createElement('iframe'));

    try {
      const frameWindow = frame.contentWindow as Window & typeof globalThis;
      const foreignBlob = new frameWindow.Blob(['あい', new Uint8Array(4)]);
      expect(foreignBlob instanceof Blob).toBe(false);

      socket.send(foreignBlob);
    } finally {
      frame.remove();
    }

    expect(metrics.getSnapshot().total.sent).toEqual({
      bytes: 6 + 4,
      messages: 1,
    });
  });

  it('counts an ArrayBuffer', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();

    socket.send(new ArrayBuffer(12));

    expect(metrics.getSnapshot().total.sent).toEqual({
      bytes: 12,
      messages: 1,
    });
  });

  it('counts only the viewed range of an ArrayBuffer view', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();
    const buffer = new ArrayBuffer(32);

    socket.send(new Uint16Array(buffer, 2, 3));
    socket.send(new DataView(buffer, 4, 5));

    expect(metrics.getSnapshot().total.sent).toEqual({
      bytes: 6 + 5,
      messages: 2,
    });
  });

  it.each(['CONNECTING', 'CLOSING', 'CLOSED'] as const)(
    'does not count data sent while %s',
    async (state) => {
      const { metrics, create, connect } = setup();
      let socket: WebSocket;
      if (state === 'CONNECTING') {
        socket = create();
        expect(() => socket.send('x')).toThrow();
      } else {
        socket = await connect();
        const closed = once(socket, 'close');
        socket.close();
        if (state === 'CLOSED') {
          await closed;
        }
        socket.send('x');
      }

      expect(socket.readyState).toBe(NativeWebSocket[state]);
      expect(metrics.getSnapshot().total.sent).toEqual({
        bytes: 0,
        messages: 0,
      });
    },
  );

  it('does not count data when the native send() throws', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();
    vi.spyOn(NativeWebSocket.prototype, 'send').mockImplementation(() => {
      throw new Error('send failed');
    });

    expect(() => socket.send('abc')).toThrow('send failed');

    expect(metrics.getSnapshot().total.sent).toEqual({
      bytes: 0,
      messages: 0,
    });
  });
});

describe('received metrics', () => {
  it('counts a text message without any application listener', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();

    socket.send('aé日😀');

    await vi.waitFor(() =>
      expect(metrics.getSnapshot().total.received).toEqual({
        bytes: 10,
        messages: 1,
      }),
    );
  });

  it.each(['blob', 'arraybuffer'] as const)(
    'counts a binary message with binaryType %s',
    async (binaryType) => {
      const { metrics, connect } = setup();
      const socket = await connect();
      socket.binaryType = binaryType;

      socket.send(new Uint8Array([1, 2, 3, 4, 5]));

      await vi.waitFor(() =>
        expect(metrics.getSnapshot().total.received).toEqual({
          bytes: 5,
          messages: 1,
        }),
      );
    },
  );
});

describe('grouping', () => {
  it('groups by the whole WebSocket URL by default and derives the total', async () => {
    const { metrics, connect } = setup();
    const [a1, a2, b] = await Promise.all([
      connect('/a?id=1'),
      connect('/a?id=1'),
      connect('/a?id=2'),
    ]);

    a1.send('hi');
    a2.send('hey');
    b.send('hello');

    await vi.waitFor(() =>
      expect(metrics.getSnapshot().total.received.messages).toBe(3),
    );
    const { total, byKey } = metrics.getSnapshot();
    expect(byKey).toEqual({
      [`${baseUrl}/a?id=1`]: {
        sent: { bytes: 5, messages: 2 },
        received: { bytes: 5, messages: 2 },
      },
      [`${baseUrl}/a?id=2`]: {
        sent: { bytes: 5, messages: 1 },
        received: { bytes: 5, messages: 1 },
      },
    });
    expect(total).toEqual({
      sent: { bytes: 10, messages: 3 },
      received: { bytes: 10, messages: 3 },
    });
  });

  it('calls groupBy once per socket with the native WebSocket URL', async () => {
    const groupBy = vi.fn(() => 'key');
    const { metrics, connect } = setup({ groupBy });

    const socket = await connect('');
    socket.send('a');
    socket.send('b');
    await vi.waitFor(() =>
      expect(metrics.getSnapshot().total.received.messages).toBe(2),
    );

    expect(socket.url).toBe(`${baseUrl}/`);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith(socket.url);
  });

  it('aggregates sent and received traffic of different URLs under one key', async () => {
    const { metrics, connect } = setup({
      groupBy(url) {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      },
    });
    const [a, b] = await Promise.all([
      connect('/socket?token=a'),
      connect('/socket?token=b'),
    ]);

    a.send('hi');
    b.send('hey');

    await vi.waitFor(() =>
      expect(metrics.getSnapshot().total.received.messages).toBe(2),
    );
    expect(metrics.getSnapshot().byKey).toEqual({
      [`${baseUrl}/socket`]: {
        sent: { bytes: 5, messages: 2 },
        received: { bytes: 5, messages: 2 },
      },
    });
  });

  it('keeps "__proto__" and "constructor" keys as own data properties', async () => {
    const { metrics, connect } = setup({
      groupBy: (url) => new URL(url).pathname.slice(1),
    });
    const [proto, ctor] = await Promise.all([
      connect('/__proto__'),
      connect('/constructor'),
    ]);

    proto.send('abc');
    ctor.send('abc');
    await vi.waitFor(() =>
      expect(metrics.getSnapshot().total.received.messages).toBe(2),
    );

    const { byKey } = metrics.getSnapshot();
    const traffic = {
      sent: { bytes: 3, messages: 1 },
      received: { bytes: 3, messages: 1 },
    };
    expect(Object.getPrototypeOf(byKey)).toBe(Object.prototype);
    expect(Object.keys(byKey)).toEqual(['__proto__', 'constructor']);
    expect(Object.getOwnPropertyDescriptor(byKey, '__proto__')?.value).toEqual(
      traffic,
    );
    expect(byKey['constructor']).toEqual(traffic);
    expect('sent' in {}).toBe(false);
    expect(JSON.stringify(byKey)).toBe(
      JSON.stringify({ ['__proto__']: traffic, constructor: traffic }),
    );
  });

  it('closes the socket and throws a TypeError when groupBy returns a non-string', async () => {
    const { MetricsWebSocket } = setup({ groupBy: (() => 1) as never });
    const close = vi.spyOn(NativeWebSocket.prototype, 'close');

    expect(() => new MetricsWebSocket(`${baseUrl}/`)).toThrow(TypeError);

    expect(close).toHaveBeenCalledTimes(1);
    const socket = close.mock.contexts[0] as WebSocket;
    await once(socket, 'close');
    expect(socket.readyState).toBe(NativeWebSocket.CLOSED);
  });

  it.each(['MetricsWebSocket', 'a subclass that overrides close()'])(
    'closes the socket and rethrows when groupBy throws in %s',
    async (target) => {
      const error = new Error('groupBy failed');
      const { MetricsWebSocket } = setup({
        groupBy() {
          throw error;
        },
      });
      class LoggingWebSocket extends MetricsWebSocket {
        readonly #log: string[] = [];

        override close(code?: number, reason?: string): void {
          this.#log.push('close');
          super.close(code, reason);
        }
      }
      const Constructor =
        target === 'MetricsWebSocket' ? MetricsWebSocket : LoggingWebSocket;
      const close = vi.spyOn(NativeWebSocket.prototype, 'close');

      let thrown: unknown;
      try {
        new Constructor(`${baseUrl}/`);
      } catch (caught) {
        thrown = caught;
      }

      expect(thrown).toBe(error);
      expect(close).toHaveBeenCalledTimes(1);
      const socket = close.mock.contexts[0] as WebSocket;
      expect(socket.readyState).toBe(NativeWebSocket.CLOSING);
      await once(socket, 'close');
      expect(socket.readyState).toBe(NativeWebSocket.CLOSED);
    },
  );
});

describe('subscribe', () => {
  it('notifies the current snapshot immediately', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();
    socket.send('abc');
    const listener = vi.fn();

    metrics.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(metrics.getSnapshot());
  });

  it('batches updates within an animation frame and shares one snapshot', async () => {
    const { metrics, connect } = setup();
    const frames = manualAnimationFrames();
    const socket = await connect();
    const first = vi.fn();
    const second = vi.fn();
    metrics.subscribe(first);
    metrics.subscribe(second);

    for (let i = 0; i < 10; i++) {
      socket.send('abc');
    }

    expect(frames.request).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);

    frames.runFrame();

    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    const flushed = first.mock.calls[1]?.[0] as WebSocketMetricsSnapshot;
    expect(flushed.total.sent).toEqual({ bytes: 30, messages: 10 });
    expect(second.mock.calls[1]?.[0]).toBe(flushed);
    expect(metrics.getSnapshot()).toBe(flushed);

    socket.send('abc');
    expect(frames.request).toHaveBeenCalledTimes(2);
  });

  it('notifies with the real requestAnimationFrame', async () => {
    const { metrics, connect } = setup();
    const socket = await connect();
    const listener = vi.fn();
    metrics.subscribe(listener);

    socket.send('abc');

    await vi.waitFor(() =>
      expect(listener.mock.lastCall?.[0].total).toEqual({
        sent: { bytes: 3, messages: 1 },
        received: { bytes: 3, messages: 1 },
      }),
    );
  });

  it('does not notify a late subscriber again for changes it already received', async () => {
    const { metrics, connect } = setup();
    const frames = manualAnimationFrames();
    const socket = await connect();
    const early = vi.fn();
    const late = vi.fn();
    metrics.subscribe(early);
    socket.send('abc');

    metrics.subscribe(late);
    frames.runFrame();

    expect(early).toHaveBeenCalledTimes(2);
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0]?.[0].total.sent.messages).toBe(1);
  });

  it('stops notifying after unsubscribe', async () => {
    const { metrics, connect } = setup();
    const frames = manualAnimationFrames();
    const socket = await connect();
    const kept = vi.fn();
    const removed = vi.fn();
    metrics.subscribe(kept);
    const unsubscribe = metrics.subscribe(removed);

    socket.send('abc');
    unsubscribe();
    frames.runFrame();

    expect(kept).toHaveBeenCalledTimes(2);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('cancels the pending frame when the last subscriber leaves', async () => {
    const { metrics, connect } = setup();
    const frames = manualAnimationFrames();
    const socket = await connect();
    const unsubscribe = metrics.subscribe(() => {});

    socket.send('abc');
    unsubscribe();

    expect(frames.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not schedule frames while there are no subscribers', async () => {
    const { metrics, connect } = setup();
    const frames = manualAnimationFrames();
    const socket = await connect();

    socket.send('abc');
    metrics.subscribe(() => {})();
    socket.send('abc');

    expect(frames.request).not.toHaveBeenCalled();
  });

  it('keeps notifying other subscribers when one listener throws', async () => {
    const { metrics, connect } = setup();
    const frames = manualAnimationFrames();
    const socket = await connect();
    const report = vi.fn();
    vi.stubGlobal('reportError', report);
    const failing = vi.fn(() => {
      throw new Error('listener failed');
    });
    const healthy = vi.fn();
    metrics.subscribe(failing);
    metrics.subscribe(healthy);
    report.mockClear();

    socket.send('abc');
    frames.runFrame();

    expect(healthy).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe('WebSocket compatibility', () => {
  it('does not replace the global WebSocket', () => {
    const { MetricsWebSocket } = setup();

    expect(globalThis.WebSocket).toBe(NativeWebSocket);
    expect(MetricsWebSocket).not.toBe(NativeWebSocket);
  });

  it('exposes the standard WebSocket state and negotiates protocols', async () => {
    const { connect } = setup();

    const socket = await connect('/path?q=1', ['chat', 'other']);

    expect(socket).toBeInstanceOf(NativeWebSocket);
    expect(socket.url).toBe(`${baseUrl}/path?q=1`);
    expect(socket.protocol).toBe('chat');
    expect(socket.extensions).toBeTypeOf('string');
    expect(socket.readyState).toBe(NativeWebSocket.OPEN);
    expect(socket.bufferedAmount).toBeTypeOf('number');
    expect(socket.binaryType).toBe('blob');
    socket.binaryType = 'arraybuffer';
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('delivers unmodified events to listeners and handlers', async () => {
    const { create } = setup();
    const socket = create();
    socket.binaryType = 'arraybuffer';
    const events: string[] = [];
    const removed = vi.fn();
    const received: unknown[] = [];
    socket.onopen = () => events.push('onopen');
    socket.addEventListener('open', () => events.push('open listener'));
    socket.addEventListener('message', removed);
    socket.removeEventListener('message', removed);
    socket.onmessage = (event) => received.push(event.data);
    socket.addEventListener('message', (event) => received.push(event.data));
    socket.onclose = (event) => events.push(`onclose ${event.code}`);

    await once(socket, 'open');
    socket.send(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    const closed = once(socket, 'close');
    socket.close(1000, 'done');
    await closed;

    expect(events).toEqual(['onopen', 'open listener', 'onclose 1000']);
    expect(removed).not.toHaveBeenCalled();
    expect(received[0]).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(received[0] as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(received[1]).toBe(received[0]);
  });

  it('dispatches onerror when the connection fails', async () => {
    const { MetricsWebSocket } = setup();
    // Port 1 is not listening, so the connection is refused.
    const socket = new MetricsWebSocket('ws://127.0.0.1:1/');
    sockets.push(socket);

    await new Promise<void>((resolve) => {
      socket.onerror = () => resolve();
    });

    expect(socket.readyState).not.toBe(NativeWebSocket.OPEN);
  });
});
