import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/* ── Discriminated-union message types ──────────────────────────── */

export interface WsMsgConnected {
  type: 'connected';
  payload?: unknown;
}

export interface WsMsgDialogStream {
  type: 'dialog_stream';
  payload: { chunk: string; stream: 'stdout' | 'stderr' };
}

export interface WsMsgAgentOutput {
  type: 'agent_output';
  payload: {
    task_id: string;
    chunk: string;
    stream: 'stdout' | 'stderr';
    provider: string;
    stage: string;
  };
}

export interface WsMsgEvent {
  type: string; // catch-all for daemon event types
  id?: string;
  source?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

export type WsMessage =
  | WsMsgConnected
  | WsMsgDialogStream
  | WsMsgAgentOutput
  | WsMsgEvent;

/* ── Context contract ───────────────────────────────────────────── */

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

type MessageHandler = (msg: WsMessage) => void;

interface WebSocketContextValue {
  status: WsStatus;
  lastMessage: WsMessage | null;
  subscribe: (handler: MessageHandler) => () => void;
  send: (data: unknown) => void;
}

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

/* ── Provider ───────────────────────────────────────────────────── */

const WS_URL =
  window.location.port === '3383'
    ? `ws://${window.location.hostname}:3382/ws`
    : `ws://${window.location.host}/ws`;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WsStatus>('connecting');
  const [lastMessage, setLastMessage] = useState<WsMessage | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<Set<MessageHandler>>(new Set());
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      if (unmountedRef.current) { ws.close(); return; }
      retryCountRef.current = 0;
      setStatus('connected');
    };

    ws.onmessage = (event) => {
      if (unmountedRef.current) return;
      let parsed: WsMessage;
      try {
        parsed = JSON.parse(event.data as string) as WsMessage;
      } catch {
        return;
      }
      setLastMessage(parsed);
      handlersRef.current.forEach((h) => h(parsed));
    };

    const scheduleReconnect = () => {
      if (unmountedRef.current) return;
      setStatus('disconnected');
      const delay = Math.min(
        BASE_DELAY_MS * 2 ** retryCountRef.current,
        MAX_DELAY_MS,
      );
      retryCountRef.current += 1;
      retryTimerRef.current = setTimeout(connect, delay);
    };

    ws.onclose = scheduleReconnect;
    ws.onerror = () => {
      ws.close(); // triggers onclose → scheduleReconnect
    };
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connect();
    return () => {
      unmountedRef.current = true;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return (
    <WebSocketContext.Provider value={{ status, lastMessage, subscribe, send }}>
      {children}
    </WebSocketContext.Provider>
  );
}

/* ── Consumer hook ──────────────────────────────────────────────── */

export function useWebSocketContext(): WebSocketContextValue {
  const ctx = useContext(WebSocketContext);
  if (!ctx) {
    throw new Error('useWebSocketContext must be used inside <WebSocketProvider>');
  }
  return ctx;
}
