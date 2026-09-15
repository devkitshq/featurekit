/**
 * The screen the flags actually change.
 *
 * Every read here is `useFlag`, which is synchronous: it never suspends, never
 * returns `undefined`, and needs no context argument, because the connection
 * *is* the context. The default is required — an optional one produces
 * `undefined` during an outage, and `if (undefined)` is a wrong answer that
 * looks like a right one.
 */

import { useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useFlag } from "../featkit";
import type { Persona } from "../personas";
import { mono, theme } from "../theme";
import { Card, Divider, Pill } from "./ui";

const BASE_PRICE = 49;

export function CheckoutCard(props: { persona: Persona }): ReactNode {
  const newCheckout = useFlag("new-checkout", false);
  const discount = useFlag("loyalty-discount", 0);
  // Explicitly `string`: left to infer, the default narrows `T` to the literal
  // `"classic"` and every other variation becomes a type error at the comparison.
  const flow = useFlag<string>("checkout-flow", "classic");

  const [receiptOpen, setReceiptOpen] = useState(false);

  const total = discount > 0 ? BASE_PRICE * (1 - discount / 100) : BASE_PRICE;
  const express = flow === "express";

  return (
    <Card
      title={newCheckout ? "Checkout 2.0" : "Checkout"}
      subtitle={
        newCheckout
          ? "One-click, saved card, instant provisioning."
          : "The standard three-step procurement review."
      }
      accent={newCheckout ? theme.accent : undefined}
    >
      <View style={styles.badges}>
        <Pill
          text={`new-checkout = ${newCheckout ? "ON" : "OFF"}`}
          color={newCheckout ? theme.success : theme.inkDim}
          background={newCheckout ? theme.successSoft : theme.surface3}
        />
        <Pill
          text={express ? "express flow" : "classic flow"}
          color={express ? theme.purple : theme.inkDim}
          background={express ? theme.purpleSoft : theme.surface3}
        />
      </View>

      <View style={styles.priceRow}>
        <Text style={styles.price}>${total.toFixed(2)}</Text>
        {discount > 0 && <Text style={styles.priceWas}>${BASE_PRICE.toFixed(2)}</Text>}
        <Text style={styles.per}>/ month</Text>
      </View>
      <Text style={styles.priceNote}>
        {discount > 0
          ? `loyalty-discount evaluated to ${discount}% for a ${props.persona.context.plan} plan at ${props.persona.context.tenureMonths} months.`
          : "No loyalty discount for this context. Switch to Ben or Cleo above."}
      </Text>

      <Divider />

      {newCheckout ? (
        <View style={styles.lines}>
          <Line icon="💳" label="Visa ···· 4242" note="on file" />
          <Line icon="🚀" label="Instant provisioning" note="no queue" />
          <Line
            icon="⚡"
            label={express ? "Zero-approval flow" : "Standard SLA"}
            note={express ? "express" : "classic"}
          />
        </View>
      ) : (
        <View style={styles.lines}>
          <Step number={1} label="Billing entity" value="Acme Corporation (PO #99281)" />
          <Step number={2} label="Payment method" value="Net-30 corporate invoicing" />
          <Step number={3} label="Approval" value="Pending finance review" />
        </View>
      )}

      <Pressable
        onPress={() => setReceiptOpen(true)}
        style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
        accessibilityRole="button"
      >
        <Text style={styles.ctaText}>
          {newCheckout ? "⚡  One-click order" : "Proceed to review"}
        </Text>
      </Pressable>

      <Receipt
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        persona={props.persona}
        newCheckout={newCheckout}
        discount={discount}
        flow={flow}
        total={total}
      />
    </Card>
  );
}

function Line(props: { icon: string; label: string; note: string }): ReactNode {
  return (
    <View style={styles.line}>
      <Text style={styles.lineIcon}>{props.icon}</Text>
      <Text style={styles.lineLabel}>{props.label}</Text>
      <Text style={styles.lineNote}>{props.note}</Text>
    </View>
  );
}

function Step(props: { number: number; label: string; value: string }): ReactNode {
  return (
    <View style={styles.step}>
      <Text style={styles.stepLabel}>
        Step {props.number} of 3 · {props.label}
      </Text>
      <Text style={styles.stepValue}>{props.value}</Text>
    </View>
  );
}

function Receipt(props: {
  open: boolean;
  onClose: () => void;
  persona: Persona;
  newCheckout: boolean;
  discount: number;
  flow: string;
  total: number;
}): ReactNode {
  return (
    <Modal visible={props.open} transparent animationType="fade" onRequestClose={props.onClose}>
      <Pressable style={styles.backdrop} onPress={props.onClose}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <Text style={styles.sheetTitle}>
            {props.newCheckout ? "⚡ Order placed" : "✅ Submitted for review"}
          </Text>
          <Text style={styles.sheetBody}>
            {props.newCheckout
              ? "Charged to the saved token and provisioned immediately."
              : "Routed to finance. An invoice follows within one business day."}
          </Text>
          <Divider />
          <ReceiptRow
            label="Customer"
            value={`${props.persona.context.name} · ${props.persona.context.plan}`}
          />
          <ReceiptRow label="Billed" value={`$${props.total.toFixed(2)} / mo`} />
          <ReceiptRow label="Discount" value={`${props.discount}%`} />
          <ReceiptRow label="Flow" value={props.flow} />
          <ReceiptRow label="Engine" value={props.newCheckout ? "checkout 2.0" : "classic"} />
          <Pressable
            onPress={props.onClose}
            style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
          >
            <Text style={styles.ctaText}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ReceiptRow(props: { label: string; value: string }): ReactNode {
  return (
    <View style={styles.receiptRow}>
      <Text style={styles.receiptLabel}>{props.label}</Text>
      <Text style={styles.receiptValue}>{props.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badges: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  priceRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  price: { ...mono, color: theme.ink, fontSize: 30, fontWeight: "700" },
  priceWas: {
    ...mono,
    color: theme.inkDim,
    fontSize: 15,
    textDecorationLine: "line-through",
  },
  per: { color: theme.inkDim, fontSize: 13 },
  priceNote: { color: theme.inkMuted, fontSize: 12, lineHeight: 18 },

  lines: { gap: 8 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  lineIcon: { fontSize: 14 },
  lineLabel: { color: theme.ink, fontSize: 13, flex: 1 },
  lineNote: { ...mono, color: theme.inkDim, fontSize: 11 },

  step: {
    backgroundColor: theme.surface2,
    borderRadius: 10,
    padding: 10,
    gap: 2,
  },
  stepLabel: { color: theme.inkDim, fontSize: 11, letterSpacing: 0.2 },
  stepValue: { color: theme.ink, fontSize: 13 },

  cta: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  ctaPressed: { opacity: 0.8 },
  ctaText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },

  backdrop: {
    flex: 1,
    backgroundColor: "rgba(4, 6, 10, 0.72)",
    justifyContent: "center",
    padding: 22,
  },
  sheet: {
    backgroundColor: theme.surface1,
    borderColor: theme.lineHighlight,
    borderWidth: 1,
    borderRadius: 18,
    padding: 20,
    gap: 12,
  },
  sheetTitle: { color: theme.ink, fontSize: 18, fontWeight: "700" },
  sheetBody: { color: theme.inkMuted, fontSize: 13, lineHeight: 19 },
  receiptRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  receiptLabel: { color: theme.inkDim, fontSize: 12 },
  receiptValue: { ...mono, color: theme.ink, fontSize: 12 },
});
