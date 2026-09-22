/**
 * Featurekit Live Website Client
 * Connects to Featurekit Server via SSE for real-time 4 flag updates.
 */

// DOM Elements
const connStatus = document.getElementById("conn-status");
const connText = document.getElementById("conn-text");
const btnSwap = document.getElementById("btn-swap");

const heroHeadline = document.getElementById("hero-headline");
const promoBanner = document.getElementById("promo-banner");

// Card 1: Toggle
const switchMock = document.getElementById("switch-mock");
const toggleStateText = document.getElementById("toggle-state-text");
const toggleValue = document.getElementById("toggle-value");

// Card 2: Text
const textValue = document.getElementById("text-value");

// Card 3: Number
const numberValue = document.getElementById("number-value");

// Card 4: JSON
const dynamicThemeBox = document.getElementById("dynamic-theme-box");
const themeBadge = document.getElementById("theme-badge");
const themeMeta = document.getElementById("theme-meta");
const jsonValue = document.getElementById("json-value");

// Event log
const eventsLog = document.getElementById("events-log");
const eventsCount = document.getElementById("events-count");

let eventCount = 0;
let currentValues = {};

// 1. Fetch config from server host
async function init() {
  try {
    const configRes = await fetch("/api/config");
    const { clientKey, baseUrl } = await configRes.json();
    console.log("[Featurekit] Client configured with key:", clientKey, "baseUrl:", baseUrl);

    // Initial evaluation for the visitor context
    const context = { kind: "user", key: "demo-visitor-" + Math.random().toString(36).slice(2, 8) };
    
    // Fetch initial state
    const stateRes = await fetch(`${baseUrl}/v1/client/state`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${clientKey}`,
      },
      body: JSON.stringify({ context }),
    });

    if (stateRes.ok) {
      const stateData = await stateRes.json();
      currentValues = stateData.values ?? {};
      updateUI(currentValues);

      // Connect real-time SSE stream using the connectionId from state
      if (stateData.connectionId) {
        connectSse(baseUrl, clientKey, stateData.connectionId, context);
      }
    }

  } catch (err) {
    console.error("[Featurekit] Failed to initialize:", err);
    connStatus.setAttribute("data-state", "offline");
    connText.textContent = "Offline";
  }
}

// 2. Real-Time SSE Stream Listener
function connectSse(baseUrl, clientKey, connectionId, context) {
  const streamUrl = `${baseUrl}/v1/client/stream?connection=${encodeURIComponent(connectionId)}&key=${encodeURIComponent(clientKey)}`;

  const sse = new EventSource(streamUrl);

  sse.onopen = () => {
    connStatus.setAttribute("data-state", "ready");
    connText.textContent = "● LIVE SSE";
    console.log("[Featurekit SSE] Connected to stream!");
  };

  // Featurekit streams updates on the "values" event
  sse.addEventListener("values", (e) => {
    try {
      const payload = JSON.parse(e.data);
      console.log("[Featurekit SSE] Push event received:", payload);

      if (payload.values) {
        Object.assign(currentValues, payload.values);
      }

      updateUI(currentValues);
      logEvent(payload.values ?? payload);
    } catch (err) {
      console.error("[Featurekit SSE] Error parsing values:", err);
    }
  });

  // Fallback for generic patch/message events
  sse.addEventListener("patch", (e) => {
    try {
      const patch = JSON.parse(e.data);
      if (patch.updated) Object.assign(currentValues, patch.updated);
      if (patch.deleted) {
        for (const k of patch.deleted) delete currentValues[k];
      }
      updateUI(currentValues);
      logEvent(patch.updated ?? patch);
    } catch (err) {
      console.error("[Featurekit SSE] Error parsing patch:", err);
    }
  });

  sse.onerror = () => {
    connStatus.setAttribute("data-state", "connecting");
    connText.textContent = "Reconnecting…";
  };
}

// 3. Update DOM with live flag values
function updateUI(values) {
  // 1. Toggle (Boolean Flag: "feature-toggle")
  const isToggleOn = Boolean(values["feature-toggle"]);
  if (isToggleOn) {
    switchMock.classList.add("is-on");
    toggleStateText.textContent = "ON";
    toggleStateText.style.color = "#10b981";
    toggleValue.textContent = "true";
    promoBanner.classList.remove("is-hidden");
  } else {
    switchMock.classList.remove("is-on");
    toggleStateText.textContent = "OFF";
    toggleStateText.style.color = "#94a3b8";
    toggleValue.textContent = "false";
    promoBanner.classList.add("is-hidden");
  }

  // 2. Text (String Flag: "headline-text")
  const stringVal = values["headline-text"] ?? "Featurekit Live Demo";
  heroHeadline.textContent = stringVal;
  textValue.textContent = stringVal;

  // 3. Number (Number Flag: "discount-number")
  const numVal = values["discount-number"] ?? 0;
  numberValue.textContent = String(numVal);

  // 4. JSON (Object Flag: "theme-config")
  const jsonVal = values["theme-config"] ?? { theme: "indigo", accentColor: "#6366f1", badge: "DEFAULT" };
  jsonValue.textContent = JSON.stringify(jsonVal, null, 2);

  if (typeof jsonVal === "object" && jsonVal !== null) {
    const accent = jsonVal.accentColor ?? "#6366f1";
    const radius = jsonVal.cardRadius ? `${jsonVal.cardRadius}px` : "16px";
    const badge = jsonVal.badge ?? "ACTIVE";

    dynamicThemeBox.style.borderColor = accent;
    dynamicThemeBox.style.borderRadius = radius;
    themeBadge.style.backgroundColor = accent;
    themeBadge.textContent = badge;
    themeMeta.textContent = `Accent: ${accent} • Radius: ${radius}`;
  }
}

// 4. Log incoming SSE events
function logEvent(updates) {
  eventCount++;
  eventsCount.textContent = `${eventCount} event${eventCount === 1 ? '' : 's'} received`;

  if (eventsLog.querySelector(".empty-log")) {
    eventsLog.innerHTML = "";
  }

  const row = document.createElement("div");
  row.className = "event-row";
  const now = new Date().toLocaleTimeString();
  const keys = Object.keys(updates).join(", ") || "flag update";

  row.innerHTML = `
    <span class="event-time">${now}</span>
    <span class="event-keys">Updated: <strong>${keys}</strong></span>
  `;
  eventsLog.prepend(row);
}

// 5. Swap Button Trigger
btnSwap.addEventListener("click", async () => {
  btnSwap.disabled = true;
  btnSwap.style.opacity = "0.7";
  try {
    const res = await fetch("http://127.0.0.1:3000/api/swap", { method: "POST" });
    if (!res.ok) throw new Error("Swap request failed");
  } catch (err) {
    console.error("Failed to trigger swap:", err);
  } finally {
    setTimeout(() => {
      btnSwap.disabled = false;
      btnSwap.style.opacity = "1";
    }, 400);
  }
});

init();
