ALTER TABLE token_accounts ADD COLUMN default_provider TEXT NOT NULL DEFAULT 'workers-ai';
ALTER TABLE token_accounts ADD COLUMN default_model TEXT NOT NULL DEFAULT '@cf/zai-org/glm-4.7-flash';
