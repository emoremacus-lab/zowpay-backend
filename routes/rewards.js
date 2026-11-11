const express = require('express')
const router = express.Router()
const pool = require('../db')

// ZowPoints are loyalty points with no cash value. They can be redeemed for
// airtime, data and bill credit only — never exchanged for money.
const REWARDS = {
  1: { title: 'Airtime ₦100', points: 200, type: 'airtime', value: 100, description: 'Get ₦100 airtime on any network', icon: '📞', category: 'Airtime' },
  2: { title: 'Airtime ₦200', points: 380, type: 'airtime', value: 200, description: 'Get ₦200 airtime on any network', icon: '📞', category: 'Airtime' },
  3: { title: 'Airtime ₦500', points: 900, type: 'airtime', value: 500, description: 'Get ₦500 airtime on any network', icon: '📞', category: 'Airtime' },
  7: { title: 'Data 100MB', points: 250, type: 'data', value: 100, description: 'Get 100MB data on any network', icon: '📶', category: 'Data' },
  8: { title: 'Data 500MB', points: 600, type: 'data', value: 500, description: 'Get 500MB data on any network', icon: '📶', category: 'Data' },
  9: { title: 'Data 1GB', points: 1100, type: 'data', value: 1000, description: 'Get 1GB data on any network', icon: '📶', category: 'Data' },
  10: { title: 'Electricity ₦1,000', points: 1800, type: 'electricity', value: 1000, description: 'Get ₦1,000 electricity credit', icon: '⚡', category: 'Bills' },
}

// Get rewards catalog
router.get('/catalog', (req, res) => {
  const rewards = Object.entries(REWARDS).map(([id, r]) => ({
    id: Number(id),
    title: r.title,
    description: r.description,
    points_required: r.points,
    reward_type: r.type,
    reward_value: r.value,
    icon: r.icon,
    category: r.category
  }))
  res.json({ success: true, rewards })
})

// Redeem reward. Points are deducted once; delivery is queued for Zowpay to fulfil.
router.post('/redeem', async (req, res) => {
  const { user_id, reward_id, phone } = req.body

  const reward = REWARDS[reward_id]
  if (!reward) {
    return res.status(400).json({ error: 'Invalid reward' })
  }
  if (!phone || String(phone).length < 10) {
    return res.status(400).json({ error: 'Enter the phone number to receive this reward' })
  }

  try {
    // Deduct points only if the user has enough — one atomic step
    const deducted = await pool.query(
      `UPDATE wallets SET zowpoints = zowpoints - $1
       WHERE user_id=$2 AND zowpoints >= $1
       RETURNING zowpoints`,
      [reward.points, user_id]
    )
    if (deducted.rows.length === 0) {
      return res.status(400).json({
        error: `Insufficient ZowPoints. You need ${reward.points} points.`
      })
    }

    const reference = 'ZOW-REDEEM-' + Date.now()
    await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [user_id, 'reward', 0,
       `ZowPoints redeemed: ${reward.title} for ${phone}`,
       reference, 'pending', -reward.points]
    )

    res.json({
      success: true,
      message: `${reward.title} requested! It will be delivered to ${phone} shortly.`,
      reward_type: reward.type,
      reward_value: reward.value,
      points_used: reward.points,
      remaining_points: deducted.rows[0].zowpoints
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get redemption history
router.get('/history/:user_id', async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id=$1 AND type='reward' AND reference LIKE 'ZOW-REDEEM-%'
       ORDER BY created_at DESC
       LIMIT 20`,
      [user_id]
    )
    res.json({ success: true, history: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router