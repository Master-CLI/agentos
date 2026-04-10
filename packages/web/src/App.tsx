import { useState, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';

export default function App() {
  const { status, lastMessage } = useWebSocket();

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '960px', margin: '0 auto' }}>
      <h1>AgentOS Console</h1>
      <div style={{
        padding: '0.5rem 1rem',
        borderRadius: '4px',
        background: status === 'connected' ? '#e6f4ea' : '#fce8e6',
        color: status === 'connected' ? '#1e7e34' : '#c5221f',
        display: 'inline-block',
        marginBottom: '1rem'
      }}>
        Daemon: {status}
      </div>
      {lastMessage && (
        <pre style={{ background: '#f5f5f5', padding: '1rem', borderRadius: '4px', overflow: 'auto' }}>
          {JSON.stringify(lastMessage, null, 2)}
        </pre>
      )}
    </div>
  );
}
