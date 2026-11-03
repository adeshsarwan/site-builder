-- Jobs sites and H5 games portals share the launch tables (sites / steps / events); kind tells them apart.
ALTER TABLE sites ADD COLUMN kind TEXT NOT NULL DEFAULT 'jobs';
CREATE INDEX IF NOT EXISTS sites_kind ON sites(kind, created_at);
