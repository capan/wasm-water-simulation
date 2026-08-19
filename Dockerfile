# Three stages, because the two toolchains that build this app have nothing to
# do with the one that serves it. The result is a static directory, so neither
# Rust nor Node ends up in the image that runs.

FROM rust:1-slim AS wasm
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
WORKDIR /src
COPY Cargo.toml ./
COPY src/ src/
RUN wasm-pack build

FROM node:22-alpine AS bundle
WORKDIR /src
# pkg/ first: www/package.json depends on file:../pkg, so npm ci fails without it
COPY --from=wasm /src/pkg/ pkg/
COPY www/package.json www/package-lock.json www/
RUN cd www && npm ci
COPY www/ www/
RUN cd www && NODE_ENV=production npm run build

FROM caddy:2-alpine
COPY deploy/site.Caddyfile /etc/caddy/Caddyfile
COPY --from=bundle /src/www/dist /srv
