# Togglekit Basic Example: 4 Core Flag Types

A full-stack, real-time feature flag demonstration featuring all 4 flag types:

1. **Toggle (Boolean)**: `feature-toggle`
2. **Text (String)**: `headline-text`
3. **Number (Number)**: `discount-number`
4. **JSON (Object)**: `theme-config`

## Directory Structure

- **`server/`**: Starts the Togglekit Control Plane on `http://127.0.0.1:3000` and hosts the website on `http://127.0.0.1:4000`. Exposes `POST /api/swap` to rotate flag values on demand.
- **`website/`**: Beautiful browser app that subscribes to SSE stream and renders the 4 flag types live without reloading.
- **`expo-app/`**: Expo React Native mobile app that connects to the same server and updates live when flags change.

## How to Run

### Step 1: Start the Server & Web App
```bash
npm run demo
```
- Open the web app at: **`http://127.0.0.1:4000`**
- Open the Admin Dashboard at: **`http://127.0.0.1:3000/admin`**

### Step 2: Swap Flags
- Click the **"⚡ Swap Flags on Server"** button in the website or mobile app, OR run:
```bash
npm run demo:swap
```
Both the website and mobile app will update their UI instantly over SSE!
