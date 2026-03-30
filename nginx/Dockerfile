FROM nginx:alpine

RUN apk add --no-cache openssl
RUN mkdir -p /etc/certificats
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
