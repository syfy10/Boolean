# Boolean Remote Control Architecture

Status: planned, not enabled in the desktop app.

## Goal

Let a user securely view and control their own Boolean desktop tasks from a
phone or another browser without exposing the local Boolean API or tool server
to the public internet.

## Required Design

1. The desktop app creates a short-lived pairing request and displays a QR code.
2. The phone signs in and confirms the same pairing request.
3. Both clients derive end-to-end encryption keys. The relay never receives
   plaintext prompts, results, files, credentials, or tool arguments.
4. The desktop keeps an outbound WebSocket connection to a Cloudflare Durable
   Object. No inbound port is opened on the user's PC.
5. The Durable Object routes encrypted envelopes only and enforces one user,
   one paired device, expiration, replay protection, and rate limits.
6. The desktop remains the authority for tool permissions, approval prompts,
   cancellation, and task state.
7. Remote write actions require the same permission policy as local actions.
   Sensitive actions can require an additional device confirmation.
8. Pairing can be revoked from either device. Keys and refresh tokens are kept
   in the Windows credential store, not app update files.

## Delivery Phases

1. Read-only task status and encrypted chat continuation.
2. Approval, stop, and resume controls.
3. Browser and preview streaming.
4. Carefully scoped remote tool actions and multi-device support.

Do not replace this design with a public local MCP or HTTP listener. A raw
listener exposes the wrong trust boundary and does not provide the paired,
end-to-end encrypted experience discussed with the user.
