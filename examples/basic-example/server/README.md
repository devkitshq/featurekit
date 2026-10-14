# Featurekit Basic Example Server

Demonstrates the **`featurekit-server`** package running an embedded Control Plane with 4 provisioned core flag types:

1. **Toggle (Boolean)**: `feature-toggle`
2. **Text (String)**: `headline-text`
3. **Number (Number)**: `discount-number`
4. **JSON (Object)**: `theme-config`

## Code Example

```javascript
import { FeaturekitServer } from "featurekit-server";
import flags from "./flags.js";

const server = new FeaturekitServer({
  services: ["all"],
  port: 3000,
  host: "127.0.0.1",
  flags,
  app: { dir: new URL("../website", import.meta.url), port: 4000 },
});

await server.start();
```

## Quick Start

Needs Docker running: with no `DATABASE_URL` set, the server starts Postgres
in a container, using the `@testcontainers/postgresql` dev dependency. Set
`DATABASE_URL` to use your own instead.

```bash
npm install

# 1. Start the Server & Website
node server.js

# 2. In another terminal, swap the flags anytime:
node swap.js
```

## Endpoints

- **Website Demo**: `http://127.0.0.1:4000`
- **Admin Dashboard**: `http://127.0.0.1:3000/admin`
- **Swap API**: `http://127.0.0.1:3000/api/swap`
