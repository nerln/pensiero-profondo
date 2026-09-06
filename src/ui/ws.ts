// WebSocket client for /ws/ui. Reconnects with exponential backoff; a fresh connection makes
// the hub resend the snapshot on its own (see protocol.ts), so reconnecting is enough to catch
// up. In mock mode (?mock=1) this delegates to the in-memory mock hub instead of opening a
// socket, so the rest of the app never has to know which mode it is running in.

import type { HubToUi, UiToHub } from '../core/protocol.js';
import { hubToken } from './api';
import type { UiAction } from './state.js';
import { isMockMode, mockHub } from './mock.js';

export interface WsHandle {
  send(msg: UiToHub): void;
  close(): void;
}

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

export function connectWs(dispatch: (action: UiAction) => void): WsHandle {
  if (isMockMode()) {
    return mockHub.connect(dispatch);
  }

  let socket: WebSocket | null = null;
  let closed = false;
  let backoffMs = INITIAL_BACKOFF_MS;
  let reconnectTimer: number | undefined;

  const token = hubToken();

  function send(msg: UiToHub): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  function scheduleReconnect(): void {
    if (closed) return;
    reconnectTimer = window.setTimeout(() => {
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      open();
    }, backoffMs);
  }

  function open(): void {
    if (closed) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${proto}//${window.location.host}/ws/ui?token=${encodeURIComponent(token)}`);

    socket.addEventListener('open', () => {
      backoffMs = INITIAL_BACKOFF_MS;
      dispatch({ t: 'ui.connected', connected: true });
      if (token) send({ t: 'auth', token });
    });
    socket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as HubToUi;
        dispatch(msg);
      } catch {
        // malformed frame; ignore rather than crash the UI
      }
    });
    socket.addEventListener('close', () => {
      dispatch({ t: 'ui.connected', connected: false });
      scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      socket?.close();
    });
  }

  open();

  return {
    send,
    close(): void {
      closed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
