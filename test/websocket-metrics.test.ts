import { afterEach, describe, expect, inject, it, vi } from 'vitest';
import { createWebSocketMetrics } from '../src/index.js';
import type { WebSocketMetricsSnapshot } from '../src/index.js';

const baseUrl = inject('wsBaseUrl');
const NativeWebSocket = globalThis.WebSocket;

const sockets: WebSocket[] = [];

const setup = () => {
  const { WebSocket: MetricsWebSocket, metrics } = createWebSocketMetrics();

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
  it('starts with all zeros and no URLs', () => {
    const { metrics } = setup();

    const snapshot = metrics.getSnapshot();

    expect(snapshot.total).toEqual({
      sent: { bytes: 0, messages: 0 },
      received: { bytes: 0, messages: 0 },
    });
    expect(snapshot.byUrl.size).toBe(0);
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
    expect(before.byUrl.get(socket.url)?.sent).toEqual({
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
    expect(() => (snapshot.byUrl as Map<string, unknown>).clear()).toThrow(
      TypeError,
    );
    expect(() =>
      (snapshot.byUrl as Map<string, unknown>).set('ws://other/', {}),
    ).toThrow(TypeError);

    const next = metrics.getSnapshot();
    expect(next.total.sent).toEqual({ bytes: 3, messages: 1 });
    expect([...next.byUrl.keys()]).toEqual([socket.url]);
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

describe('per-URL metrics', () => {
  it('aggregates sockets of the same URL and derives the total from URLs', async () => {
    const { metrics, connect } = setup();
    const [a1, a2, b] = await Promise.all([
      connect('/a'),
      connect('/a'),
      connect('/b'),
    ]);

    a1.send('hi');
    a2.send('hey');
    b.send('hello');

    await vi.waitFor(() =>
      expect(metrics.getSnapshot().total.received.messages).toBe(3),
    );
    const { total, byUrl } = metrics.getSnapshot();
    expect(Object.fromEntries(byUrl)).toEqual({
      [a1.url]: {
        sent: { bytes: 5, messages: 2 },
        received: { bytes: 5, messages: 2 },
      },
      [b.url]: {
        sent: { bytes: 5, messages: 1 },
        received: { bytes: 5, messages: 1 },
      },
    });
    expect(a1.url).toBe(a2.url);
    expect(total).toEqual({
      sent: { bytes: 10, messages: 3 },
      received: { bytes: 10, messages: 3 },
    });
  });
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
