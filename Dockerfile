# Monorepo build: web/ (Vite/React) is compiled to static assets, then
# copied into the calls-app/ Express server's expected ../web/dist
# path (see calls-app/app.js's express.static mount), so the runtime
# image only needs the API's own production dependencies.

FROM node:22-alpine AS web-build
WORKDIR /repo/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /repo/calls-app
COPY calls-app/package*.json ./
RUN npm ci --omit=dev
COPY calls-app/ ./
COPY --from=web-build /repo/web/dist /repo/web/dist

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "app.js"]
