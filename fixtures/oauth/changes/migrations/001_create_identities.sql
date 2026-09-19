CREATE TABLE identities (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  verified_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX identities_provider_subject_idx
  ON identities (provider, subject);
