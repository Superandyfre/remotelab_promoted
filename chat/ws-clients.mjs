/**
 * Shared global WebSocket broadcast.
 * Decoupled from ws.mjs to avoid circular imports.
 */
let wss = null;

export function setWss(instance) {
  wss = instance;
}

export function getClientsMatching(predicate = () => true) {
  if (!wss) return [];
  const matches = [];
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (!predicate(client)) continue;
    matches.push(client);
  }
  return matches;
}

export function broadcastMatching(msg, predicate = () => true) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (!predicate(client)) continue;
    try { client.send(data); } catch {}
  }
}

export function broadcastAll(msg) {
  broadcastMatching(msg);
}

export function broadcastOwners(msg) {
  broadcastMatching(msg, (client) => client._authSession?.role === 'owner');
}

/**
 * Push session event data directly to authorised WebSocket clients.
 */
export function broadcastSessionEvents(sessionId, events, { findSessionMetaCached = null } = {}) {
  if (!wss || !Array.isArray(events) || events.length === 0) return;
  const msg = { type: 'session_events', sessionId, events };
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const authSession = client._authSession;
    if (!authSession) continue;
    if (authSession.role === 'owner') {
      try { client.send(data); } catch {}
      continue;
    }
    // visitor / agent-scoped — reuse same visibility check as broadcastSessionInvalidation
    if (typeof authSession.sessionId === 'string' && authSession.sessionId === sessionId) {
      try { client.send(data); } catch {}
    }
  }
}
