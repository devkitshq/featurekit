/**
 * The switch that makes the point.
 *
 * Tapping a persona calls `identify()`. On a context-key change the SDK drops
 * the previous user's values *before* the network is asked, so between the tap
 * and the response every read returns the caller's default — never the person
 * you just switched away from. Watch the values panel blank for a frame.
 */

import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PERSONAS, type Persona } from "../personas";
import { theme } from "../theme";

export function PersonaSwitcher(props: {
  selected: Persona;
  onSelect: (persona: Persona) => void;
}): ReactNode {
  return (
    <View style={styles.row}>
      {PERSONAS.map((persona) => {
        const active = persona.id === props.selected.id;
        return (
          <Pressable
            key={persona.id}
            onPress={() => props.onSelect(persona)}
            style={({ pressed }) => [
              styles.chip,
              active && styles.chipActive,
              pressed && styles.chipPressed,
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{persona.label}</Text>
            <Text style={[styles.plan, active && styles.planActive]}>
              {persona.context.plan} · {persona.context.tenureMonths}mo
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  chip: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.line,
    backgroundColor: theme.surface2,
    alignItems: "center",
    gap: 2,
  },
  chipActive: { borderColor: theme.accent, backgroundColor: theme.accentSoft },
  chipPressed: { opacity: 0.7 },
  label: { color: theme.inkMuted, fontSize: 14, fontWeight: "600" },
  labelActive: { color: theme.ink },
  plan: { color: theme.inkDim, fontSize: 11 },
  planActive: { color: theme.accent },
});
