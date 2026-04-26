const express = require('express')
const router = express.Router()
const pool = require('../db')

// Get all active missions
router.get('/all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.full_name as merchant_name 
       FROM missions m 
       LEFT JOIN users u ON m.merchant_id = u.id 
       WHERE m.status = 'active' 
       ORDER BY m.created_at DESC`
    )
    res.json({ success: true, missions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get single mission
router.get('/:id', async (req, res) => {
  const { id } = req.params
  try {
    const result = await pool.query(
      `SELECT m.*, u.full_name as merchant_name 
       FROM missions m 
       LEFT JOIN users u ON m.merchant_id = u.id 
       WHERE m.id = $1`,
      [id]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Mission not found' })
    }
    res.json({ success: true, mission: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get missions by category
router.get('/category/:category', async (req, res) => {
  const { category } = req.params
  try {
    const result = await pool.query(
      `SELECT m.*, u.full_name as merchant_name 
       FROM missions m 
       LEFT JOIN users u ON m.merchant_id = u.id 
       WHERE m.status = 'active' AND m.category = $1
       ORDER BY m.created_at DESC`,
      [category]
    )
    res.json({ success: true, missions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Submit mission proof
router.post('/submit', async (req, res) => {
  const { mission_id, user_id, proof_text, proof_url } = req.body
  try {
    // Check if already submitted
    const existing = await pool.query(
      'SELECT * FROM mission_completions WHERE mission_id=$1 AND user_id=$2',
      [mission_id, user_id]
    )
    if (existing.rows.length > 0) {
      return res.status(400).json({
        error: 'You have already submitted proof for this mission'
      })
    }

    // Get mission details
    const mission = await pool.query(
      'SELECT * FROM missions WHERE id=$1',
      [mission_id]
    )
    if (mission.rows.length === 0) {
      return res.status(404).json({ error: 'Mission not found' })
    }

    // Create completion record
    await pool.query(
      `INSERT INTO mission_completions 
       (mission_id, user_id, proof_text, proof_url, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [mission_id, user_id, proof_text, proof_url]
    )

    // Update participant count
    await pool.query(
      'UPDATE missions SET current_participants = current_participants + 1 WHERE id=$1',
      [mission_id]
    )

    res.json({
      success: true,
      message: 'Proof submitted! Awaiting review.'
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Check if user completed a mission
router.get('/check/:mission_id/:user_id', async (req, res) => {
  const { mission_id, user_id } = req.params
  try {
    const result = await pool.query(
      'SELECT * FROM mission_completions WHERE mission_id=$1 AND user_id=$2',
      [mission_id, user_id]
    )
    res.json({
      success: true,
      completed: result.rows.length > 0,
      status: result.rows[0]?.status || null
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get user's mission history
router.get('/user/:user_id', async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query(
      `SELECT mc.*, m.title, m.reward_points, m.category
       FROM mission_completions mc
       JOIN missions m ON mc.mission_id = m.id
       WHERE mc.user_id = $1
       ORDER BY mc.submitted_at DESC`,
      [user_id]
    )
    res.json({ success: true, missions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Admin approve mission
router.post('/approve', async (req, res) => {
  const { completion_id, user_id, mission_id } = req.body
  try {
    // Get mission reward
    const mission = await pool.query(
      'SELECT * FROM missions WHERE id=$1',
      [mission_id]
    )
    const points = mission.rows[0].reward_points
    const cash = mission.rows[0].reward_cash

    // Update completion status
    await pool.query(
      `UPDATE mission_completions 
       SET status='approved', reviewed_at=NOW() 
       WHERE id=$1`,
      [completion_id]
    )

    // Award ZowPoints
    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [points, user_id]
    )

    // Award cash if any
    if (cash > 0) {
      await pool.query(
        'UPDATE wallets SET balance = balance + $1 WHERE user_id=$2',
        [cash, user_id]
      )
    }

    // Record transaction
    await pool.query(
      `INSERT INTO transactions 
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user_id, 'reward', cash || 0,
        `Mission reward: ${mission.rows[0].title}`,
        'MISSION-' + completion_id, 'success', points
      ]
    )

    res.json({ success: true, message: 'Mission approved and reward sent!' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Seed sample missions for testing
router.post('/seed', async (req, res) => {
  try {
    const sampleMissions = [
      {
        title: 'Share Zowpay on Instagram',
        description: 'Share a post about Zowpay on your Instagram story or feed and tag us. Screenshot your post as proof.',
        type: 'social',
        reward_points: 500,
        reward_cash: 0,
        budget: 50000,
        max_participants: 100,
        proof_type: 'screenshot',
        time_estimate: '5 min',
        category: 'Social'
      },
      {
        title: 'Write a Google Review',
        description: 'Write a 5-star review for one of our merchant partners on Google Maps. Take a screenshot as proof.',
        type: 'review',
        reward_points: 300,
        reward_cash: 200,
        budget: 30000,
        max_participants: 50,
        proof_type: 'screenshot',
        time_estimate: '3 min',
        category: 'Review'
      },
      {
        title: 'Complete a Short Survey',
        description: 'Fill out our customer satisfaction survey. Takes less than 5 minutes and helps us improve.',
        type: 'survey',
        reward_points: 200,
        reward_cash: 100,
        budget: 20000,
        max_participants: 200,
        proof_type: 'text',
        time_estimate: '5 min',
        category: 'Survey'
      },
      {
        title: 'Refer a Friend to Zowpay',
        description: 'Invite a friend to sign up on Zowpay. Both you and your friend earn rewards when they complete their first transaction.',
        type: 'referral',
        reward_points: 1000,
        reward_cash: 500,
        budget: 100000,
        max_participants: 500,
        proof_type: 'text',
        time_estimate: '10 min',
        category: 'Referral'
      },
      {
        title: 'Visit Shoprite and Shop',
        description: 'Visit any Shoprite location and make a purchase of at least ₦2,000 using Zowpay. Upload your receipt as proof.',
        type: 'store_visit',
        reward_points: 2000,
        reward_cash: 1000,
        budget: 200000,
        max_participants: 50,
        proof_type: 'photo',
        time_estimate: '30 min',
        category: 'Store Visit'
      },
      {
        title: 'Follow Zowpay on Twitter',
        description: 'Follow our official Twitter account and retweet our latest post. Screenshot as proof.',
        type: 'social',
        reward_points: 150,
        reward_cash: 0,
        budget: 15000,
        max_participants: 300,
        proof_type: 'screenshot',
        time_estimate: '2 min',
        category: 'Social'
      },
    ]

    for (const mission of sampleMissions) {
      await pool.query(
        `INSERT INTO missions 
         (title, description, type, reward_points, reward_cash, 
          budget, max_participants, proof_type, time_estimate, category, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
         ON CONFLICT DO NOTHING`,
        [
          mission.title, mission.description, mission.type,
          mission.reward_points, mission.reward_cash, mission.budget,
          mission.max_participants, mission.proof_type,
          mission.time_estimate, mission.category
        ]
      )
    }

    res.json({ success: true, message: '6 sample missions created!' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router