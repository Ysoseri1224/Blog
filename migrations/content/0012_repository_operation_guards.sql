ALTER TABLE repositories ADD COLUMN last_write_id TEXT;

CREATE TABLE operation_assertions (
  id TEXT PRIMARY KEY,
  expected INTEGER NOT NULL,
  actual INTEGER NOT NULL,
  CHECK (expected = actual)
);
