# Build stage
# Tracking the latest Node release line (26.x). Note this is the Current line —
# it enters LTS in October 2026 — so re-pin the tag deliberately rather than
# letting it drift. (@supabase/supabase-js requires >=22.)
FROM node:26-alpine AS build

WORKDIR /app

# Accept build arguments for Supabase configuration
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

# Install from the lockfile so image builds are reproducible.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Serve stage
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
