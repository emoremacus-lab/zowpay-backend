const express = require('express')
const router = express.Router()
const pool = require('../db')

// Generate unique referral code
const generateCode = (phone) => {
  const clean = phone.replace(/\D/g, '').slice(-4)
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `ZOW${clean}${random}`
}

// Get or create referral code for user
router.get('/code/:user_id', async (req, res) => {
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
  const { user_id, referral_code } = req.body
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
      message: 'Referral code applied! Both you and your referrer will earn 500 ZowPoints when you fund your wallet.'
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Complete referral when new user funds wallet
router.post('/complete', async (req, res) => {
  const { user_id } = req.body
  try {
    // Find pending referral for this user
    const referral = await pool.query(
      `SELECT * FROM referrals 
       WHERE referred_id=$1 AND status='pending'`,
      [user_id]
    )

    if (referral.rows.length === 0) {
      return res.json({ success: true, message: 'No pending referral' })
    }

    const ref = referral.rows[0]
    const pointsEach = 500

    // Award points to referrer
    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [pointsEach, ref.referrer_id]
    )

    // Award points to new user
    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [pointsEach, user_id]
    )

    // Record transactions for both
    await pool.query(
      `INSERT INTO transactions 
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ref.referrer_id, 'reward', 0,
        'Referral bonus — friend joined Zowpay!',
        'REF-BONUS-' + Date.now(), 'success', pointsEach
      ]
    )

    await pool.query(
      `INSERT INTO transactions 
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user_id, 'reward', 0,
        'Welcome bonus — referral code applied!',
        'REF-WELCOME-' + Date.now(), 'success', pointsEach
      ]
    )

    // Mark referral as completed
    await pool.query(
      `UPDATE referrals 
       SET status='completed', points_awarded=$1 
       WHERE id=$2`,
      [pointsEach, ref.id]
    )

    res.json({
      success: true,
      message: 'Referral completed! 500 ZowPoints awarded to both users!'
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

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
    res.json({ success: true, leaderboard: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router