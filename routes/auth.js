const express = require('express')
const router = express.Router()
const pool = require('../db')

// Send OTP
router.post('/send-otp', async (req, res) => {
  const { phone } = req.body
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const expires = new Date(Date.now() + 10 * 60 * 1000)

    await pool.query(
      'INSERT INTO otps (phone, otp_code, expires_at) VALUES ($1, $2, $3)',
      [phone, otp, expires]
    )

    // Send real SMS via Termii
    const smsResponse = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: phone,
        from: 'Zowpay',
        sms: `Your Zowpay verification code is: ${otp}. Valid for 10 minutes. Do not share this code.`,
        type: 'plain',
        api_key: process.env.TERMII_API_KEY,
        channel: 'generic'
      })
    })

    const smsData = await smsResponse.json()
    console.log('Termii response:', smsData)

    res.json({ success: true, message: 'OTP sent' })

  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})



    //

// Verify OTP
router.post('/verify-otp', async (req, res) => {
  const { phone, otp_code } = req.body
  try {
    const result = await pool.query(
      'SELECT * FROM otps WHERE phone=$1 AND otp_code=$2 AND used=false AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [phone, otp_code]
    )

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired OTP' })
    }

    // Mark OTP as used
    await pool.query('UPDATE otps SET used=true WHERE id=$1', [result.rows[0].id])

    // Create user if new
    let user = await pool.query('SELECT * FROM users WHERE phone=$1', [phone])
    if (user.rows.length === 0) {
      user = await pool.query(
        'INSERT INTO users (phone, is_verified) VALUES ($1, true) RETURNING *',
        [phone]
      )
      // Create wallet for new user
      await pool.query(
        'INSERT INTO wallets (user_id, balance, zowpoints) VALUES ($1, 0, 0)',
        [user.rows[0].id]
      )
    }

    res.json({ success: true, user: user.rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
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