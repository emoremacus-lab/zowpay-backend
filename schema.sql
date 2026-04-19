-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(15) UNIQUE NOT NULL,
  full_name VARCHAR(100),
  email VARCHAR(100),
  pin VARCHAR(6),
  is_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Wallets table
CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  balance DECIMAL(15,2) DEFAULT 0.00,
  zowpoints INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Transactions table (the ledger)
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  type VARCHAR(20) NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  description VARCHAR(255),
  reference VARCHAR(100) UNIQUE,
  status VARCHAR(20) DEFAULT 'pending',
  zowpoints_earned INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- OTP table
CREATE TABLE IF NOT EXISTS otps (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(15),
  otp_code VARCHAR(6),
  expires_at TIMESTAMP,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);