/** The handful of primitives the screen is built from. */

import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { mono, theme } from "../theme";

export function Card(props: {
  title?: string;
  subtitle?: string;
  accent?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <View style={[styles.card, props.accent !== undefined && { borderColor: props.accent }]}>
      {props.title !== undefined && (
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>{props.title}</Text>
          {props.subtitle !== undefined && (
            <Text style={styles.cardSubtitle}>{props.subtitle}</Text>
          )}
        </View>
      )}
      {props.children}
    </View>
  );
}

export function Pill(props: { text: string; color?: string; background?: string }): ReactNode {
  return (
    <View style={[styles.pill, { backgroundColor: props.background ?? theme.surface3 }]}>
      <Text style={[styles.pillText, { color: props.color ?? theme.inkMuted }]}>{props.text}</Text>
    </View>
  );
}

export function Code(props: { children: string }): ReactNode {
  return <Text style={styles.code}>{props.children}</Text>;
}

export function Divider(): ReactNode {
  return <View style={styles.divider} />;
}

/** The colours the SDK's four connection states deserve. */
export function stateColor(state: string): { color: string; background: string } {
  if (state === "ready") return { color: theme.success, background: theme.successSoft };
  if (state === "identifying") return { color: theme.warning, background: theme.warningSoft };
  if (state === "offline") return { color: theme.danger, background: theme.dangerSoft };
  return { color: theme.inkMuted, background: theme.surface3 };
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.surface1,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  cardHead: { gap: 2 },
  cardTitle: { color: theme.ink, fontSize: 16, fontWeight: "600" },
  cardSubtitle: { color: theme.inkDim, fontSize: 12, lineHeight: 17 },
  pill: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  pillText: { fontSize: 11, fontWeight: "600", letterSpacing: 0.3 },
  code: { ...mono, color: theme.inkMuted, fontSize: 12 },
  divider: { height: 1, backgroundColor: theme.line },
});
