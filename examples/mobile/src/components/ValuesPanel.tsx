/**
 * Everything this device was told, and nothing else.
 *
 * This panel is the whole payload — `{ value, variationIndex, reason }` per
 * flag. There are no rules in it, because the client tier does not send rules:
 * a clause reading `plan in [pro, enterprise]` would tell anyone who unzipped
 * the app that a paid tier exists and what it is called, rollout percentages
 * disclose release plans, and segment definitions name your churn-risk cohort.
 *
 * `internal-pricing-model` is missing for a stronger reason still. It is marked
 * `clientAvailable: false` in `examples/server/flags.js`, so it is not hidden
 * here — it never left the server. The *existence* of an unreleased feature is
 * itself the thing being protected.
 */

import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAllValues } from "../featurekit";
import { mono, theme } from "../theme";
import { Pill } from "./ui";

export function ValuesPanel(): ReactNode {
  const values = useAllValues();
  const keys = Object.keys(values).sort();

  if (keys.length === 0) {
    return <Text style={styles.empty}>No flags held. Reads are returning their defaults.</Text>;
  }

  return (
    <View style={styles.list}>
      {keys.map((key) => {
        const detail = values[key];
        return (
          <View key={key} style={styles.row}>
            <Text style={styles.key} numberOfLines={1}>
              {key}
            </Text>
            <View style={styles.right}>
              <Text style={[styles.value, valueStyle(detail.value)]} numberOfLines={1}>
                {format(detail.value)}
              </Text>
              <Pill
                text={detail.reason}
                color={detail.reason === "RULE_MATCH" ? theme.purple : theme.inkDim}
                background={detail.reason === "RULE_MATCH" ? theme.purpleSoft : theme.surface3}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

function format(value: unknown): string {
  if (typeof value === "string") return value.length === 0 ? '""' : `"${value}"`;
  return JSON.stringify(value) ?? String(value);
}

function valueStyle(value: unknown): { color: string } {
  if (typeof value === "boolean") return { color: value ? theme.success : theme.inkDim };
  if (typeof value === "number") return { color: theme.warning };
  return { color: theme.accent };
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  key: { ...mono, color: theme.inkMuted, fontSize: 12, flex: 1 },
  right: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: "58%" },
  value: { ...mono, fontSize: 12, flexShrink: 1 },
  empty: { color: theme.inkDim, fontSize: 13, fontStyle: "italic" },
});
