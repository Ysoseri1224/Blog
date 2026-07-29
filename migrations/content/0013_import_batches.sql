ALTER TABLE media_assets ADD COLUMN import_batch_id TEXT;
CREATE INDEX media_assets_import_batch_idx ON media_assets(import_batch_id, created_at);
