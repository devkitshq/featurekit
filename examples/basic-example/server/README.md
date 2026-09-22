# Togglekit Basic Example Server

Runs the **Togglekit Control Plane** with 4 core flag types provisioned:
1. **Toggle (Boolean)**: `feature-toggle`
2. **Text (String)**: `headline-text`
3. **Number (Number)**: `discount-number`
4. **JSON (Object)**: `theme-config`

## Quick Start

```bash
# 1. Start the Server & Website
node server.js
# Or from workspace root: npm run demo

# 2. In another terminal, swap the flags anytime:
node swap.js
# Or from workspace root: npm run demo:swap
```

## Endpoints

- **Website Demo**: `http://127.0.0.1:4000`
- **Admin Dashboard**: `http://127.0.0.1:3000/admin`
- **Swap API**: `http://127.0.0.1:3000/api/swap`
