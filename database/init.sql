CREATE TABLE IF NOT EXISTS users (
    id    SERIAL PRIMARY KEY,
    name  VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS markers (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    ip         VARCHAR(45),
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL,
    country    VARCHAR(255),
    city       VARCHAR(255),
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tracking_links (
    id            SERIAL PRIMARY KEY,
    token         VARCHAR(32) UNIQUE NOT NULL,
    name          VARCHAR(255) NOT NULL,
    expires_hours INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMP DEFAULT NOW()
);
