# Builds the portal web app and serves it with the edge routing. Context: repository root.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
# Public values only (publishable key, OAuth client ids, URLs).
ARG VITE_SUPABASE_KEY
ARG VITE_FIRST_PARTY_CLIENTS=""
ARG VITE_API_URL=https://api.elytrondefense.com
ARG VITE_CHAT_URL=https://ai.elytrondefense.com
RUN test -n "$VITE_SUPABASE_KEY" && npm run build

FROM nginx:1.29-alpine
COPY deploy/edge/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web /web/dist /usr/share/nginx/account
