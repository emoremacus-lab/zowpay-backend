const express = require('express')
const router = express.Router()
const pool = require('../db')

// Register as merchant
router.post('/register', async (req, res) => {
  const { user_id, business_name, business_category } = req.body
  try {
    await pool.query(
      `UPDATE users SET 
       user_type='merchant', 
       business_name=$1, 
       business_category=$2 
       WHERE id=$3`,
      [business_name, business_category, user_id]
    )

    res.json({
      success: true,
      message: 'Merchant account activated!'
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get merchant profile
router.get('/profile/:user_id', async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE id=$1',
      [user_id]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }
    res.json({ success: true, merchant: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Create mission
router.post('/missions/create', async (req, res) => {
  const {
    merchant_id, title, description, type,
    reward_points, reward_cash, budget,
    max_participants, proof_type,
    time_estimate, category
  } = req.body

  try {
    // Check merchant wallet has enough balance
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1',
      [merchant_id]
    )

    const totalCost = Number(budget)
    const serviceFee = totalCost * 0.05
    const totalRequired = totalCost + serviceFee

    if (wallet.rows[0].balance < totalRequired) {
      return res.status(400).json({
        error: `Insufficient balance. You need ₦${totalRequired.toLocaleString()} (budget + 5% service fee)`
      })
    }

    // Deduct budget + service fee from merchant wallet
    await pool.query(
      'UPDATE wallets SET balance = balance - $1 WHERE user_id=$2',
      [totalRequired, merchant_id]
    )

    // Record service fee transaction
    await pool.query(
      `INSERT INTO transactions 
       (user_id, type, amount, description, reference, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        merchant_id, 'mission', totalRequired,
        `Mission created: ${title} (includes 5% service fee)`,
        'MISSION-FEE-' + Date.now(), 'success'
      ]
    )

    // Create the mission
    const result = await pool.query(
      `INSERT INTO missions 
       (merchant_id, title, description, type, reward_points, 
        reward_cash, budget, max_participants, proof_type, 
        time_estimate, category, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
       RETURNING *`,
      [
        merchant_id, title, description, type,
        reward_points, reward_cash || 0, budget,
        max_participants, proof_type,
        time_estimate, category
      ]
    )

    res.json({
      success: true,
      message: 'Mission created successfully!',
      mission: result.rows[0],
      service_fee: serviceFee
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get merchant missions
router.get('/missions/:merchant_id', async (req, res) => {
  const { merchant_id } = req.params
  try {
    const result = await pool.query(
      `SELECT m.*, 
       COUNT(mc.id) as total_submissions,
       COUNT(CASE WHEN mc.status='pending' THEN 1 END) as pending_count,
       COUNT(CASE WHEN mc.status='approved' THEN 1 END) as approved_count
       FROM missions m
       LEFT JOIN mission_completions mc ON m.id = mc.mission_id
       WHERE m.merchant_id=$1
       GROUP BY m.id
       ORDER BY m.created_at DESC`,
      [merchant_id]
    )
    res.json({ success: true, missions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get mission submissions for merchant
router.get('/submissions/:mission_id', async (req, res) => {
  const { mission_id } = req.params
  try {
    const result = await pool.query(
      `SELECT mc.*, u.phone, u.full_name
       FROM mission_completions mc
       JOIN users u ON mc.user_id = u.id
       WHERE mc.mission_id=$1
       ORDER BY mc.submitted_at DESC`,
      [mission_id]
    )
    res.json({ success: true, submissions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Approve submission
router.post('/submissions/approve', async (req, res) => {
  const { completion_id, user_id, mission_id } = req.body
  try {
    const mission = await pool.query(
      'SELECT * FROM missions WHERE id=$1', [mission_id]
    )

    if (mission.rows.length === 0) {
      return res.status(404).json({ error: 'Mission not found' })
    }

    const points = mission.rows[0].reward_points
    const cash = Number(mission.rows[0].reward_cash) || 0

    // Update completion
    await pool.query(
      `UPDATE mission_completions 
       SET status='approved', reviewed_at=NOW() 
       WHERE id=$1`,
      [completion_id]
    )

    // Award ZowPoints to user
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
        user_id, 'reward', cash,
        `Mission approved: ${mission.rows[0].title}`,
        'REWARD-' + completion_id, 'success', points
      ]
    )

    res.json({
      success: true,
      message: 'Submission approved and reward sent!'
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Reject submission
router.post('/submissions/reject', async (req, res) => {
  const { completion_id, reason } = req.body
  try {
    await pool.query(
      `UPDATE mission_completions 
       SET status='rejected', reviewed_at=NOW(), proof_text=proof_text || $1
       WHERE id=$2`,
      [`\n[REJECTED: ${reason}]`, completion_id]
    )

    res.json({ success: true, message: 'Submission rejected' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get merchant stats
router.get('/stats/:merchant_id', async (req, res) => {
  const { merchant_id } = req.params
  try {
    const missions = await pool.query(
      'SELECT COUNT(*) as total_missions FROM missions WHERE merchant_id=$1',
      [merchant_id]
    )

    const completions = await pool.query(
      `SELECT 
       COUNT(*) as total_completions,
       COUNT(CASE WHEN mc.status='approved' THEN 1 END) as approved,
       COUNT(CASE WHEN mc.status='pending' THEN 1 END) as pending
       FROM mission_completions mc
       JOIN missions m ON mc.mission_id = m.id
       WHERE m.merchant_id=$1`,
      [merchant_id]
    )

    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1',
      [merchant_id]
    )

    res.json({
      success: true,
      stats: {
        total_missions: missions.rows[0].total_missions,
        total_completions: completions.rows[0].total_completions,
        approved: completions.rows[0].approved,
        pending: completions.rows[0].pending,
        wallet_balance: wallet.rows[0]?.balance || 0,
        zowpoints: wallet.rows[0]?.zowpoints || 0
      }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router