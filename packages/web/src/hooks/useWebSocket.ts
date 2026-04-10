import { useState, useEffect, useRef, useCallback } from 'react';

interface UseWebSocketResult {
  status: 'connecting' | 'connected' | 'disconnected';
  lastMessage: unknown | null;
  send: (data: unknown) => void;
}

export function useWebSocket(url?: string): UseWebSocketResult {
  const wsUrl = url || `ws://${window.location.hostname}:3382/ws`;
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [lastMessage, setLastMessage] = useState<unknown | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setStatus('connected');
    ws.onclose = () => setStatus('disconnected');
    ws.onerror = () => setStatus('disconnected');
    ws.onmessage = (event) => {
      try {
        setLastMessage(JSON.parse(event.data));
      } catch {
        setLastMessage(event.data);
      }
    };

    return () => {
      ws.close();
    };
  }, [wsUrl]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { status, lastMessage, send };
}
