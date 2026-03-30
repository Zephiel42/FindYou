FROM ghcr.io/techarohq/anubis:latest

LABEL org.opencontainers.image.title="Anubis Reverse Proxy"

ENV \
  BIND=:8080 \
  METRICS_BIND=:9090 \
  DIFFICULTY=4 \
  OG_PASSTHROUGH=true \
  OG_EXPIRY_TIME=24h \
  TRUST_PROXY_HEADERS=true \
  SERVE_ROBOTS_TXT=true \
  LOG_LEVEL=info \
  POLICY_FNAME=./policy.yaml

EXPOSE 8080 9090

ENTRYPOINT ["anubis"]
CMD ["serve"]
