const express = require('express')
const router = express.Router()
const pool = require('../db')

// Get rewards catalog
router.get('/catalog', async (req, res) => {
  try {
    const rewards = [
      {
        id: 1,
        title: 'Airtime ₦100',
        description: 'Get ₦100 airtime on any network',
        points_required: 200,
        reward_type: 'airtime',
        reward_value: 100,
        icon: '📞',
        category: 'Airtime'
      },
      {
        id: 2,
        title: 'Airtime ₦200',
        description: 'Get ₦200 airtime on any network',
        points_required: 380,
        reward_type: 'airtime',
        reward_value: 200,
        icon: '📞',
        category: 'Airtime'
      },
      {
        id: 3,
        title: 'Airtime ₦500',
        description: 'Get ₦500 airtime on any network',
        points_required: 900,
        reward_type: 'airtime',
        reward_value: 500,
        icon: '📞',
        category: 'Airtime'
      },
      {
        id: 4,
        title: 'Cash ₦500',
        description: 'Convert points to ₦500 wallet cash',
        points_required: 1000,
        reward_type: 'cash',
        reward_value: 500,
        icon: '💵',
        category: 'Cash'
      },
      {
        id: 5,
        title: 'Cash ₦1,000',
        description: 'Convert points to ₦1,000 wallet cash',
        points_required: 1900,
        reward_type: 'cash',
        reward_value: 1000,
        icon: '💵',
        category: 'Cash'
      },
      {
        id: 6,
        title: 'Cash ₦2,000',
        description: 'Convert points to ₦2,000 wallet cash',
        points_required: 3600,
        reward_type: 'cash',
        reward_value: 2000,
        icon: '💵',
        category: 'Cash'
      },
      {
        id: 7,
        title: 'Data 100MB',
        description: 'Get 100MB data on any network',
        points_required: 250,
        reward_type: 'data',
        reward_value: 100,
        icon: '📶',
        category: 'Data'
      },
      {
        id: 8,
        title: 'Data 500MB',
        description: 'Get 500MB data on any network',
        points_required: 600,
        reward_type: 'data',
        reward_value: 500,
        icon: '📶',
        category: 'Data'
      },
      {
        id: 9,
        title: 'Data 1GB',
        description: 'Get 1GB data on any network',
        points_required: 1100,
        reward_type: 'data',
        reward_value: 1000,
        icon: '📶',
        category: 'Data'
      },
      {
        id: 10,
        title: 'Electricity ₦1,000',
        description: 'Get ₦1,000 electricity credit',
        points_required: 1800,
        reward_type: 'electricity',
        reward_value: 1000,
        icon: '⚡',
        category: 'Bills'
      },
    ]
    res.json({ success: true, rewards })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Redeem reward
router.post('/redeem', async (req, res) => {
  const { user_id, reward_id, phone } = req.body

  const rewards = {
    1: { title: 'Airtime ₦100', points: 200, type: 'airtime', value: 100 },
    2: { title: 'Airtime ₦200', points: 380, type: 'airtime', value: 200 },
    3: { title: 'Airtime ₦500', points: 900, type: 'airtime', value: 500 },
    4: { title: 'Cash ₦500', points: 1000, type: 'cash', value: 500 },
    5: { title: 'Cash ₦1,000', points: 1900, type: 'cash', value: 1000 },
    6: { title: 'Cash ₦2,000', points: 3600, type: 'cash', value: 2000 },
    7: { title: 'Data 100MB', points: 250, type: 'data', value: 100 },
    8: { title: 'Data 500MB', points: 600, type: 'data', value: 500 },
    9: { title: 'Data 1GB', points: 1100, type: 'data', value: 1000 },
    10: { title: 'Electricity ₦1,000', points: 1800, type: 'electricity', value: 1000 },
  }

  const reward = rewards[reward_id]
  if (!reward) {
    return res.status(400).json({ error: 'Invalid reward' })
  }

  try {
    // Check user has enough points
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1', [user_id]
    )

    if (!wallet.rows[0]) {
      return res.status(404).json({ error: 'Wallet not found' })
    }

    if (wallet.rows[0].zowpoints < reward.points) {
      return res.status(400).json({
        error: `Insufficient ZowPoints. You need ${reward.points} points but have ${wallet.rows[0].zowpoints}`
      })
    }

    const reference = 'ZOW-REDEEM-' + Date.now()

    // Deduct points
    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints - $1 WHERE user_id=$2',
      [reward.points, user_id]
    )

    // Handle reward type
    if (reward.type === 'cash') {
      // Add cash to wallet
      await pool.query(
        'UPDATE wallets SET balance = balance + $1 WHERE user_id=$2',
        [reward.value, user_id]
      )

      // Record transaction
      await pool.query(
        `INSERT INTO transactions
         (user_id, type, amount, description, reference, status, zowpoints_earned)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user_id, 'reward', reward.value,
          `ZowPoints redeemed: ${reward.title}`,
          reference, 'success', -reward.points
        ]
      )
    } else {
      // For airtime, data, electricity — record as pending
      // In production this would trigger VTPass
      await pool.query(
        `INSERT INTO transactions
         (user_id, type, amount, description, reference, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          user_id, 'reward', 0,
          `ZowPoints redeemed: ${reward.title} for ${phone}`,
          reference, 'success'
        ]
      )
    }

    // Get updated wallet
    const updatedWallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1', [user_id]
    )

    res.json({
      success: true,
      message: `${reward.title} redeemed successfully!`,
      reward_type: reward.type,
      reward_value: reward.value,
      points_used: reward.points,
      remaining_points: updatedWallet.rows[0].zowpoints
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
       WHERE user_id=$1 AND type='reward'
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