# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY packages/server/package*.json ./packages/server/
COPY packages/client/package*.json ./packages/client/

RUN apk add --no-cache python3 make g++
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine AS runtime
WORKDIR /app

# Server runtime dependencies only
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/package*.json ./packages/server/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Client dist must land at /app/client/dist (3x .. from packages/server/dist = /app)
COPY --from=builder /app/packages/client/dist ./client/dist

EXPOSE 3000

CMD ["node", "packages/server/dist/index.js"]
