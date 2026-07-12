import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  class FakeHubConnection {
    state = 'Disconnected';
    connectionId: string;
    handlers = new Map<string, (...args: unknown[]) => void>();
    closeHandler: ((error?: Error) => void) | null = null;
    resolveStop: (() => void) | null = null;

    constructor(connectionId: string) {
      this.connectionId = connectionId;
    }

    on(name: string, handler: (...args: unknown[]) => void): void {
      this.handlers.set(name, handler);
    }

    onreconnecting(): void {}
    onreconnected(): void {}

    onclose(handler: (error?: Error) => void): void {
      this.closeHandler = handler;
    }

    async start(): Promise<void> {
      this.state = 'Connected';
    }

    stop(): Promise<void> {
      return new Promise((resolve) => {
        this.resolveStop = () => {
          this.state = 'Disconnected';
          this.closeHandler?.();
          resolve();
        };
      });
    }

    async invoke(): Promise<void> {}

    emit(name: string, ...args: unknown[]): void {
      this.handlers.get(name)?.(...args);
    }

    finishStop(): void {
      this.resolveStop?.();
    }
  }

  const connections: FakeHubConnection[] = [];

  class FakeHubConnectionBuilder {
    withUrl(): this { return this; }
    withAutomaticReconnect(): this { return this; }
    withStatefulReconnect(): this { return this; }
    withServerTimeout(): this { return this; }
    withKeepAliveInterval(): this { return this; }
    configureLogging(): this { return this; }

    build(): FakeHubConnection {
      const connection = new FakeHubConnection(`connection-${connections.length + 1}`);
      connections.push(connection);
      return connection;
    }
  }

  return { connections, FakeHubConnectionBuilder };
});

vi.mock('@microsoft/signalr', () => ({
  HubConnectionBuilder: harness.FakeHubConnectionBuilder,
  HubConnectionState: { Connected: 'Connected' },
  LogLevel: { Information: 2 },
}));

import { SignalingService } from './SignalingService';

describe('SignalingService connection ownership', () => {
  it('ignores close and room events from a detached connection', async () => {
    const service = new SignalingService();
    const onClosed = vi.fn();
    const onPeerJoined = vi.fn();
    service.on('onClosed', onClosed);
    service.on('onPeerJoined', onPeerJoined);

    await service.connect();
    const oldConnection = harness.connections[harness.connections.length - 1];
    const stopping = service.disconnect();
    await service.connect();
    const currentConnection = harness.connections[harness.connections.length - 1];

    oldConnection.emit('OnPeerJoined', 'stale-peer');
    oldConnection.finishStop();
    await stopping;
    currentConnection.emit('OnPeerJoined', 'current-peer');

    expect(onClosed).not.toHaveBeenCalled();
    expect(onPeerJoined).toHaveBeenCalledTimes(1);
    expect(onPeerJoined).toHaveBeenCalledWith('current-peer');
    expect(service.getLocalConnectionId()).toBe('connection-2');
  });
});
