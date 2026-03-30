FROM certbot/certbot:latest

RUN mkdir -p /var/www/certbot

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
