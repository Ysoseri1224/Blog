CREATE UNIQUE INDEX categories_unique_location_name_idx ON categories(repository_id, COALESCE(parent_id, ''), name);

