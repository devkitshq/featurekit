# Multi-stage: the runtime image carries no toolchain and no sources.
#
# `npm ci --omit=dev` in the final stage rather than copying node_modules from
# the builder: the builder's tree contains typescript, vitest and testcontainers,
# none of which belong in a production image's vulnerability surface (§20).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/client/package.json packages/client/
RUN npm ci
COPY tsconfig*.json ./
COPY src src
COPY packages packages
# `npm run build` ends in `vite build --config dashboard/vite.config.ts`, so the
# dashboard sources have to be here or the build fails on its last step. Its
# dependencies — vite, tailwind, the React plugin — are devDependencies already
# installed above, and none of them reach the runtime stage.
COPY dashboard dashboard
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/client/package.json packages/client/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist dist
COPY --from=build /app/packages/client/dist packages/client/dist
# `src/app.ts` resolves the dashboard at `<package>/dashboard/dist`, relative to
# its own `dist/app.js`. Only the built bundle crosses over; the sources, vite
# and tailwind stay in the build stage.
COPY --from=build /app/dashboard/dist dashboard/dist
COPY drizzle drizzle
COPY scripts scripts

# Never root.
USER node
EXPOSE 3000

# No shell wrapper: PID 1 must be node itself, or SIGTERM never reaches the
# graceful shutdown and every deploy severs its SSE connections (§16).
CMD ["node", "dist/main.js"]
