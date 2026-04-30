CREATE DATABASE IF NOT EXISTS `gpt_image_studio`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `gpt_image_studio`;

CREATE TABLE IF NOT EXISTS app_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  openai_api_key TEXT NULL,
  api_base_url VARCHAR(255) NOT NULL DEFAULT '',
  model VARCHAR(80) NOT NULL,
  default_credits INT UNSIGNED NOT NULL DEFAULT 10,
  generation_credit_cost INT UNSIGNED NOT NULL DEFAULT 1,
  allow_registration TINYINT(1) NOT NULL DEFAULT 1,
  require_approval TINYINT(1) NOT NULL DEFAULT 0,
  max_images_per_request TINYINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_salt VARCHAR(64) NOT NULL,
  password_iterations INT UNSIGNED NOT NULL,
  password_hash VARCHAR(128) NOT NULL,
  role VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  credits INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_users_status (status),
  INDEX idx_users_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_sessions_user_id (user_id),
  INDEX idx_sessions_expires_at (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS generations (
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL,
  prompt TEXT NOT NULL,
  model VARCHAR(80) NOT NULL,
  size VARCHAR(20) NOT NULL,
  quality VARCHAR(20) NOT NULL,
  background VARCHAR(20) NOT NULL,
  output_format VARCHAR(20) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 0,
  revised_prompt TEXT NULL,
  usage_json LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_generations_user_created (user_id, created_at),
  INDEX idx_generations_created_at (created_at),
  CONSTRAINT fk_generations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_daily_usage (
  user_id VARCHAR(32) NOT NULL,
  usage_date DATE NOT NULL,
  free_used INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, usage_date),
  CONSTRAINT fk_daily_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_checkins (
  user_id VARCHAR(32) NOT NULL,
  checkin_date DATE NOT NULL,
  credits_awarded INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, checkin_date),
  CONSTRAINT fk_user_checkins_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS generation_requests (
  id VARCHAR(32) NOT NULL PRIMARY KEY,
  user_id VARCHAR(32) NOT NULL,
  prompt TEXT NOT NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL,
  error_message TEXT NULL,
  first_generation_id VARCHAR(32) NULL,
  generation_ids TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_generation_requests_created (created_at),
  INDEX idx_generation_requests_user_created (user_id, created_at),
  INDEX idx_generation_requests_status (status),
  CONSTRAINT fk_generation_requests_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO app_settings
  (id, openai_api_key, api_base_url, model, default_credits, generation_credit_cost, allow_registration, require_approval, max_images_per_request)
VALUES
  (1, '', '', 'GPT-IMAGE-2', 10, 1, 1, 0, 1);
