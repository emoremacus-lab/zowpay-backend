const pool = require('./db')

async function fix() {
  try {
    // Update user ID 2 to merchant type
    await pool.query(
      `UPDATE users SET user_type='merchant' WHERE id=$1`,
      [2]
    )
    console.log('✅ User ID 2 updated to merchant!')

    // Verify
    const result = await pool.query(
      'SELECT id, phone, user_type FROM users ORDER BY id'
    )
    console.log('Updated users:')
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