const express = require('express')
const router = express.Router()
const pool = require('../db')
const multer = require('multer')

// Multer setup — store in memory, max 5MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
})

// Get all active missions
router.get('/all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.full_name as merchant_name, u.phone as merchant_phone
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

// Get mission by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params
  try {
    const result = await pool.query(
      `SELECT m.*, u.full_name as merchant_name, u.phone as merchant_phone
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
router.get('/category/:cat', async (req, res) => {
  const { cat } = req.params
  try {
    const result = await pool.query(
      `SELECT m.*, u.full_name as merchant_name
       FROM missions m
       LEFT JOIN users u ON m.merchant_id = u.id
       WHERE m.category = $1 AND m.status = 'active'
       ORDER BY m.created_at DESC`,
      [cat]
    )
    res.json({ success: true, missions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Submit mission proof — fixed to handle FormData + file upload
router.post('/submit', upload.single('proof_file'), async (req, res) => {
  const { mission_id, user_id, proof_text } = req.body
  try {
    if (!mission_id || !user_id) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

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
      'SELECT * FROM missions WHERE id=$1', [mission_id]
    )
    if (mission.rows.length === 0) {
      return res.status(404).json({ error: 'Mission not found' })
    }

    // Handle file if uploaded — convert to base64
    let proof_url = null
    if (req.file) {
      const base64 = req.file.buffer.toString('base64')
      const mimeType = req.file.mimetype
      proof_url = `data:${mimeType};base64,${base64}`
    }

    // Save submission
    await pool.query(
      `INSERT INTO mission_completions
       (mission_id, user_id, proof_text, proof_url, status, submitted_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())`,
      [mission_id, user_id, proof_text || '', proof_url]
    )

    // Update participant count
    await pool.query(
      `UPDATE missions
       SET current_participants = current_participants + 1
       WHERE id=$1`,
      [mission_id]
    )

    res.json({
      success: true,
      message: 'Proof submitted! Waiting for merchant approval.'
    })
  } catch (err) {
    console.error('Submit proof error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Check if user already submitted for a mission
router.get('/check/:mission_id/:user_id', async (req, res) => {
  const { mission_id, user_id } = req.params
  try {
    const result = await pool.query(
      `SELECT * FROM mission_completions
       WHERE mission_id=$1 AND user_id=$2`,
      [mission_id, user_id]
    )
    res.json({
      success: true,
      submitted: result.rows.length > 0,
      submission: result.rows[0] || null
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get user's mission submissions
router.get('/user/:user_id', async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query(
      `SELECT mc.*, m.title as mission_title,
       m.reward_points, m.reward_cash
       FROM mission_completions mc
       JOIN missions m ON mc.mission_id = m.id
       WHERE mc.user_id = $1
       ORDER BY mc.submitted_at DESC`,
      [user_id]
    )
    res.json({ success: true, submissions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Approve mission completion
router.post('/approve', async (req, res) => {
  const { completion_id, user_id, mission_id } = req.body
  try {
    const mission = await pool.query(
      'SELECT * FROM missions WHERE id=$1', [mission_id]
    )
    if (mission.rows.length === 0) {
      return res.status(404).json({ error: 'Mission not found' })
    }

    const rewardPoints = mission.rows[0].reward_points || 0
    const rewardCash = mission.rows[0].reward_cash || 0

    // Update completion status
    await pool.query(
      `UPDATE mission_completions
       SET status='approved', reviewed_at=NOW()
       WHERE id=$1`,
      [completion_id]
    )

    // Award ZowPoints
    if (rewardPoints > 0) {
      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [rewardPoints, user_id]
      )
    }

    // Award cash
    if (rewardCash > 0) {
      await pool.query(
        'UPDATE wallets SET balance = balance + $1 WHERE user_id=$2',
        [rewardCash, user_id]
      )
    }

    // Record transaction
    await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user_id, 'reward', rewardCash,
        `Mission reward: ${mission.rows[0].title}`,
        'MISSION-' + Date.now(), 'success', rewardPoints
      ]
    )

    res.json({ success: true, message: 'Mission approved and reward sent!' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Reject mission completion
router.post('/reject', async (req, res) => {
  const { completion_id } = req.body
  try {
    await pool.query(
      `UPDATE mission_completions
       SET status='rejected', reviewed_at=NOW()
       WHERE id=$1`,
      [completion_id]
    )
    res.json({ success: true, message: 'Submission rejected' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Seed test missions
router.post('/seed', async (req, res) => {
  try {
    const missions = [
      {
        title: 'Follow Zowpay on Twitter',
        description: 'Follow our official Twitter account @ZowpayNG and like our pinned tweet',
        category: 'Social',
        reward_points: 100,
        reward_cash: 0,
        max_participants: 1000,
        budget: 0,
        proof_instructions: 'Take a screenshot showing you followed @ZowpayNG',
        time_estimate: '2 mins',
        merchant_id: null
      },
      {
        title: 'Share Zowpay on WhatsApp',
        description: 'Share the Zowpay app link on your WhatsApp status for 24 hours',
        category: 'Social',
        reward_points: 200,
        reward_cash: 500,
        max_participants: 500,
        budget: 250000,
        proof_instructions: 'Screenshot your WhatsApp status showing the Zowpay post',
        time_estimate: '5 mins',
        merchant_id: null
      },
      {
        title: 'Rate Zowpay on Play Store',
        description: 'Give Zowpay a 5-star rating and write a short review on Google Play Store',
        category: 'Review',
        reward_points: 300,
        reward_cash: 0,
        max_participants: 200,
        budget: 0,
        proof_instructions: 'Screenshot your Play Store review',
        time_estimate: '3 mins',
        merchant_id: null
      },
    ]

    for (const mission of missions) {
      await pool.query(
        `INSERT INTO missions
         (title, description, category, reward_points, reward_cash,
          max_participants, current_participants, budget, status,
          proof_instructions, time_estimate, merchant_id)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,'active',$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [
          mission.title, mission.description, mission.category,
          mission.reward_points, mission.reward_cash,
          mission.max_participants, mission.budget,
          mission.proof_instructions, mission.time_estimate,
          mission.merchant_id
        ]
      )
    }

    res.json({ success: true, message: 'Missions seeded!' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router