const express = require('express')
const router = express.Router()
const pool = require('../db')
const { approveCompletion } = require('./merchants')
const { adminLogin, loginLimiter, requireAdmin, auditLogger } = require('../middleware/adminAuth')
router.post('/login', loginLimiter, adminLogin)
router.use(requireAdmin)
router.use(auditLogger)
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
    // Total value of bills Zowpay has delivered (no wallet deposits any more)
    const transactions = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) as total FROM bill_orders WHERE status='delivered'`
    )
    const zowpoints = await pool.query(
      `SELECT COALESCE(SUM(zowpoints), 0) as total FROM wallets`
    )
    // Zowpay's own earnings: the 5% fee on paid campaigns + service fees on delivered bills
    const campaignFees = await pool.query(
      `SELECT COALESCE(SUM(payment_amount - budget), 0) as total FROM missions
       WHERE payment_reference IS NOT NULL
       AND status NOT IN ('pending_payment', 'cancelled')`
    )
    const billFees = await pool.query(
      `SELECT COALESCE(SUM(fee), 0) as total FROM bill_orders WHERE status='delivered'`
    )
    const revenue = {
      rows: [{ total: Number(campaignFees.rows[0].total) + Number(billFees.rows[0].total) }]
    }

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

// Get proofs: every status, newest first. Photos are only sent for pending items
// (approved and rejected ones would make the page very heavy).
router.get('/proofs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mc.id, mc.mission_id, mc.user_id, mc.status, mc.proof_text,
       mc.submitted_at, mc.reviewed_at,
       CASE WHEN mc.status='pending' THEN mc.proof_url ELSE NULL END AS proof_url,
       u.phone, u.full_name,
       m.title as mission_title,
       m.reward_points, m.reward_cash
       FROM mission_completions mc
       JOIN users u ON mc.user_id = u.id
       JOIN missions m ON mc.mission_id = m.id
       ORDER BY mc.submitted_at DESC
       LIMIT 200`
    )
    res.json({ success: true, proofs: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Approve proof from admin: same safe routine as the merchant route
// (pays once, respects the campaign's places, closes the campaign when full)
router.post('/proofs/approve', async (req, res) => {
  const { completion_id } = req.body
  try {
    const r = await approveCompletion(completion_id)
    if (r.error) return res.status(400).json({ error: r.error })
    res.json({ success: true, message: 'Proof approved and reward sent!' })
  } catch (err) {
    console.error('Admin approve error:', err)
    res.status(500).json({ error: 'Could not approve proof' })
  }
})

// Reject proof from admin (only pending ones)
router.post('/proofs/reject', async (req, res) => {
  const { completion_id } = req.body
  try {
    const r = await pool.query(
      `UPDATE mission_completions
       SET status='rejected', reviewed_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING id`,
      [completion_id]
    )
    if (r.rows.length === 0) {
      return res.status(400).json({ error: 'Proof not found or already reviewed' })
    }
    res.json({ success: true, message: 'Proof rejected' })
  } catch (err) {
    console.error('Admin reject error:', err)
    res.status(500).json({ error: 'Could not reject proof' })
  }
})

// Suspend or reactivate user (toggle)
router.post('/users/suspend', async (req, res) => {
  const { user_id } = req.body
  try {
    // Get current status first
    const user = await pool.query(
      'SELECT is_verified FROM users WHERE id=$1',
      [user_id]
    )

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const currentStatus = user.rows[0].is_verified

    // Toggle — if currently verified, suspend. If suspended, reactivate
    await pool.query(
      'UPDATE users SET is_verified=$1 WHERE id=$2',
      [!currentStatus, user_id]
    )

    res.json({
      success: true,
      message: currentStatus ? 'User suspended!' : 'User reactivated!',
      is_verified: !currentStatus
    })
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
router.post('/export-log', (req, res) => res.json({ success: true }))

router.get('/audit', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, method, path, details, ip, created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT 200')
    res.json({ success: true, logs: r.rows })
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not load audit log' })
  }
})
module.exports = router