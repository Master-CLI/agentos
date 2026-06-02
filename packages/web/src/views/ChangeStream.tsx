import { useState, useEffect, useRef } from 'react';
import { useWebSocketContext, type WsMessage } from '../contexts/WebSocketContext';

interface EventRow {
  key: string; // stable key: prefer event id, fall back to monotonic seq
  type: string;
  source?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

let eventSeq = 0;

export function ChangeStream() {
  const [events, setEvents] = useState<EventRow[]>([]);
  const { subscribe } = useWebSocketContext();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = subscribe((msg: WsMessage) => {
      if (msg.type === 'connected') return;
      const e = msg as { type: string; id?: string; source?: string; timestamp?: string; payload?: Record<string, unknown> };
      const key = e.id ?? `seq-${++eventSeq}`;
      setEvents((prev) => {
        const next = [...prev, { key, type: e.type, source: e.source, timestamp: e.timestamp, payload: e.payload }];
        return next.slice(-100);
      });
    });
    return unsub;
  }, [subscribe]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  if (events.length === 0) {
    return (
      <div className="card">
        <h2>Event Stream</h2>
        <p style={{ color: 'var(--text-dim)' }}>
          Waiting for events... Make changes to your project files and they will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Event Stream ({events.length})</h2>
      <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
        {events.map((e) => (
          <div key={e.key} className="event-row">
            <span className="time">
              {e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '—'}
            </span>
            <span className="type">{e.type}</span>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
              {e.source ? `[${e.source}]` : ''}
              {e.payload?.path ? ` ${String(e.payload.path).split(/[/\\]/).pop()}` : ''}
              {e.payload?.message ? ` "${String(e.payload.message).slice(0, 60)}"` : ''}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
