import { useState } from 'react';
import './styles.css';
import { WebSocketProvider, useWebSocketContext } from './contexts/WebSocketContext';
import { DialogChat } from './views/DialogChat';
import { SuggestionInbox } from './views/SuggestionInbox';
import { StatusOverview } from './views/StatusOverview';
import { ChangeStream } from './views/ChangeStream';
import { ComparisonView } from './views/ComparisonView';
import { GoalsBoard } from './views/GoalsBoard';
import { ActiveTodos } from './views/ActiveTodos';

type View = 'chat' | 'todos' | 'suggestions' | 'status' | 'events' | 'design' | 'goals';

function AppShell() {
  const { status } = useWebSocketContext();
  const [view, setView] = useState<View>('status');

  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>AgentOS</h1>
        <div style={{ fontSize: 12, marginBottom: 12, color: 'var(--text-dim)' }}>
          <span className={`status-dot ${status}`} />
          {status === 'connected' ? 'Daemon running' : status === 'connecting' ? 'Connecting...' : 'Disconnected'}
        </div>
        <button className={view === 'status' ? 'active' : ''} onClick={() => setView('status')}>
          Status
        </button>
        <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>
          Chat
        </button>
        <button className={view === 'todos' ? 'active' : ''} onClick={() => setView('todos')}>
          TODOs
        </button>
        <button className={view === 'suggestions' ? 'active' : ''} onClick={() => setView('suggestions')}>
          Suggestions
        </button>
        <button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>
          Events
        </button>
        <button className={view === 'design' ? 'active' : ''} onClick={() => setView('design')}>
          Design Review
        </button>
        <button className={view === 'goals' ? 'active' : ''} onClick={() => setView('goals')}>
          Goals
        </button>
      </nav>

      <main className="main">
        {view === 'status' && <StatusOverview />}
        {view === 'chat' && <DialogChat />}
        {view === 'todos' && <ActiveTodos />}
        {view === 'suggestions' && <SuggestionInbox />}
        {view === 'events' && <ChangeStream />}
        {view === 'design' && <ComparisonView />}
        {view === 'goals' && <GoalsBoard />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <WebSocketProvider>
      <AppShell />
    </WebSocketProvider>
  );
}
