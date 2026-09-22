# Featurekit Examples

This directory contains clean, runnable examples demonstrating Featurekit across backend, web, and mobile.

- **[`basic-example/`](./basic-example/)** — The complete end-to-end demo covering the **4 core flag types** (Toggle/Boolean, Text/String, Number, and JSON/Object) across:
  - **`server/`** — Featurekit Control Plane server with swap API & automated provisioning.
  - **`website/`** — Real-time reactive web application with SSE live streaming.
  - **`expo-app/`** — React Native (Expo) mobile application with live flag push.

## Quick Run

```bash
# Start Server and Web App:
npm run demo

# Swap flags in real time across web & mobile:
npm run demo:swap
```
