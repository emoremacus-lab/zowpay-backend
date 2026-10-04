const pool = require('./db')

async function check() {
  try {
    const all = await pool.query(
      'SELECT id, phone, user_type, full_name FROM users ORDER BY created_at DESC'
    )
    console.log('All users:')
    all.rows.forEach(u => {
      console.log(`ID: ${u.id} | Phone: ${u.phone} | Type: ${u.user_type} | Name: ${u.full_name}`)
    })
    process.exit()
  } catch (err) {
    console.error(err.message)
    process.exit()
  }
}

check()