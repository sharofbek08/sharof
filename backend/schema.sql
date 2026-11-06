CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('poem', 'quote')),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 3000),
  author TEXT,
  tags TEXT[],
  favorite BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  owner_id TEXT NOT NULL,
  encryption JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS entries_created_at_idx ON entries (created_at DESC);
CREATE INDEX IF NOT EXISTS entries_owner_id_idx ON entries (owner_id);
