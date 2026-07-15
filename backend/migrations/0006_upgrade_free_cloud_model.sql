UPDATE token_accounts
SET default_model = '@cf/qwen/qwen3-30b-a3b-fp8',
    updated_at = unixepoch()
WHERE default_provider = 'workers-ai'
  AND (default_model IS NULL OR default_model = '@cf/zai-org/glm-4.7-flash');
