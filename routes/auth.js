const express = require('express')
const router = express.Router()
const pool = require('../db')

// Send OTP
router.post('/send-otp', async (req, res) => {
  const { phone } = req.body
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    console.log(`OTP for ${phone}: ${otp}`)
    const expires = new Date(Date.now() + 10 * 60 * 1000)

    await pool.query(
      'INSERT INTO otps (phone, otp_code, expires_at) VALUES ($1, $2, $3)',
      [phone, otp, expires]
    )

    // Send SMS via Termii
    try {
      const smsResponse = await fetch(
        'https://api.ng.termii.com/api/sms/send',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: process.env.TERMII_API_KEY,
            to: phone,
            from: 'generic',
            sms: `Your Zowpay verification code is: ${otp}. Valid for 10 minutes. Do not share this code.`,
            type: 'plain',
            channel: 'generic'
          })
        }
      )
      const smsData = await smsResponse.json()
      console.log('Termii response:', JSON.stringify(smsData))
    } catch (smsErr) {
      console.log('SMS error:', smsErr.message)
    }

  res.json({
  success: true,
  message: 'OTP sent',
  dev_otp: otp // Keep until Termii is fully activated
})

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Create user if new
let user = await pool.query('SELECT * FROM users WHERE phone=$1', [phone])
if (user.rows.length === 0) {
  user = await pool.query(
    'INSERT INTO users (phone, is_verified, user_type) VALUES ($1, true, $2) RETURNING *',
    [phone, req.body.user_type || 'customer']
  )
  await pool.query(
    'INSERT INTO wallets (user_id, balance, zowpoints) VALUES ($1, 0, 0)',
    [user.rows[0].id]
  )
} else {
  // Update user_type if provided and not already set
  if (req.body.user_type && !user.rows[0].user_type) {
    await pool.query(
      'UPDATE users SET user_type=$1 WHERE id=$2',
      [req.body.user_type, user.rows[0].id]
    )
    user = await pool.query('SELECT * FROM users WHERE phone=$1', [phone])
  }
}

// Update profile
router.post('/update-profile', async (req, res) => {
  const { user_id, full_name, email } = req.body
  try {
    await pool.query(
      'UPDATE users SET full_name=$1, email=$2 WHERE id=$3',
      [full_name, email, user_id]
    )
    res.json({ success: true, message: 'Profile updated!' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router