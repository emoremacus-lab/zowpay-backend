const express = require('express')
const router = express.Router()
const pool = require('../db')

// Get admin overview stats
router.get('/stats', async (req, res) => {
  try {
    const users = await pool.query(
      'SELECT COUNT(*) as total FROM users'
    )
    const merchants = await pool.query(
      `SELECT COUNT(*) as total FROM users WHERE user_type='merchant'`
    )
    const missions = await pool.query(
      `SELECT COUNT(*) as total FROM missions WHERE status='active'`
    )
    const pendingProofs = await pool.query(
      `SELECT COUNT(*) as total FROM mission_completions WHERE status='pending'`
    )
    const transactions = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type='deposit' AND status='success'`
    )
    const zowpoints = await pool.query(
      `SELECT COALESCE(SUM(zowpoints), 0) as total FROM wallets`
    )
    const revenue = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type='mission' AND status='success'`
    )

    res.json({
      success: true,
      stats: {
        total_users: users.rows[0].total,
        total_merchants: merchants.rows[0].total,
        active_missions: missions.rows[0].total,
        pending_proofs: pendingProofs.rows[0].total,
        total_deposits: transactions.rows[0].total,
        total_zowpoints: zowpoints.rows[0].total,
        platform_revenue: revenue.rows[0].total
      }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get all users
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.*, w.balance, w.zowpoints
       FROM users u
       LEFT JOIN wallets w ON u.id = w.user_id
       ORDER BY u.created_at DESC
       LIMIT 50`
    )
    res.json({ success: true, users: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get all merchants
router.get('/merchants', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.*, w.balance, w.zowpoints,
       COUNT(m.id) as total_missions
       FROM users u
       LEFT JOIN wallets w ON u.id = w.user_id
       LEFT JOIN missions m ON u.id = m.merchant_id
       WHERE u.user_type='merchant'
       GROUP BY u.id, w.balance, w.zowpoints
       ORDER BY u.created_at DESC`
    )
    res.json({ success: true, merchants: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get all missions
router.get('/missions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*,
       u.full_name as merchant_name, u.phone as merchant_phone,
       COUNT(mc.id) as total_submissions,
       COUNT(CASE WHEN mc.status='pending' THEN 1 END) as pending_count,
       COUNT(CASE WHEN mc.status='approved' THEN 1 END) as approved_count
       FROM missions m
       LEFT JOIN users u ON m.merchant_id = u.id
       LEFT JOIN mission_completions mc ON m.id = mc.mission_id
       GROUP BY m.id, u.full_name, u.phone
       ORDER BY m.created_at DESC`
    )
    res.json({ success: true, missions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get all transactions
router.get('/transactions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, u.phone, u.full_name
       FROM transactions t
       LEFT JOIN users u ON t.user_id = u.id
       ORDER BY t.created_at DESC
       LIMIT 50`
    )
    res.json({ success: true, transactions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get pending proofs
router.get('/proofs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mc.*, 
       u.phone, u.full_name,
       m.title as mission_title,
       m.reward_points, m.reward_cash
       FROM mission_completions mc
       JOIN users u ON mc.user_id = u.id
       JOIN missions m ON mc.mission_id = m.id
       WHERE mc.status='pending'
       ORDER BY mc.submitted_at DESC`
    )
    res.json({ success: true, proofs: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Approve proof from admin
router.post('/proofs/approve', async (req, res) => {
  const { completion_id, user_id, mission_id } = req.body
  try {
    const mission = await pool.query(
      'SELECT * FROM missions WHERE id=$1', [mission_id]
    )
    const points = mission.rows[0].reward_points
    const cash = Number(mission.rows[0].reward_cash) || 0

    await pool.query(
      `UPDATE mission_completions 
       SET status='approved', reviewed_at=NOW() 
       WHERE id=$1`,
      [completion_id]
    )

    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [points, user_id]
    )

    if (cash > 0) {
      await pool.query(
        'UPDATE wallets SET balance = balance + $1 WHERE user_id=$2',
        [cash, user_id]
      )
    }

    await pool.query(
      `INSERT INTO transactions 
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user_id, 'reward', cash,
        `Mission approved: ${mission.rows[0].title}`,
        'ADMIN-REWARD-' + completion_id, 'success', points
      ]
    )

    res.json({ success: true, message: 'Proof approved and reward sent!' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Reject proof from admin
router.post('/proofs/reject', async (req, res) => {
  const { completion_id } = req.body
  try {
    await pool.query(
      `UPDATE mission_completions 
       SET status='rejected', reviewed_at=NOW() 
       WHERE id=$1`,
      [completion_id]
    )
    res.json({ success: true, message: 'Proof rejected' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Suspend user
router.post('/users/suspend', async (req, res) => {
  const { user_id } = req.body
  try {
    await pool.query(
      `UPDATE users SET is_verified=false WHERE id=$1`,
      [user_id]
    )
    res.json({ success: true, message: 'User suspended' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get platform revenue breakdown
router.get('/revenue', async (req, res) => {
  try {
    const monthly = await pool.query(
      `SELECT 
       DATE_TRUNC('month', created_at) as month,
       SUM(amount) as total
       FROM transactions
       WHERE type='mission' AND status='success'
       GROUP BY month
       ORDER BY month DESC
       LIMIT 6`
    )

    const byType = await pool.query(
      `SELECT type, COUNT(*) as count, SUM(amount) as total
       FROM transactions
       WHERE status='success'
       GROUP BY type`
    )

    res.json({
      success: true,
      monthly: monthly.rows,
      by_type: byType.rows
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router