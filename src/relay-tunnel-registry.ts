import type WebSocket from 'ws';

export interface TunnelConnection {
  serverId: string;
  connectionId: string;
  token: string;
  socket: WebSocket;
  registeredAt: string;
  protocolVersion: number;
  region?: string;
  clientVersion?: string;
  capabilities?: Record<string, unknown>;
  sessions: Set<string>;
}

export type RelayTunnelRegistry = {
  getByServerId: (serverId: string) => TunnelConnection | undefined;
  getByConnectionId: (connectionId: string) => TunnelConnection | undefined;
  findBySocket: (socket: WebSocket) => TunnelConnection | undefined;
  register: (tunnel: TunnelConnection) => TunnelConnection | undefined;
  removeByConnectionId: (connectionId: string) => TunnelConnection | undefined;
  addSession: (connectionId: string, sessionId: string) => void;
  removeSession: (connectionId: string | undefined, sessionId: string) => void;
};

export function createRelayTunnelRegistry(): RelayTunnelRegistry {
  const tunnelsByServerId = new Map<string, TunnelConnection>();
  const tunnelsByConnectionId = new Map<string, TunnelConnection>();

  return {
    getByServerId(serverId) {
      return tunnelsByServerId.get(serverId);
    },
    getByConnectionId(connectionId) {
      return tunnelsByConnectionId.get(connectionId);
    },
    findBySocket(socket) {
      return Array.from(tunnelsByConnectionId.values()).find((candidate) => candidate.socket === socket);
    },
    register(tunnel) {
      const existing = tunnelsByServerId.get(tunnel.serverId);
      tunnelsByServerId.set(tunnel.serverId, tunnel);
      tunnelsByConnectionId.set(tunnel.connectionId, tunnel);
      return existing;
    },
    removeByConnectionId(connectionId) {
      const tunnel = tunnelsByConnectionId.get(connectionId);
      if (!tunnel) return undefined;

      tunnelsByConnectionId.delete(connectionId);
      if (tunnelsByServerId.get(tunnel.serverId)?.connectionId === connectionId) {
        tunnelsByServerId.delete(tunnel.serverId);
      }

      return tunnel;
    },
    addSession(connectionId, sessionId) {
      tunnelsByConnectionId.get(connectionId)?.sessions.add(sessionId);
    },
    removeSession(connectionId, sessionId) {
      if (!connectionId) return;
      tunnelsByConnectionId.get(connectionId)?.sessions.delete(sessionId);
    },
  };
}
