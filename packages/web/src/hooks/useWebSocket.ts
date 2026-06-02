/**
 * Thin re-export shim. All components now read from the single shared
 * WebSocketProvider mounted in App.tsx. Import useWebSocketContext directly
 * from the context module if you need the subscribe() API.
 */
export { useWebSocketContext as useWebSocket } from '../contexts/WebSocketContext';
export type { WsMessage, WsStatus } from '../contexts/WebSocketContext';
