const pool = require('./db')

async function setup() {
  try {
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE,
      ADD COLUMN IF NOT EXISTS referred_by VARCHAR(20)
    `)
    console.log('✅ User columns added!')

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id INTEGER REFERENCES users(id),
        referred_id INTEGER REFERENCES users(id),
        referral_code VARCHAR(20),
        status VARCHAR(20) DEFAULT 'pending',
        points_awarded INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `)
    console.log('✅ Referrals table created!')

    process.exit()
  } catch (err) {
    console.error('Error:', err.message)
    process.exit()
  }
}

setup()