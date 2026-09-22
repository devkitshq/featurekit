/**
 * Acme Cloud, on a phone.
 *
 * The same flags, the same personas and the same control plane as the browser
 * demo in `examples/app` — run both at once and they agree, because the answer
 * is computed in one place and pushed to whoever is connected.
 *
 * There is no React Native SDK, and no React SDK either. `togglekit-client` is
 * one client with no framework bindings; `src/togglekit.ts` is the whole React
 * adapter, twenty lines of `useSyncExternalStore` copied from
 * `docs/client-tier/adapters.md`. The only things this app supplies that a
 * browser supplies for itself are a streaming `fetch` and the address of the
 * machine running the server (see `src/config.ts`).
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { CONFIG_URL, CONTROL_PLANE_URL, DASHBOARD_URL, loadConfig, type AppConfig } from "./config";
import { createClient, togglekit, hasStreaming, useTogglekitState, useFlag } from "./togglekit";
import { PERSONAS, type Persona } from "./personas";
import { theme } from "./theme";
import { CheckoutCard } from "./components/CheckoutCard";
import { EventLog, useEventLog, type Entry } from "./components/EventLog";
import { PersonaSwitcher } from "./components/PersonaSwitcher";
import { ValuesPanel } from "./components/ValuesPanel";
import { Card, Pill, stateColor } from "./components/ui";

export default function App(): ReactNode {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [persona, setPersona] = useState<Persona>(PERSONAS[0]);
  const [ready, setReady] = useState(false);
  const log = useEventLog();

  const connect = (): void => {
    setError(null);
    setConfig(null);
    loadConfig().then(setConfig, (cause: unknown) =>
      setError(String((cause as Error).message ?? cause)),
    );
  };

  useEffect(connect, []);

  // Built once, when the key arrives. With no provider there is nowhere else to
  // put this — which is the trade: one `useEffect` instead of a package.
  useEffect(() => {
    if (config === null) return;
    createClient({
      clientKey: config.clientKey,
      baseUrl: config.baseUrl,
      context: persona.context,
      onError: (cause) => log.append("bad", String((cause as Error)?.message ?? cause)),
    });
    setReady(true);
    // `persona` is deliberately not a dependency: a persona change is an
    // `identify()` below, never a second client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // The SDK's two event streams, into the log.
  useEffect(() => {
    if (!ready) return;
    const client = togglekit();
    const offState = client.on("state", (state) => {
      log.append(state === "offline" ? "bad" : "state", `connection ${state}`);
    });
    const offChange = client.on("change", (keys) => {
      for (const key of keys) {
        const detail = client.detail(key);
        log.append("push", `${key} = ${JSON.stringify(detail?.value)} (${detail?.reason})`);
      }
    });
    return () => {
      offState();
      offChange();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // iOS suspends the app, timers stop, and the SSE socket dies without the SDK
  // noticing. `identify()` with an unchanged key keeps the held values and just
  // refreshes, so there is no blank frame on resume.
  useEffect(() => {
    if (!ready) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void togglekit().identify(persona.context);
    });
    return () => subscription.remove();
  }, [ready, persona]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.root} edges={["top", "left", "right"]}>
        {error !== null ? (
          <Unreachable message={error} onRetry={connect} />
        ) : !ready ? (
          <Connecting />
        ) : (
          <Screen
            persona={persona}
            entries={log.entries}
            onSelect={(next) => {
              if (next.id === persona.id) return;
              log.append("who", `identify(${next.context.key}) — previous values dropped`);
              setPersona(next);
              // The one async operation. On a key change the SDK empties its
              // values before this promise settles, so nothing renders Ana's
              // flags to Ben — not even for a frame.
              void togglekit().identify(next.context);
            }}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Screen(props: {
  persona: Persona;
  entries: readonly Entry[];
  onSelect: (persona: Persona) => void;
}): ReactNode {
  const state = useTogglekitState();
  const promo = useFlag("promo-banner", "");
  const pill = stateColor(state);

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.brand}>Acme Cloud</Text>
          <Text style={styles.who}>
            {props.persona.context.name} · {props.persona.context.plan}
          </Text>
        </View>
        <Pill text={state} color={pill.color} background={pill.background} />
      </View>

      {promo.trim().length > 0 && (
        <View style={styles.promo}>
          <Text style={styles.promoText}>{promo}</Text>
          <Text style={styles.promoTag}>promo-banner</Text>
        </View>
      )}

      <Card
        title="Who is asking"
        subtitle="Tapping a name calls identify(). The previous user's values are dropped before the network answers."
      >
        <PersonaSwitcher selected={props.persona} onSelect={props.onSelect} />
      </Card>

      <CheckoutCard persona={props.persona} />

      <Card
        title="What this device was told"
        subtitle="Evaluated values and their reasons. No rules, no rollout percentages, no segment definitions."
      >
        <ValuesPanel />
      </Card>

      <Card title="SDK events" subtitle="State transitions and pushed changes, newest first.">
        <EventLog entries={props.entries} />
      </Card>

      <Card
        title="Flip a flag and watch"
        subtitle="Open the dashboard on your laptop and toggle new-checkout. This screen moves within a second, on the connection it already holds."
      >
        <Pressable onPress={() => void Linking.openURL(DASHBOARD_URL)}>
          <Text style={styles.link}>{DASHBOARD_URL}</Text>
        </Pressable>
        <Text style={styles.footnote}>
          {hasStreaming
            ? "Updates arrive over a held-open SSE stream, read with expo/fetch."
            : "expo/fetch is unavailable, so the SDK is reconnecting on a timer instead of streaming."}
        </Text>
      </Card>
    </ScrollView>
  );
}

function Connecting(): ReactNode {
  return (
    <View style={styles.centre}>
      <ActivityIndicator color={theme.accent} />
      <Text style={styles.centreText}>Asking {CONFIG_URL} for a client key…</Text>
    </View>
  );
}

/**
 * The failure worth handling well, because it is the one everybody hits first:
 * a phone cannot reach `127.0.0.1` on your laptop, and a device on cellular
 * cannot reach your laptop at all.
 */
function Unreachable(props: { message: string; onRetry: () => void }): ReactNode {
  return (
    <View style={styles.centre}>
      <Text style={styles.errorTitle}>Cannot reach the demo server</Text>
      <Text style={styles.errorBody}>{props.message}</Text>
      <View style={styles.errorBox}>
        <Text style={styles.errorLine}>config {CONFIG_URL}</Text>
        <Text style={styles.errorLine}>flags  {CONTROL_PLANE_URL}</Text>
      </View>
      <Text style={styles.errorBody}>
        Run `npm run demo` in the repository root, and make sure this device is on the same network
        as that machine. If the host above is wrong, set EXPO_PUBLIC_TOGGLEKIT_URL and
        EXPO_PUBLIC_TOGGLEKIT_CONFIG_URL — see the README.
      </Text>
      <Pressable
        onPress={props.onRetry}
        style={({ pressed }) => [styles.retry, pressed && { opacity: 0.8 }]}
      >
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 16, gap: 14, paddingBottom: 40 },

  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  headerText: { flex: 1, gap: 1 },
  brand: { color: theme.ink, fontSize: 22, fontWeight: "700", letterSpacing: -0.3 },
  who: { color: theme.inkDim, fontSize: 12 },

  promo: {
    backgroundColor: theme.accentSoft,
    borderColor: theme.accent,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  promoText: { color: theme.ink, fontSize: 13, lineHeight: 19 },
  promoTag: { color: theme.accent, fontSize: 10, fontFamily: "monospace" },

  link: { color: theme.accent, fontSize: 13, fontFamily: "monospace" },
  footnote: { color: theme.inkDim, fontSize: 11, lineHeight: 16 },

  centre: { flex: 1, justifyContent: "center", padding: 26, gap: 12 },
  centreText: { color: theme.inkMuted, fontSize: 13, textAlign: "center" },
  errorTitle: { color: theme.ink, fontSize: 18, fontWeight: "700" },
  errorBody: { color: theme.inkMuted, fontSize: 13, lineHeight: 19 },
  errorBox: {
    backgroundColor: theme.surface1,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 3,
  },
  errorLine: { color: theme.inkMuted, fontSize: 11, fontFamily: "monospace" },
  retry: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  retryText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
});
