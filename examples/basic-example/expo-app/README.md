# Featurekit Expo Mobile Demo

React Native mobile application connecting to Featurekit Control Plane using **`featurekit-client`** with real-time push updates.

## Code Example

```typescript
import { FeaturekitClient } from "featurekit-client";

const client = new FeaturekitClient({
  baseUrl: "http://127.0.0.1:3000",
  clientKey: "fk_clt_...",
  initialContext: { kind: "user", key: "mobile-user-1" },
});

await client.identify({ kind: "user", key: "mobile-user-1" });

// Evaluate flags:
const isEnabled = client.get("feature-toggle", false);
const headline = client.get("headline-text", "Default");
const discount = client.get("discount-number", 0);
const theme = client.get("theme-config", {});

// Subscribe to real-time changes:
client.on("change", (changedKeys) => {
  console.log("Flags updated in real time:", changedKeys);
});
```

## Running the App

```bash
# 1. Install dependencies
npm install

# 2. Run in browser (Expo Web)
npm run web

# Or run on Android / iOS
npm run android
npm run ios
```
