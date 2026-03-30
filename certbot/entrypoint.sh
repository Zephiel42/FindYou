#!/bin/sh
set -e

DOMAIN="${DOMAIN:?Set DOMAIN in .env}"
EMAIL="${CERTBOT_EMAIL:?Set CERTBOT_EMAIL in .env}"
WEBROOT="/var/www/certbot"
CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"

if [ ! -f "$CERT_PATH" ]; then
    certbot certonly \
        --webroot \
        -w "$WEBROOT" \
        -d "$DOMAIN" \
        --email "$EMAIL" \
        --agree-tos \
        --non-interactive \
        --no-eff-email
fi

while true; do
    sleep 12h
    certbot renew --webroot -w "$WEBROOT" --non-interactive --quiet
done
