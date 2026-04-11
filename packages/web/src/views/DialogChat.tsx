import { useState, useEffect, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import { useWebSocket } from '../hooks/useWebSocket';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export function DialogChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamChunks, setStreamChunks] = useState('');
  const api = useApi();
  const { lastMessage } = useWebSocket();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load history on mount
  useEffect(() => {
    api.get<Message[]>('/api/dialog/history').then(setMessages).catch(() => {});
  }, [api]);

  // Stream chunks from WebSocket
  useEffect(() => {
    if (!lastMessage || typeof lastMessage !== 'object') return;
    const msg = lastMessage as any;
    if (msg.type === 'dialog_stream') {
      setStreamChunks((prev) => prev + msg.payload.chunk);
    }
  }, [lastMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamChunks]);

  const submit = async () => {
    if (!input.trim() || loading) return;
    const question = input.trim();
    setInput('');
    setLoading(true);
    setStreamChunks('');

    // Optimistic: show user message immediately
    const userMsg: Message = {
      id: String(Date.now()),
      role: 'user',
      content: question,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const answer = await api.post<Message>('/api/dialog', { question });
      setMessages((prev) => [...prev, answer]);
      setStreamChunks('');
    } catch {
      setMessages((prev) => [...prev, {
        id: String(Date.now()),
        role: 'assistant',
        content: 'Failed to get response.',
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setLoading(false);
      setStreamChunks('');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 40px)' }}>
      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 16 }}>
        {messages.length === 0 && !loading && (
          <div style={{ color: 'var(--text-dim)', textAlign: 'center', marginTop: '20vh' }}>
            <div style={{ fontSize: 18, marginBottom: 8 }}>Ask about your project</div>
            <div style={{ fontSize: 13 }}>
              "What changed today?" / "Any risks in the recent commits?" / "How active is module X?"
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} style={{
            marginBottom: 16,
            display: 'flex',
            flexDirection: 'column',
            alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
          }}>
            <div style={{
              maxWidth: '80%',
              padding: '10px 14px',
              borderRadius: 'var(--radius)',
              background: msg.role === 'user' ? 'var(--accent-dim)' : 'var(--bg-card)',
              border: msg.role === 'user' ? 'none' : '1px solid var(--border)',
              whiteSpace: 'pre-wrap',
              fontSize: 14,
              lineHeight: 1.6,
            }}>
              {msg.content}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
              {msg.role === 'user' ? 'You' : 'AgentOS'} · {new Date(msg.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}

        {/* Streaming response */}
        {loading && streamChunks && (
          <div style={{ marginBottom: 16 }}>
            <div style={{
              maxWidth: '80%',
              padding: '10px 14px',
              borderRadius: 'var(--radius)',
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              whiteSpace: 'pre-wrap',
              fontSize: 14,
              lineHeight: 1.6,
            }}>
              {streamChunks}
              <span style={{ animation: 'pulse 1s infinite' }}>|</span>
            </div>
          </div>
        )}

        {loading && !streamChunks && (
          <div style={{ color: 'var(--text-dim)', padding: 12 }}>Thinking...</div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="card" style={{ flexShrink: 0 }}>
        <div className="dialog-input">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Ask about your project..."
            disabled={loading}
          />
          <button onClick={submit} disabled={loading || !input.trim()}>
            {loading ? '...' : 'Ask'}
          </button>
        </div>
      </div>
    </div>
  );
}
