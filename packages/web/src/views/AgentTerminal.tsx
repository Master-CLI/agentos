import { useState, useEffect, useRef } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

interface OutputLine {
  text: string;
  stream: 'stdout' | 'stderr';
  provider: string;
  stage: string;
  time: string;
}

export function AgentTerminal({ taskId }: { taskId: string }) {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const { lastMessage } = useWebSocket();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!lastMessage || typeof lastMessage !== 'object') return;
    const msg = lastMessage as any;
    if (msg.type !== 'agent_output') return;
    if (msg.payload?.task_id !== taskId) return;

    const chunk = msg.payload.chunk as string;
    // Split into lines for better display
    const newLines = chunk.split('\n').filter((l: string) => l.length > 0).map((text: string) => ({
      text,
      stream: msg.payload.stream as 'stdout' | 'stderr',
      provider: msg.payload.provider as string,
      stage: msg.payload.stage as string,
      time: new Date().toLocaleTimeString(),
    }));

    if (newLines.length > 0) {
      setLines((prev) => [...prev, ...newLines].slice(-500));
    }
  }, [lastMessage, taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{
        padding: '8px 16px',
        background: '#1e1e2e',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
      }}>
        <span style={{ color: 'var(--green)', fontWeight: 700 }}>Terminal</span>
        <span style={{ color: 'var(--text-dim)' }}>
          {lines.length > 0 ? `${lines[lines.length - 1].provider} / ${lines[lines.length - 1].stage}` : 'Waiting for output...'}
        </span>
        {lines.length > 0 && (
          <span style={{
            marginLeft: 'auto',
            width: 8, height: 8,
            borderRadius: '50%',
            background: 'var(--green)',
            animation: 'pulse 1.5s infinite',
          }} />
        )}
      </div>
      <div
        ref={containerRef}
        style={{
          background: '#0d0d14',
          padding: '12px 16px',
          fontFamily: 'var(--mono)',
          fontSize: 12,
          lineHeight: 1.6,
          maxHeight: '400px',
          overflowY: 'auto',
          minHeight: '120px',
        }}
      >
        {lines.length === 0 && (
          <div style={{ color: 'var(--text-dim)' }}>
            <span style={{ color: 'var(--yellow)' }}>$</span> Waiting for agent to start...
          </div>
        )}
        {lines.map((line, i) => (
          <div key={i} style={{
            color: line.stream === 'stderr' ? 'var(--yellow)' : '#c8ccd4',
            wordBreak: 'break-all',
          }}>
            {line.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
