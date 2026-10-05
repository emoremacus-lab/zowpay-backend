const pool = require('./db')

async function fix() {
  try {
    // Set all users without user_type to customer
    await pool.query(
      `UPDATE users SET user_type='customer' 
       WHERE user_type IS NULL OR user_type=''`
    )
    console.log('✅ All users updated!')

    const result = await pool.query(
      'SELECT id, phone, user_type FROM users ORDER BY id'
    )
    console.log('All users:')
    result.rows.forEach(u => {
      console.log(`ID: ${u.id} | Phone: ${u.phone} | Type: ${u.user_type}`)
    })
    process.exit()
  } catch (err) {
    console.error(err.message)
    process.exit()
  }
}

fix()