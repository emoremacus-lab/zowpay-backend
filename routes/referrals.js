const express = require('express')
const router = express.Router()
const pool = require('../db')
const { onlySelf } = require('../middleware/userAuth')

// Generate unique referral code
const generateCode = (phone) => {
  const clean = phone.replace(/\D/g, '').slice(-4)
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `ZOW${clean}${random}`
}

// Get or create referral code for user
router.get('/code/:user_id', onlySelf('user_id'), async (req, res) => {
  const { user_id } = req.params
  try {
    // Check if user already has a referral code
    const user = await pool.query(
      'SELECT * FROM users WHERE id=$1', [user_id]
    )

    if (!user.rows[0]) {
      return res.status(404).json({ error: 'User not found' })
    }

    let referralCode = user.rows[0].referral_code

    // Generate one if they don't have it
    if (!referralCode) {
      referralCode = generateCode(user.rows[0].phone)

      // Make sure it's unique
      let isUnique = false
      let attempts = 0
      while (!isUnique && attempts < 10) {
        const existing = await pool.query(
          'SELECT id FROM users WHERE referral_code=$1',
          [referralCode]
        )
        if (existing.rows.length === 0) {
          isUnique = true
        } else {
          referralCode = generateCode(user.rows[0].phone)
          attempts++
        }
      }

      await pool.query(
        'UPDATE users SET referral_code=$1 WHERE id=$2',
        [referralCode, user_id]
      )
    }

    // Get referral stats
    const stats = await pool.query(
      `SELECT 
        COUNT(*) as total_referrals,
        COUNT(CASE WHEN status='completed' THEN 1 END) as completed,
        COALESCE(SUM(points_awarded), 0) as total_points_earned
       FROM referrals WHERE referrer_id=$1`,
      [user_id]
    )

    // Get referred users
    const referred = await pool.query(
      `SELECT r.*, u.phone, u.full_name, r.created_at
       FROM referrals r
       JOIN users u ON r.referred_id = u.id
       WHERE r.referrer_id=$1
       ORDER BY r.created_at DESC`,
      [user_id]
    )

    res.json({
      success: true,
      referral_code: referralCode,
      referral_link: `https://zowpay.ng?ref=${referralCode}`,
      stats: stats.rows[0],
      referred_users: referred.rows
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Apply referral code on signup
router.post('/apply', async (req, res) => {
  // The user comes from the login pass, never from the request body
  const { referral_code } = req.body
  const user_id = req.userId
  try {
    // Find referrer
    const referrer = await pool.query(
      'SELECT * FROM users WHERE referral_code=$1',
      [referral_code]
    )

    if (referrer.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid referral code' })
    }

    const referrerId = referrer.rows[0].id

    // Can't refer yourself
    if (referrerId === Number(user_id)) {
      return res.status(400).json({ error: 'You cannot use your own referral code' })
    }

    // Check if already referred
    const existing = await pool.query(
      'SELECT * FROM referrals WHERE referred_id=$1', [user_id]
    )

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You have already used a referral code' })
    }

    // Save referred_by on user
    await pool.query(
      'UPDATE users SET referred_by=$1 WHERE id=$2',
      [referral_code, user_id]
    )

    // Create referral record
    await pool.query(
      `INSERT INTO referrals 
       (referrer_id, referred_id, referral_code, status, points_awarded)
       VALUES ($1, $2, $3, 'pending', 0)`,
      [referrerId, user_id, referral_code]
    )

    res.json({
      success: true,
      message: 'Referral code applied! Both you and your referrer will earn 500 ZowPoints when you make your first bill payment of ₦500 or more.'
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Referral bonuses are paid by the bill-payment code (completeReferral in bills.js)
// after the referred person's first qualifying bill. There is deliberately no public
// route that awards them.

// Get referral leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.full_name, u.phone, u.referral_code,
       COUNT(r.id) as total_referrals,
       SUM(r.points_awarded) as total_points
       FROM users u
       LEFT JOIN referrals r ON u.id = r.referrer_id
       WHERE r.status = 'completed'
       GROUP BY u.id, u.full_name, u.phone, u.referral_code
       ORDER BY total_referrals DESC
       LIMIT 10`
    )
    // Hide most of each phone number: this list is visible to every signed-in user
    const leaderboard = result.rows.map(row => ({
      ...row,
      phone: row.phone ? '***' + String(row.phone).slice(-4) : null
    }))
    res.json({ success: true, leaderboard })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router