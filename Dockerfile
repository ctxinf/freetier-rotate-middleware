FROM rust:1.88-bookworm AS build

WORKDIR /app

# Dependencies first: they change far less often than the source, so this layer
# survives most rebuilds. rusqlite bundles SQLite, which is the slow part.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && echo '' > src/lib.rs \
 && cargo build --release --quiet \
 && rm -rf src

COPY src ./src
# Touch so cargo does not reuse the dummy binary from the layer above.
RUN touch src/main.rs src/lib.rs && cargo build --release --quiet

FROM debian:bookworm-slim AS runtime

# tzdata is what makes `timezone` / time_window limits resolve real zone names;
# ca-certificates lets the gateway reach an HTTPS upstream.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -u 10001 -m gateway

WORKDIR /app

ENV CONFIG_PATH=/app/config.toml \
    DATABASE_PATH=/app/data/gateway.sqlite \
    STATIC_DIR=/app/static

COPY --from=build /app/target/release/freetier-rotate-middleware /usr/local/bin/freetier-rotate-middleware
COPY static ./static
COPY config.example.toml ./config.example.toml

RUN mkdir -p /app/data && chown -R gateway:gateway /app

USER gateway
EXPOSE 3001
CMD ["freetier-rotate-middleware"]
