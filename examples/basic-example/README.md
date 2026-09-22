# Featurekit Basic Example: 4 Core Flag Types

A full-stack, real-time feature flag demonstration using **`featurekit-server`** and **`featurekit-client`**, featuring all 4 flag types:

1. **Toggle (Boolean)**: `feature-toggle`
2. **Text (String)**: `headline-text`
3. **Number (Number)**: `discount-number`
4. **JSON (Object)**: `theme-config`

## Directory Structure

- **`server/`**: Uses **`featurekit-server`** to start the Featurekit Control Plane on `http://127.0.0.1:3000` and host the website on `http://127.0.0.1:4000`. Exposes `POST /api/swap` to rotate flag values on demand.
- **`website/`**: Browser application that connects to the live stream and renders all 4 flag types dynamically without page reloads.
- **`expo-app/`**: React Native (Expo) mobile application using **`featurekit-client`** to evaluate and listen to real-time flag changes.

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
