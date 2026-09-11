/**
 * What the SDK did, in order.
 *
 * Two subscriptions, both returning an unsubscribe function:
 *
 *   client.on("state", ...)    initializing → ready → identifying → offline
 *   client.on("change", ...)   the flag keys that just moved
 *
 * A `change` with no `identify()` before it is a push: somebody flipped a flag
 * in the dashboard and the open stream delivered it. No polling, no reload.
 */

import { useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { mono, theme } from "../theme";

export type EntryKind = "state" | "push" | "who" | "bad";

export interface Entry {
  id: number;
  at: string;
  kind: EntryKind;
  message: string;
}

const LIMIT = 30;

/** Owned above the provider's subtree so persona switches can write to it too. */
export function useEventLog(): {
  entries: Entry[];
  append: (kind: EntryKind, message: string) => void;
} {
  const [entries, setEntries] = useState<Entry[]>([]);
  const nextId = useRef(0);

  const append = (kind: EntryKind, message: string): void => {
    const entry: Entry = {
      id: nextId.current++,
      at: new Date().toLocaleTimeString(),
      kind,
      message,
    };
    setEntries((previous) => [entry, ...previous].slice(0, LIMIT));
  };

  return { entries, append };
}

export function EventLog(props: { entries: readonly Entry[] }): ReactNode {
  if (props.entries.length === 0) {
    return <Text style={styles.empty}>Nothing yet.</Text>;
  }
  return (
    <View style={styles.list}>
      {props.entries.map((entry) => (
        <View key={entry.id} style={styles.row}>
          <Text style={styles.time}>{entry.at}</Text>
          <Text style={[styles.message, { color: colorFor(entry.kind) }]}>{entry.message}</Text>
        </View>
      ))}
    </View>
  );
}

function colorFor(kind: EntryKind): string {
  if (kind === "push") return theme.success;
  if (kind === "who") return theme.accent;
  if (kind === "bad") return theme.danger;
  return theme.inkMuted;
}

const styles = StyleSheet.create({
  list: { gap: 6 },
  row: { flexDirection: "row", gap: 8 },
  time: { ...mono, color: theme.inkDim, fontSize: 11 },
  message: { ...mono, fontSize: 11, flex: 1 },
  empty: { color: theme.inkDim, fontSize: 13, fontStyle: "italic" },
});
