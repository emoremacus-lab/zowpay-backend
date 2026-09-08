const pool = require('./db')

async function check() {
  try {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_name = 'users' ORDER BY column_name`
    )
    console.log('Users table columns:')
    result.rows.forEach(r => console.log(' -', r.column_name))
    
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'public'`
    )
    console.log('\nAll tables:')
    tables.rows.forEach(r => console.log(' -', r.table_name))
    
    process.exit()
  } catch (err) {
    console.error('Error:', err.message)
    process.exit()
  }
}

check()