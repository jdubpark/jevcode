-- add profile fields and stop storing passwords
ALTER TABLE users ADD COLUMN full_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;
ALTER TABLE users DROP COLUMN password_hash;
