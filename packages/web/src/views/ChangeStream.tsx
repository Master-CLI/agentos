import { useState, useEffect, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

interface Event {
  id?: string;
  type: string;
  source?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

export function ChangeStream() {
  const [events, setEvents] = useState<Event[]>([]);
  const { lastMessage } = useWebSocket();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lastMessage && typeof lastMessage === 'object' && (lastMessage as Event).type !== 'connected') {
      setEvents((prev) => {
        const next = [...prev, lastMessage as Event];
        return next.slice(-100); // Keep last 100
      });
    }
  }, [lastMessage]);

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
        {events.map((e, i) => (
          <div key={i} className="event-row">
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
