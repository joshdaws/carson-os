import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

interface LiveEvent {
  type: string;
  data: unknown;
}

interface LiveUpdatesContextValue {
  connected: boolean;
  lastEvent: LiveEvent | null;
}

const LiveUpdatesContext = createContext<LiveUpdatesContextValue>({
  connected: false,
  lastEvent: null,
});

export function useLiveUpdates() {
  return useContext(LiveUpdatesContext);
}

export function LiveUpdatesProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();

      ws.onmessage = (e) => {
        try {
          const event: LiveEvent = JSON.parse(e.data);
          setLastEvent(event);

          switch (event.type) {
            case "conversation.message":
              queryClient.invalidateQueries({ queryKey: ["messages"] });
              queryClient.invalidateQueries({ queryKey: ["conversations"] });
              queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              break;
            case "policy.enforced":
            case "policy.escalated":
              queryClient.invalidateQueries({ queryKey: ["policyEvents"] });
              queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              break;
            case "task.created":
            case "task.approved":
            case "task.completed":
              queryClient.invalidateQueries({ queryKey: ["tasks"] });
              queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              break;
            case "staff.status_changed":
              queryClient.invalidateQueries({ queryKey: ["staff"] });
              queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              break;
            case "activity.new":
              queryClient.invalidateQueries({ queryKey: ["activity"] });
              queryClient.invalidateQueries({ queryKey: ["dashboard"] });
              break;
          }
        } catch {
          // ignore malformed messages
        }
      };
    }

    connect();

    return () => {
      wsRef.current?.close();
    };
  }, [queryClient]);

  return (
    <LiveUpdatesContext.Provider value={{ connected, lastEvent }}>
      {children}
    </LiveUpdatesContext.Provider>
  );
}
