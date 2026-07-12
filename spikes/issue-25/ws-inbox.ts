import { withTimeout } from "./lib";

export class WsInbox<T = unknown> {
  readonly messages: T[] = [];
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      this.messages.push(JSON.parse(String(event.data)) as T);
    });
  }

  static async connect<T = unknown>(url: string): Promise<WsInbox<T>> {
    const socket = new WebSocket(url);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error(`WebSocket failed: ${url}`)), {
          once: true,
        });
      }),
      10_000,
      "broker WebSocket",
    );
    return new WsInbox<T>(socket);
  }

  mark(): number {
    return this.messages.length;
  }

  send(value: unknown): void {
    this.#socket.send(JSON.stringify(value));
  }

  async waitFor(
    predicate: (message: T) => boolean,
    after = 0,
    timeoutMs = 90_000,
  ): Promise<T> {
    return withTimeout(
      new Promise<T>((resolve, reject) => {
        const poll = () => {
          const match = this.messages.slice(after).find(predicate);
          if (match) resolve(match);
          else if (this.#socket.readyState >= WebSocket.CLOSING) {
            reject(new Error("Broker WebSocket closed"));
          } else setTimeout(poll, 10);
        };
        poll();
      }),
      timeoutMs,
      "broker event",
    );
  }

  close(): void {
    this.#socket.close();
  }
}
