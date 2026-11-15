CREATE TABLE IF NOT EXISTS service_credentials (
  service TEXT PRIMARY KEY,
  envelope TEXT NOT NULL,
  version TEXT NOT NULL
);
