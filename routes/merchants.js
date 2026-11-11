const express = require('express')
const router = express.Router()
const pool = require('../db')
require('dotenv').config()

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://zowpay.ng'
const SERVICE_FEE_RATE = 0.05

// A campaign is saved as 'pending_payment' and only becomes 'active'
// once Paystack confirms the merchant's payment. No stored balance.
pool.query('ALTER TABLE missions ADD COLUMN IF NOT EXISTS payment_reference TEXT')
  .catch(err => console.error('missions column error:', err.message))
pool.query('ALTER TABLE missions ADD COLUMN IF NOT EXISTS payment_amount NUMERIC')
  .catch(err => console.error('missions column error:', err.message))

// Called by the Paystack webhook and by /missions/confirm. Safe to call many times.
const processPaidCampaign = async (reference, paidAmount) => {
  const found = await pool.query(
    'SELECT * FROM missions WHERE payment_reference=$1', [reference]
  )
  if (found.rows.length === 0) return null // not a campaign payment
  const m = found.rows[0]

  if (Number(m.payment_amount) !== Number(paidAmount)) {
    console.error(`Campaign amount mismatch on ${reference}: expected ${m.payment_amount}, paid ${paidAmount}`)
    return m
  }

  const claim = await pool.query(
    `UPDATE missions SET status='active'
     WHERE payment_reference=$1 AND status='pending_payment' RETURNING *`,
    [reference]
  )
  if (claim.rows.length === 0) return m // already activated

  await pool.query(
    `INSERT INTO transactions (user_id, type, amount, description, reference, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [m.merchant_id, 'mission', paidAmount,
     `Campaign paid: ${m.title} (includes 5% service fee)`, reference, 'success']
  )
  return claim.rows[0]
}

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
    res.json({ success: true, message: 'Merchant account activated!' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get merchant profile
router.get('/profile/:user_id', async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query('SELECT * FROM users WHERE id=$1', [user_id])
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }
    res.json({ success: true, merchant: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Create a campaign: saves it as pending_payment and returns a Paystack checkout link
router.post('/missions/create', async (req, res) => {
  const {
    merchant_id, email, title, description, type,
    reward_points, budget, max_participants, proof_type,
    time_estimate, category
  } = req.body

  try {
    const merchant = await pool.query(
      'SELECT user_type FROM users WHERE id=$1', [merchant_id]
    )
    if (merchant.rows[0]?.user_type !== 'merchant') {
      return res.status(403).json({ error: 'Merchant account required' })
    }

    const campaignBudget = Number(budget)
    if (!title || !(campaignBudget >= 1000) || !(Number(reward_points) > 0) ||
        !(Number(max_participants) > 0)) {
      return res.status(400).json({ error: 'Please fill in all campaign details' })
    }

    const serviceFee = Math.round(campaignBudget * SERVICE_FEE_RATE * 100) / 100
    const totalRequired = campaignBudget + serviceFee
    const reference = 'ZOWCAMP' + Date.now() + Math.random().toString(36).slice(2, 7).toUpperCase()

    const result = await pool.query(
      `INSERT INTO missions
       (merchant_id, title, description, type, reward_points,
        reward_cash, budget, max_participants, proof_type,
        time_estimate, category, status, payment_reference, payment_amount)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, 'pending_payment', $11, $12)
       RETURNING *`,
      [merchant_id, title, description, type, reward_points, campaignBudget,
       max_participants, proof_type, time_estimate, category, reference, totalRequired]
    )

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: email || `user${merchant_id}@zowpay.com`,
        amount: Math.round(totalRequired * 100),
        reference,
        callback_url: `${FRONTEND_URL}/?campaign_ref=${reference}`,
        metadata: { merchant_id, campaign: title }
      })
    })
    const data = await response.json()

    if (!data.status) {
      await pool.query(
        `UPDATE missions SET status='cancelled' WHERE id=$1`, [result.rows[0].id]
      )
      return res.status(400).json({ error: data.message || 'Could not start payment' })
    }

    res.json({
      success: true,
      payment_url: data.data.authorization_url,
      reference,
      service_fee: serviceFee,
      total: totalRequired,
      mission: result.rows[0]
    })
  } catch (err) {
    console.error('Campaign create error:', err)
    res.status(500).json({ error: 'Could not create campaign' })
  }
})

// App calls this after Paystack sends the merchant back (backup for the webhook)
router.post('/missions/confirm', async (req, res) => {
  try {
    const { reference } = req.body
    const found = await pool.query(
      'SELECT id, status FROM missions WHERE payment_reference=$1', [reference]
    )
    if (found.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' })
    }

    if (found.rows[0].status === 'pending_payment') {
      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
      )
      const data = await response.json()
      if (data.status && data.data.status === 'success') {
        await processPaidCampaign(reference, data.data.amount / 100)
      }
    }

    const fresh = await pool.query(
      'SELECT id, title, status FROM missions WHERE payment_reference=$1', [reference]
    )
    const status = fresh.rows[0].status
    res.json({
      success: status === 'active',
      status,
      message: status === 'active'
        ? 'Campaign is live!'
        : 'Waiting for your payment to be confirmed.',
      mission: fresh.rows[0]
    })
  } catch (err) {
    console.error('Campaign confirm error:', err)
    res.status(500).json({ error: 'Could not confirm payment' })
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

// Approve submission — ZowPoints only (no cash), and only once
router.post('/submissions/approve', async (req, res) => {
  const { completion_id } = req.body
  try {
    const info = await pool.query(
      `SELECT mc.user_id, mc.mission_id, m.title, m.reward_points
       FROM mission_completions mc
       JOIN missions m ON mc.mission_id = m.id
       WHERE mc.id=$1 AND mc.status='pending'`,
      [completion_id]
    )
    if (info.rows.length === 0) {
      return res.status(400).json({ error: 'Submission not found or already reviewed' })
    }
    const { user_id, title } = info.rows[0]
    const points = info.rows[0].reward_points || 0

    const claim = await pool.query(
      `UPDATE mission_completions
       SET status='approved', reviewed_at=NOW()
       WHERE id=$1 AND status='pending' RETURNING id`,
      [completion_id]
    )
    if (claim.rows.length === 0) {
      return res.status(400).json({ error: 'Submission already reviewed' })
    }

    if (points > 0) {
      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [points, user_id]
      )
    }

    await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [user_id, 'reward', 0, `Mission approved: ${title}`,
       'REWARD-' + completion_id, 'success', points]
    )

    res.json({ success: true, message: 'Submission approved and ZowPoints sent!' })
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
       WHERE id=$2 AND status='pending'`,
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
      `SELECT COUNT(*) as total_missions FROM missions
       WHERE merchant_id=$1 AND status <> 'cancelled'`,
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
    res.json({
      success: true,
      stats: {
        total_missions: missions.rows[0].total_missions,
        total_completions: completions.rows[0].total_completions,
        approved: completions.rows[0].approved,
        pending: completions.rows[0].pending
      }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
module.exports.processPaidCampaign = processPaidCampaign