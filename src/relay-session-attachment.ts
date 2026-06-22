import crypto from 'node:crypto';
import {
  classifyRelayCondition,
  type RelayConditionResult,
} from './relay-condition.js';
import type {
  ConsumedRelaySession,
  RelayControlPlaneClient,
} from './relay-control-plane.js';
import {
  validateRelayGrantSessionBinding,
  type RelayGrant,
  type RelayGrantVerificationResult,
} from './relay-grant-verification.js';
import type {
  RelayTunnelRegistry,
  TunnelConnection,
} from './relay-tunnel-registry.js';

export type RelaySessionAttachmentPurpose = 'remote_ws' | 'remote_http';

export type RelaySessionAttachmentFailureStage =
  | 'grant'
  | 'purpose'
  | 'consume'
  | 'binding'
  | 'tunnel';

export type RelaySessionAttachmentResult =
  | {
      ok: true;
      connectionId: string;
      condition: RelayConditionResult;
      consumedSession: ConsumedRelaySession;
      tunnel: TunnelConnection;
      grant?: RelayGrant;
    }
  | {
      ok: false;
      connectionId: string;
      condition: RelayConditionResult;
      stage: RelaySessionAttachmentFailureStage;
      grant?: RelayGrant;
      status?: number;
      error?: string;
    };

export type AttachRelaySessionInput = {
  token: string;
  purpose: RelaySessionAttachmentPurpose;
  relayControlPlane: RelayControlPlaneClient;
  tunnelRegistry: RelayTunnelRegistry;
  verifyGrantToken: (token: string) => Promise<RelayGrantVerificationResult>;
  createConnectionId?: () => string;
};

const purposeFailureDetail: Record<RelaySessionAttachmentPurpose, string> = {
  remote_http: 'Relay grant purpose is not valid for HTTP relay',
  remote_ws: 'Relay grant purpose is not valid for WebSocket relay',
};

export async function attachRelaySession(
  input: AttachRelaySessionInput,
): Promise<RelaySessionAttachmentResult> {
  const connectionId = input.createConnectionId?.() ?? crypto.randomUUID();
  const grantVerification = await input.verifyGrantToken(input.token);

  if (!grantVerification.ok) {
    return {
      ok: false,
      connectionId,
      stage: 'grant',
      condition: grantVerification.condition,
    };
  }

  const grant = grantVerification.grant;
  if (grant && grant.purpose !== input.purpose) {
    return {
      ok: false,
      connectionId,
      stage: 'purpose',
      grant,
      condition: {
        relayCondition: 'unauthorized',
        reasonCode: 'auth_invalid',
        detail: purposeFailureDetail[input.purpose],
      },
    };
  }

  const response = await input.relayControlPlane.consumeRelaySession(input.token, { connectionId });
  if (!response.ok) {
    const condition = classifyRelayCondition({
      source: 'session-attach',
      status: response.status,
      error: response.error,
    });
    return {
      ok: false,
      connectionId,
      stage: 'consume',
      condition,
      status: response.status,
      error: response.error,
      grant,
    };
  }

  if (grant) {
    const bindingCondition = validateRelayGrantSessionBinding(grant, response.data);
    if (bindingCondition) {
      return {
        ok: false,
        connectionId,
        stage: 'binding',
        condition: bindingCondition,
        grant,
      };
    }
  }

  const tunnel = input.tunnelRegistry.getByServerId(response.data.serverId);
  if (!tunnel) {
    return {
      ok: false,
      connectionId,
      stage: 'tunnel',
      grant,
      condition: classifyRelayCondition({
        source: 'session-attach',
        hasActiveTunnel: false,
        error: 'No active relay tunnel for this server',
      }),
    };
  }

  return {
    ok: true,
    connectionId,
    condition: {
      relayCondition: 'connected',
      reasonCode: 'ok',
      detail: 'consume ok',
    },
    consumedSession: response.data,
    tunnel,
    grant,
  };
}
