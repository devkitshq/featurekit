/**
 * Featurekit Mobile Client (React Native / Expo SSE Stream)
 *
 * Uses 'featurekit-client' to evaluate feature flags and subscribe to real-time updates.
 */

import { fetch as expoFetch } from "expo/fetch";
import { FeaturekitClient, type FlagValue } from "featurekit-client";

export type FeaturekitValues = Record<string, FlagValue>;

export interface FeaturekitMobileClientOptions {
  baseUrl: string;
  clientKey: string;
  context: { kind: string; key: string; [attr: string]: any };
  onValues: (values: FeaturekitValues) => void;
  onStatus?: (status: "connecting" | "live" | "offline") => void;
}

export class FeaturekitMobileClient {
  private client: FeaturekitClient;
  private unsubscribeChange?: () => void;
  private unsubscribeState?: () => void;

  constructor(private readonly options: FeaturekitMobileClientOptions) {
    this.client = new FeaturekitClient({
      baseUrl: options.baseUrl,
      clientKey: options.clientKey,
      context: options.context,
      // React Native's built-in fetch cannot stream, so without this the SSE
      // stream never opens and the client falls back to polling.
      fetchImpl: expoFetch as unknown as typeof fetch,
      onError: (err) => {
        console.warn("[Featurekit Mobile] Error:", err);
      },
    });

    this.unsubscribeState = this.client.on("state", (state) => {
      if (state === "ready") {
        this.options.onStatus?.("live");
      } else if (state === "offline") {
        this.options.onStatus?.("offline");
      } else {
        this.options.onStatus?.("connecting");
      }
    });

    this.unsubscribeChange = this.client.on("change", () => {
      this.options.onValues(this.getAllValues());
    });
  }

  async start(): Promise<void> {
    this.options.onStatus?.("connecting");
    try {
      await this.client.ready();
      this.options.onValues(this.getAllValues());
      this.options.onStatus?.("live");
    } catch {
      this.options.onStatus?.("offline");
    }
  }

  getAllValues(): FeaturekitValues {
    const valObj: FeaturekitValues = {
      "feature-toggle": this.client.get("feature-toggle", true),
      "headline-text": this.client.get("headline-text", "🚀 Welcome to Featurekit Mobile Demo"),
      "discount-number": this.client.get("discount-number", 25),
      "theme-config": this.client.get("theme-config", {
        theme: "indigo",
        accentColor: "#6366f1",
        badge: "PRO EDITION",
        cardRadius: 16,
      }),
    };
    return valObj;
  }

  close(): void {
    this.unsubscribeChange?.();
    this.unsubscribeState?.();
    this.client.close();
  }
}

export { FeaturekitClient };
