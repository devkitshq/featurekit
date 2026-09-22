import React, { useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  SafeAreaView,
  ActivityIndicator,
  Switch,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { SERVER_URL, CLIENT_KEY } from "./config";
import { FeaturekitMobileClient, FeaturekitValues } from "./featurekit";

export default function App() {
  const [values, setValues] = useState<FeaturekitValues>({
    "feature-toggle": true,
    "headline-text": "🚀 Welcome to Featurekit Mobile Demo",
    "discount-number": 25,
    "theme-config": { theme: "indigo", accentColor: "#6366f1", badge: "PRO EDITION", cardRadius: 16 },
  });
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [swapping, setSwapping] = useState(false);
  const [eventLog, setEventLog] = useState<string[]>([]);

  useEffect(() => {
    const client = new FeaturekitMobileClient({
      baseUrl: SERVER_URL,
      clientKey: CLIENT_KEY,
      context: { kind: "user", key: "mobile-user-1" },
      onValues: (newVals) => {
        setValues(newVals);
        setEventLog((prev) => [
          `${new Date().toLocaleTimeString()} • Updated flags`,
          ...prev.slice(0, 4),
        ]);
      },
      onStatus: setStatus,
    });

    client.start();
    return () => client.close();
  }, []);

  const handleSwap = async () => {
    setSwapping(true);
    try {
      await fetch(`${SERVER_URL}/api/swap`, { method: "POST" });
    } catch (err) {
      console.warn("Failed to trigger swap:", err);
    } finally {
      setTimeout(() => setSwapping(false), 500);
    }
  };

  const isToggleOn = Boolean(values["feature-toggle"]);
  const headline = String(values["headline-text"] ?? "Featurekit Live");
  const discount = Number(values["discount-number"] ?? 0);
  const themeObj: any = values["theme-config"] ?? { accentColor: "#6366f1", badge: "PRO" };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scroll}>
        
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.badge}><Text style={styles.badgeText}>TK</Text></View>
            <View>
              <Text style={styles.brandTitle}>Featurekit</Text>
              <Text style={styles.brandSubtitle}>Mobile App Live Demo</Text>
            </View>
          </View>

          <View style={[styles.statusPill, status === "live" && styles.statusLive]}>
            <View style={[styles.dot, status === "live" && styles.dotLive]} />
            <Text style={styles.statusText}>{status.toUpperCase()}</Text>
          </View>
        </View>

        {/* Swap Trigger Button */}
        <TouchableOpacity
          style={[styles.swapButton, swapping && { opacity: 0.6 }]}
          onPress={handleSwap}
          disabled={swapping}
        >
          {swapping ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.swapButtonText}>⚡ Swap Flags on Server</Text>
          )}
        </TouchableOpacity>

        {/* Headline Banner */}
        <View style={styles.heroCard}>
          <Text style={styles.heroSub}>HEADLINE STRING FLAG</Text>
          <Text style={styles.heroTitle}>{headline}</Text>
        </View>

        {/* 1. Toggle (Boolean Flag) */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={[styles.tag, styles.tagBoolean]}>BOOLEAN</Text>
            <Text style={styles.flagKey}>feature-toggle</Text>
          </View>
          <Text style={styles.cardTitle}>1. Feature Toggle</Text>
          <View style={styles.toggleRow}>
            <Switch
              value={isToggleOn}
              trackColor={{ false: "#334155", true: "#10b981" }}
              thumbColor="#fff"
              disabled
            />
            <Text style={[styles.toggleState, { color: isToggleOn ? "#10b981" : "#94a3b8" }]}>
              {isToggleOn ? "ENABLED (true)" : "DISABLED (false)"}
            </Text>
          </View>
        </View>

        {/* 2. Number Flag */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={[styles.tag, styles.tagNumber]}>NUMBER</Text>
            <Text style={styles.flagKey}>discount-number</Text>
          </View>
          <Text style={styles.cardTitle}>2. Discount Percentage</Text>
          <View style={styles.numberRow}>
            <View style={styles.numberCircle}>
              <Text style={styles.numberValue}>{discount}%</Text>
            </View>
            <View>
              <Text style={styles.numberTitle}>Dynamic Numeric Rate</Text>
              <Text style={styles.numberSub}>Calculated directly from flag</Text>
            </View>
          </View>
        </View>

        {/* 3. JSON Object Flag */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={[styles.tag, styles.tagJson]}>JSON OBJECT</Text>
            <Text style={styles.flagKey}>theme-config</Text>
          </View>
          <Text style={styles.cardTitle}>3. Theme & UI Config</Text>

          {/* Dynamic Rendered Box */}
          <View
            style={[
              styles.themeBox,
              {
                borderColor: themeObj.accentColor || "#6366f1",
                borderRadius: themeObj.cardRadius || 16,
              },
            ]}
          >
            <View
              style={[
                styles.themeBadge,
                { backgroundColor: themeObj.accentColor || "#6366f1" },
              ]}
            >
              <Text style={styles.themeBadgeText}>{themeObj.badge || "PRO"}</Text>
            </View>
            <Text style={styles.themeBoxText}>Dynamic Theme Container</Text>
          </View>

          {/* Raw JSON */}
          <View style={styles.jsonBox}>
            <Text style={styles.jsonCode}>{JSON.stringify(themeObj, null, 2)}</Text>
          </View>
        </View>

        {/* Live Event Ticker */}
        <View style={styles.eventsCard}>
          <Text style={styles.eventsTitle}>Real-Time Updates Received</Text>
          {eventLog.length === 0 ? (
            <Text style={styles.eventsEmpty}>Listening for live SSE events…</Text>
          ) : (
            eventLog.map((log, idx) => (
              <Text key={idx} style={styles.eventItem}>• {log}</Text>
            ))
          )}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b0f19",
  },
  scroll: {
    padding: 20,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  badge: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: "#6366f1",
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#fff",
    fontWeight: "bold",
    fontSize: 16,
  },
  brandTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#fff",
  },
  brandSubtitle: {
    fontSize: 12,
    color: "#94a3b8",
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  statusLive: {
    backgroundColor: "rgba(16,185,129,0.15)",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#64748b",
  },
  dotLive: {
    backgroundColor: "#10b981",
  },
  statusText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#e2e8f0",
  },
  swapButton: {
    backgroundColor: "#6366f1",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    marginBottom: 20,
    shadowColor: "#6366f1",
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
  },
  swapButtonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 15,
  },
  heroCard: {
    backgroundColor: "rgba(99,102,241,0.12)",
    borderColor: "rgba(99,102,241,0.3)",
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  heroSub: {
    fontSize: 10,
    fontWeight: "800",
    color: "#818cf8",
    marginBottom: 4,
  },
  heroTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#fff",
  },
  card: {
    backgroundColor: "rgba(18,24,38,0.9)",
    borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  tag: {
    fontSize: 10,
    fontWeight: "800",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  tagBoolean: { backgroundColor: "rgba(99,102,241,0.2)", color: "#818cf8" },
  tagNumber: { backgroundColor: "rgba(245,158,11,0.2)", color: "#fbbf24" },
  tagJson: { backgroundColor: "rgba(244,63,94,0.2)", color: "#fb7185" },
  flagKey: {
    fontSize: 12,
    fontFamily: "monospace",
    color: "#94a3b8",
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 12,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(0,0,0,0.25)",
    padding: 12,
    borderRadius: 12,
  },
  toggleState: {
    fontSize: 14,
    fontWeight: "700",
  },
  numberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: "rgba(0,0,0,0.25)",
    padding: 12,
    borderRadius: 12,
  },
  numberCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 2,
    borderColor: "#f59e0b",
    backgroundColor: "rgba(245,158,11,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  numberValue: {
    fontSize: 16,
    fontWeight: "800",
    color: "#f59e0b",
  },
  numberTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
  },
  numberSub: {
    fontSize: 11,
    color: "#94a3b8",
  },
  themeBox: {
    borderWidth: 2,
    padding: 14,
    backgroundColor: "rgba(0,0,0,0.25)",
    marginBottom: 10,
  },
  themeBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginBottom: 6,
  },
  themeBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
  },
  themeBoxText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
  jsonBox: {
    backgroundColor: "#060911",
    padding: 10,
    borderRadius: 8,
  },
  jsonCode: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#e2e8f0",
  },
  eventsCard: {
    backgroundColor: "#060911",
    borderColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginTop: 8,
    marginBottom: 20,
  },
  eventsTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#94a3b8",
    marginBottom: 6,
  },
  eventsEmpty: {
    fontSize: 11,
    color: "#64748b",
  },
  eventItem: {
    fontSize: 11,
    fontFamily: "monospace",
    color: "#38bdf8",
    marginBottom: 2,
  },
});
