import { withTimeout } from "./lib";

export type RpcMessage = {
  id?: number;
  method?: string;
  params?: {
    delta?: string;
    threadId?: string;
    turnId?: string;
    turn?: { id?: string; status?: string };
    item?: { type?: string; text?: string };
    [key: string]: unknown;
  };
  result?: unknown;
  error?: { code: number; message: string };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type AccountReadResult = {
  account?: { type?: string; planType?: string };
  requiresOpenaiAuth?: boolean;
};

export type ThreadResult = {
  thread: {
    id: string;
    path?: string;
    status?: unknown;
    turns?: unknown[];
    initialTurnsPage?: { data?: unknown[] };
  };
};

export type TurnResult = { turn: { id: string } };
export type SteerResult = { turnId: string };

export class CodexRpcClient {
  readonly notifications: RpcMessage[] = [];
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as RpcMessage;
      if (typeof message.id === "number" && !message.method) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) this.notifications.push(message);
    });
  }

  static async connect(url: string, name: string): Promise<CodexRpcClient> {
    const socket = new WebSocket(url);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error(`WebSocket failed: ${url}`)), {
          once: true,
        });
      }),
      10_000,
      "Codex app-server WebSocket",
    );
    const client = new CodexRpcClient(socket);
    await client.request("initialize", {
      clientInfo: { name, title: "LLV issue 25 spike", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return client;
  }

  mark(): number {
    return this.notifications.length;
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.#nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    this.#socket.send(JSON.stringify({ method, id, params }));
    return withTimeout(promise, 30_000, `${method} response`);
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.#socket.send(JSON.stringify({ method, params }));
  }

  async waitFor(
    predicate: (message: RpcMessage) => boolean,
    after = 0,
    timeoutMs = 45_000,
  ): Promise<RpcMessage> {
    return withTimeout(
      new Promise<RpcMessage>((resolve, reject) => {
        const poll = () => {
          const match = this.notifications.slice(after).find(predicate);
          if (match) resolve(match);
          else if (this.#socket.readyState >= WebSocket.CLOSING) {
            reject(new Error("Codex app-server WebSocket closed"));
          } else setTimeout(poll, 10);
        };
        poll();
      }),
      timeoutMs,
      "Codex notification",
    );
  }

  close(): void {
    this.#socket.close();
  }
}

export function codexEventSummary(message: RpcMessage): Record<string, unknown> {
  const params = message.params ?? {};
  const item = params.item ?? {};
  return {
    method: message.method,
    threadId: params.threadId,
    turnId: params.turn?.id ?? params.turnId,
    turnStatus: params.turn?.status,
    itemType: item.type,
    text: params.delta ?? item.text,
  };
}

export function codexNotificationText(messages: RpcMessage[]): string {
  return messages
    .flatMap((message) => {
      if (message.method === "item/agentMessage/delta") return [message.params?.delta ?? ""];
      if (
        message.method === "item/completed" &&
        message.params?.item?.type === "agentMessage"
      ) {
        return [message.params.item.text ?? ""];
      }
      return [];
    })
    .join("");
}
