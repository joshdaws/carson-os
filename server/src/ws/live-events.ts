import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";

let wss: WebSocketServer;

export function setupWebSocket(server: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket: WebSocket) => {
    console.log("[ws] client connected — total:", wss.clients.size);

    socket.send(JSON.stringify({ type: "connected" }));

    socket.on("close", () => {
      console.log("[ws] client disconnected — total:", wss.clients.size);
    });

    socket.on("error", (err) => {
      console.error("[ws] socket error:", err.message);
    });
  });

  return wss;
}

export function broadcast(event: { type: string; data?: unknown }): void {
  if (!wss) return;

  const payload = JSON.stringify(event);

  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}
