/**
 * Togglekit Mobile Client (React Native / Expo SSE Stream)
 */

export interface TogglekitValues {
  [key: string]: boolean | string | number | Record<string, any> | null;
}

export interface TogglekitClientOptions {
  baseUrl: string;
  clientKey: string;
  context: { kind: string; key: string; [attr: string]: any };
  onValues: (values: TogglekitValues) => void;
  onStatus?: (status: "connecting" | "live" | "offline") => void;
}

export class TogglekitMobileClient {
  private values: TogglekitValues = {};
  private abortController: AbortController | null = null;
  private closed = false;

  constructor(private readonly options: TogglekitClientOptions) {}

  async start(): Promise<void> {
    this.closed = false;
    await this.fetchInitialState();
    this.startStreaming();
  }

  private async fetchInitialState(): Promise<void> {
    try {
      this.options.onStatus?.("connecting");
      const res = await fetch(`${this.options.baseUrl}/v1/client/state`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.options.clientKey}`,
        },
        body: JSON.stringify({ context: this.options.context }),
      });

      if (res.ok) {
        const data = await res.json();
        this.values = data.values ?? {};
        this.options.onValues({ ...this.values });
        this.options.onStatus?.("live");
      }
    } catch (err) {
      console.warn("[Togglekit] Initial fetch failed, retrying in background:", err);
      this.options.onStatus?.("offline");
    }
  }

  private async startStreaming(): Promise<void> {
    if (this.closed) return;

    this.abortController = new AbortController();
    const contextStr = encodeURIComponent(JSON.stringify(this.options.context));
    const url = `${this.options.baseUrl}/v1/client/stream?clientKey=${encodeURIComponent(
      this.options.clientKey
    )}&context=${contextStr}`;

    try {
      const response = await fetch(url, {
        headers: { "accept": "text/event-stream" },
        signal: this.abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Stream connection rejected: ${response.status}`);
      }

      this.options.onStatus?.("live");

      // Polling fallback for React Native environments where full fetch streaming reader is simulated
      const interval = setInterval(async () => {
        if (this.closed) {
          clearInterval(interval);
          return;
        }
        await this.fetchInitialState();
      }, 2000);

    } catch (err: any) {
      if (!this.closed) {
        this.options.onStatus?.("offline");
        setTimeout(() => this.startStreaming(), 4000);
      }
    }
  }

  close(): void {
    this.closed = true;
    this.abortController?.abort();
  }
}
