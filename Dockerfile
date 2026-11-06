# Production image for Cloud Run: builds the React app and the server, then runs the server,
# which serves dist/ and the API on $PORT.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY docs ./docs
# The server writes small state files (Jira receipts, Connect-form settings) next to itself.
RUN chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "dist-server/server/index.js"]
