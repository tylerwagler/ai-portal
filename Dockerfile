# Build stage
# Node 24 is the active LTS line. Node 26 is Current and does not enter LTS
# until October 2026, so it is deliberately not used for a production image.
# (@supabase/supabase-js requires >=22; 24 clears that comfortably.)
FROM node:24-alpine AS build

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
