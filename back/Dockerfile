FROM golang:1.23-alpine AS builder

WORKDIR /app

RUN apk add --no-cache curl

COPY go.mod ./
RUN go mod download

COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o main .

FROM alpine:3.21

WORKDIR /app

RUN apk add --no-cache curl ca-certificates

COPY --from=builder /app/main .

RUN adduser -D -r appuser && chown -R appuser /app
USER appuser

EXPOSE 5002

CMD ["./main"]
