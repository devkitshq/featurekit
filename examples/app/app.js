/**
 * The Togglekit Browser Demo Application.
 *
 * Demonstrates:
 * 1. Synchronous reads: `tk.get(...)`, `tk.get(...)`, `tk.get(...)` never await.
 * 2. Instant persona switching: `identify()` drops previous values before network answers.
 * 3. Live push updates: SSE stream reacts in real-time to changes made in Togglekit Admin.
 * 4. Zero rules leakage: Browser receives evaluated values and reasons, never targeting rules.
 */

import { TogglekitClient } from "/sdk.js";

const PERSONAS = {
  ana: { key: "u-ana", name: "Ana", plan: "free", tenureMonths: 2 },
  ben: { key: "u-ben", name: "Ben", plan: "pro", tenureMonths: 18 },
  cleo: { key: "u-cleo", name: "Cleo", plan: "enterprise", tenureMonths: 40 },
};

const $ = (id) => document.getElementById(id);

// Load client SDK key and server baseUrl from the app's own backend
const { clientKey, baseUrl } = await (await fetch("/api/config")).json();

// Set dashboard links
const adminUrl = `${baseUrl}/admin`;
if ($("admin-top-link")) $("admin-top-link").href = adminUrl;
if ($("dash-inline-link")) $("dash-inline-link").href = adminUrl;
if ($("dash-footer-link")) $("dash-footer-link").href = adminUrl;

let currentPersona = "ana";

// Initialize Togglekit Browser SDK
const tk = new TogglekitClient({
  clientKey,
  baseUrl,
  context: PERSONAS[currentPersona],
  stream: true,
  onError: (error) => log(`SDK Error: ${String(error)}`, "bad"),
});

// SDK Connection State listener
tk.on("state", (state) => {
  console.log(`[Togglekit SDK] Connection state changed: %c${state}`, "color: #3b82f6; font-weight: bold");
  const pill = $("state");
  pill.textContent = state;
  pill.dataset["state"] = state;
  log(`Connection state: ${state}`, state === "ready" ? "change" : "");
});

// Real-time SSE changes listener
tk.on("change", (changedKeys) => {
  console.log(`%c[Togglekit SSE] Push received!%c Flags updated: ${changedKeys.join(", ")}`, "color: #10b981; font-weight: bold", "color: inherit");
  for (const key of changedKeys) {
    const detail = tk.detail(key);
    console.log(`  └─ [${key}] =`, detail);
    log(`SSE Push: Flag '${key}' updated → ${JSON.stringify(detail?.value)}`, "change");
  }
  render();
});

// Wait for initial evaluation
await tk.ready();
console.log(`[Togglekit SDK] Ready. Initial evaluated flags for ${PERSONAS[currentPersona].name}:`, tk.allValues());
log(`SDK ready for ${PERSONAS[currentPersona].name} (${PERSONAS[currentPersona].plan})`, "who");
render();

// Persona Switch Handler
$("persona").addEventListener("change", async (event) => {
  currentPersona = event.target.value;
  // Instantly drop prior values and re-render so no stale flags are displayed
  render();
  log(`Switching persona to ${PERSONAS[currentPersona].name} (${PERSONAS[currentPersona].plan})...`, "who");
  
  await tk.identify(PERSONAS[currentPersona]);
  log(`Identified as ${PERSONAS[currentPersona].name}`, "who");
  render();
});

// Clear Log Button
$("clear-log-btn")?.addEventListener("click", () => {
  $("log").innerHTML = "";
});

// Interactive Checkout Modal
$("checkout-cta").addEventListener("click", () => {
  const newCheckout = tk.get("new-checkout", false);
  const discount = tk.get("loyalty-discount", 0);
  const flow = tk.get("checkout-flow", "classic");
  const price = 49.00;
  const finalPrice = discount > 0 ? (price * (1 - discount / 100)).toFixed(2) : price.toFixed(2);

  $("modal-title").textContent = newCheckout ? "⚡ One-Click Order Placed!" : "✅ Order Submitted";
  $("modal-desc").textContent = newCheckout
    ? "Processed instantly via saved payment token with 0 latency."
    : "Standard order confirmed. Invoice sent to your billing address.";

  $("modal-meta").innerHTML = `
    <div><strong>Customer:</strong> ${escape(PERSONAS[currentPersona].name)} (${escape(PERSONAS[currentPersona].plan)})</div>
    <div><strong>Total Billed:</strong> $${finalPrice} / mo (Saved: ${discount}%)</div>
    <div><strong>Flow Variant:</strong> ${escape(flow)}</div>
    <div><strong>Checkout Engine:</strong> ${newCheckout ? "Checkout 2.0 (Flag ON)" : "Classic (Flag OFF)"}</div>
  `;

  $("checkout-modal").classList.remove("hidden");
  log(`Checkout initiated by ${PERSONAS[currentPersona].name} for $${finalPrice}`, "change");
});

$("modal-close-btn").addEventListener("click", () => {
  $("checkout-modal").classList.add("hidden");
});

$("checkout-cancel").addEventListener("click", () => {
  log("Checkout action cancelled by user", "");
});

/* ────────────────────────── Rendering Logic ────────────────────────── */

function render() {
  // 1. Synchronous Feature Flag Evaluations
  const newCheckout = tk.get("new-checkout", false);
  const discount = tk.get("loyalty-discount", 0);
  const flow = tk.get("checkout-flow", "classic");
  const promoBanner = tk.get("promo-banner", "");

  // 2. Promo Announcement Banner
  const promoBar = $("promo-bar");
  if (promoBanner && promoBanner.trim().length > 0) {
    promoBar.classList.remove("hidden");
    $("promo-text").textContent = promoBanner;
  } else {
    promoBar.classList.add("hidden");
  }

  // 3. Checkout Card Header & Variants
  const panel = $("checkout-panel");
  panel.dataset["variant"] = newCheckout ? "new" : "classic";

  $("checkout-title").textContent = newCheckout ? "Checkout 2.0" : "Checkout";
  $("checkout-copy").textContent = newCheckout
    ? "Instant one-click checkout with Apple Pay & saved card on file."
    : "The standard 3-step procurement review flow.";

  const flagTag = $("flag-tag-indicator");
  flagTag.textContent = `flag: new-checkout = ${newCheckout ? "ON" : "OFF"}`;
  flagTag.style.color = newCheckout ? "var(--success)" : "var(--ink-dim)";

  const flowBadge = $("flow-badge");
  flowBadge.textContent = flow === "express" ? "⚡ Express Flow" : "Standard Flow";
  flowBadge.className = `flow-pill ${flow === "express" ? "express" : ""}`;

  // 4. Dynamic Pricing Calculation
  const basePrice = 49.00;
  const finalPrice = discount > 0 ? (basePrice * (1 - discount / 100)).toFixed(2) : basePrice.toFixed(2);
  const pricingBox = $("checkout-pricing-box");

  pricingBox.innerHTML = `
    <div class="pricing-row">
      <span class="price-main">$${finalPrice}</span>
      ${discount > 0 ? `<span class="price-original">$${basePrice.toFixed(2)}</span>` : ""}
      <span class="muted">/ month</span>
      ${discount > 0 ? `<span class="discount-badge">−${discount}% Member Savings</span>` : ""}
    </div>
    <div class="pricing-note">
      ${discount > 0
        ? `Flag <code>loyalty-discount</code> evaluated to <strong>${discount}%</strong> based on your ${PERSONAS[currentPersona].plan} plan.`
        : `Upgrade to Pro or Enterprise to unlock loyalty discounts via Togglekit.`}
    </div>
  `;

  // 5. Flow-Specific Body Content
  const body = $("checkout-body");
  if (newCheckout) {
    body.innerHTML = `
      <div class="one-click-perks">
        <div class="perk-item"><span>💳</span> <strong>Visa ···· 4242</strong> (Active)</div>
        <div class="perk-item"><span>🚀</span> <strong>Instant Provisioning</strong></div>
        <div class="perk-item"><span>🛡️</span> <strong>SOC-2 Type II Certified</strong></div>
        <div class="perk-item"><span>⚡</span> <strong>${flow === "express" ? "Zero-Approval Flow" : "Standard SLA"}</strong></div>
      </div>
    `;
    $("checkout-cta").textContent = "⚡ One-Click Order";
  } else {
    body.innerHTML = `
      <div class="flow-step-box">
        <div class="step-label">Step 1 of 3: Billing Entity</div>
        <div class="step-val">Acme Corporation (PO #99281)</div>
      </div>
      <div class="flow-step-box">
        <div class="step-label">Step 2 of 3: Payment Method</div>
        <div class="step-val">Net-30 Corporate Invoicing</div>
      </div>
    `;
    $("checkout-cta").textContent = "Proceed to Review";
  }

  // 6. "What this browser was told" Table
  const allValues = tk.allValues();
  const tableBody = document.querySelector("#values tbody");
  const keys = Object.keys(allValues).sort();

  if (keys.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="3" class="muted">No flags available to this browser.</td></tr>`;
  } else {
    tableBody.innerHTML = keys
      .map((key) => {
        const detail = allValues[key];
        const valBadge = formatValueBadge(detail.value);
        const reasonBadge = detail.reason === "RULE_MATCH"
          ? `<span class="reason-tag rule">RULE_MATCH</span>`
          : `<span class="reason-tag">${escape(detail.reason)}</span>`;

        return `
          <tr>
            <td><code>${escape(key)}</code></td>
            <td>${valBadge}</td>
            <td>${reasonBadge}</td>
          </tr>
        `;
      })
      .join("");
  }
}

function formatValueBadge(val) {
  if (typeof val === "boolean") {
    return `<span class="val-badge ${val ? "bool-true" : "bool-false"}">${val ? "true" : "false"}</span>`;
  }
  if (typeof val === "number") {
    return `<span class="val-badge num">${val}</span>`;
  }
  if (typeof val === "string") {
    return `<span class="val-badge str">"${escape(val)}"</span>`;
  }
  return `<code>${escape(JSON.stringify(val))}</code>`;
}

function log(message, kind = "") {
  const item = document.createElement("li");
  item.className = kind;
  const time = new Date().toLocaleTimeString();
  item.innerHTML = `<span style="opacity:0.6">${time}</span> <span>${escape(message)}</span>`;
  const list = $("log");
  list.prepend(item);
  while (list.children.length > 20) list.lastChild?.remove();
}

function escape(text) {
  return String(text ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c,
  );
}

// Expose SDK on window for devtools exploration
window.fk = fk;
