ALTER TABLE preferences ADD COLUMN pure_black INTEGER NOT NULL DEFAULT 0 CHECK (pure_black IN (0, 1));
