# OmniLux Relay Runtime

This context defines the language for the public relay transport runtime at `relay.omnilux.tv`: tunnels, sessions, browser handoff, frame forwarding, and relay health conditions.

`omnilux-relay/` succeeds when `relay.omnilux.tv` can verify cloud-issued relay grants, accept self-hosted runtime tunnels, attach authorized browser or client relay sessions, forward HTTP/WebSocket-style frames reliably, emit transport conditions, and provide edge health without owning entitlement policy, billing, cloud durable state, runtime-side relay client behavior, or user-facing status copy.

In short, `omnilux-relay/` is the public remote-access transport runtime. It verifies cloud-issued grants, maintains server tunnel registry and session attachment, performs browser session handoff, forwards relay frames, emits transport conditions, and exposes edge health, while cloud owns authorization, the self-hosted runtime owns the relay client side, edge owns hostname/TLS ingress, and apps own launch/status UX.

## Language

**Relay Runtime**:
The transport service that forwards remote-access traffic between browsers and self-hosted runtimes.
_Avoid_: Control plane, self-hosted runtime, edge

**Server Tunnel**:
A live relay transport connection registered by a self-hosted runtime and used as the backing path for authorized relay sessions.
_Avoid_: Session, cloud link

**Relay Session**:
A short-lived remote-access attachment that lets a browser or client use an eligible tunnel.
_Avoid_: Tunnel, entitlement lease

**Browser HTTP Relay**:
The relay-owned browser handoff that exchanges an initial relay token for an HTTP-only relay session cookie.
_Avoid_: App route, direct origin access

**Browser Session Handoff**:
The `/r/<relay-session-token>/` flow that consumes a short-lived cloud token, creates an internal HTTP-only relay session cookie, redirects to `/`, and keeps the cloud token out of subsequent asset and API URLs.
_Avoid_: App login, direct origin navigation, bearer token in asset URL

**Relay Frame**:
A relay-owned message shape used to move requests, response starts, response bodies, response ends, stream chunks, session close reasons, and heartbeat or condition evidence between a relay session and server tunnel.
_Avoid_: Product event, runtime API DTO, cloud ledger row

**Transport Condition**:
The transport-level health state emitted by relay logs, heartbeats, and close messages.
_Avoid_: User-facing status copy, billing state

**Signed Session Grant**:
A signed control-plane grant accepted by relay for session attachment.
_Avoid_: Opaque token, local session

**Grant Verification**:
Local relay-runtime verification of signed cloud-issued relay grants for audience, expiry, issuer or key identity, allowed action, and session consume constraints.
_Avoid_: Grant issuance, entitlement policy, billing decision

**Relay Runtime Exclusion Boundary**:
The billing, entitlement, grant issuance, cloud state, app UI, runtime client, local auth, edge ingress, managed playback, and user-facing copy responsibilities intentionally owned outside the relay runtime repo.
_Avoid_: Control plane, customer app, public edge, self-hosted runtime

## Relationships

- A **Server Tunnel** is registered by a self-hosted runtime.
- A **Relay Session** attaches to a live **Server Tunnel**.
- **Relay Frames** move transport data between a **Relay Session** and a **Server Tunnel**.
- **Browser Session Handoff** binds a browser to a **Relay Session**.
- **Browser HTTP Relay** forwards subsequent browser requests through **Relay Frames**.
- A **Signed Session Grant** is issued by the control plane and verified by the **Relay Runtime**.
- **Grant Verification** enforces signed grant constraints for relay transport attachment.
- A **Transport Condition** describes transport state, evidence, and reason codes, not product copy.
- The **Relay Runtime Exclusion Boundary** keeps billing, entitlement decisions, grant issuance, durable cloud state, customer launch UI, self-hosted relay client behavior, local runtime auth, public edge routing, managed-media playback, and user-facing status copy outside this repo.

## Example dialogue

> **Dev:** "Should relay create the customer's entitlement?"
> **Domain expert:** "No. The control plane issues a **Signed Session Grant**. The **Relay Runtime** verifies it and transports frames."

## Flagged ambiguities

- "Session" can mean app auth, local runtime session, or relay transport. Resolved: this repo uses **Relay Session** for transport attachment only.
- "Tunnel" can hide the split between runtime client behavior and public relay behavior. Resolved: use **Server Tunnel** for the live relay connection; the self-hosted runtime owns client-side tunnel behavior, while relay owns registry, attachment, health, and forwarding while connected.
- Relay forwarding can be mistaken for product API ownership. Resolved: **Relay Frame** is a transport message shape; runtimes own producing and consuming their side of the protocol.
- Relay health state can be mistaken for user-facing status. Resolved: relay emits **Transport Conditions**; product surfaces map them to user-facing conditions and copy.
- Relay grant verification can be mistaken for relay policy ownership. Resolved: this repo owns **Grant Verification**, while cloud issues grants and decides policy.
- Relay transport can be mistaken for all remote-access ownership. Resolved: the **Relay Runtime Exclusion Boundary** defines what this repo must not own.
