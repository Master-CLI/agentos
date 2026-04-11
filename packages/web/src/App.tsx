import { useState } from 'react';
import './styles.css';
import { useWebSocket } from './hooks/useWebSocket';
import { DialogChat } from './views/DialogChat';
import { SuggestionInbox } from './views/SuggestionInbox';
import { StatusOverview } from './views/StatusOverview';
import { ChangeStream } from './views/ChangeStream';

type View = 'chat' | 'suggestions' | 'status' | 'events';

export default function App() {
  const { status } = useWebSocket();
  const [view, setView] = useState<View>('chat');

  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>AgentOS</h1>
        <div style={{ fontSize: 12, marginBottom: 12, color: 'var(--text-dim)' }}>
          <span className={`status-dot ${status}`} />
          {status === 'connected' ? 'Daemon running' : status === 'connecting' ? 'Connecting...' : 'Disconnected'}
        </div>
        <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>
          Chat
        </button>
        <button className={view === 'suggestions' ? 'active' : ''} onClick={() => setView('suggestions')}>
          Suggestions
        </button>
        <button className={view === 'status' ? 'active' : ''} onClick={() => setView('status')}>
          Status
        </button>
        <button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>
          Events
        </button>
      </nav>

      <main className="main">
        {view === 'chat' && <DialogChat />}
        {view === 'suggestions' && <SuggestionInbox />}
        {view === 'status' && <StatusOverview />}
        {view === 'events' && <ChangeStream />}
      </main>
    </div>
  );
}
