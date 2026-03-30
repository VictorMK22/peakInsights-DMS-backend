declare module "y-websocket/bin/utils.js" {
    import { IncomingMessage } from "http";
    import { WebSocket } from "ws";
    import * as Y from "yjs";
  
    export function setupWSConnection(
      conn: WebSocket,
      req: IncomingMessage,
      opts?: { doc: Y.Doc }
    ): void;
  }