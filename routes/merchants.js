const express = require('express')
const router = express.Router()
const pool = require('../db')
require('dotenv').config()

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://zowpay.ng'
const SERVICE_FEE_RATE = 0.05

// Zowpay rules for campaigns
// Every point is backed by the merchant's money: NGN 1 of budget = POINTS_PER_NAIRA points.
// The merchant chooses the budget and the number of people. The server works out
// the points per person, so a merchant can never hand out more points than they paid for.
const POINTS_PER_NAIRA = 2
const MIN_BUDGET = 1000
const MAX_BUDGET = 500000
const MAX_PEOPLE = 1000
const MIN_POINTS_PER_PERSON = 20
const MAX_POINTS_PER_PERSON = 2000

// A campaign is saved as 'pending_payment' and only becomes 'active'
// once Paystack confirms the merchant's payment. No stored balance.
pool.query('ALTER TABLE missions ADD COLUMN IF NOT EXISTS payment_reference TEXT')
  .catch(err => console.error('missions column error:', err.message))
pool.query('ALTER TABLE missions ADD COLUMN IF NOT EXISTS payment_amount NUMERIC')
  .catch(err => console.error('missions column error:', err.message))

// Approves one submission safely: locks the mission, makes sure the campaign still has
// room, pays the points once, and closes the campaign when everyone has been paid.
const approveCompletion = async (completion_id) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const info = await client.query(
      `SELECT mc.id, mc.user_id, mc.mission_id, mc.status,
              m.title, m.reward_points, m.max_participants
       FROM mission_completions mc
       JOIN missions m ON mc.mission_id = m.id
       WHERE mc.id=$1
       FOR UPDATE OF mc, m`,
      [completion_id]
    )
    if (info.rows.length === 0 || info.rows[0].status !== 'pending') {
      await client.query('ROLLBACK')
      return { error: 'Submission not found or already reviewed' }
    }
    const c = info.rows[0]
    const points = Number(c.reward_points) || 0

    const done = await client.query(
      `SELECT COUNT(*) FROM mission_completions
       WHERE mission_id=$1 AND status='approved'`,
      [c.mission_id]
    )
    const approvedSoFar = Number(done.rows[0].count)
    if (approvedSoFar >= Number(c.max_participants)) {
      await client.query('ROLLBACK')
      return { error: 'This campaign has used all of its points' }
    }

    await client.query(
      `UPDATE mission_completions SET status='approved', reviewed_at=NOW() WHERE id=$1`,
      [completion_id]
    )
    if (points > 0) {
      await client.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [points, c.user_id]
      )
    }
    await client.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [c.user_id, 'reward', 0, `Mission reward: ${c.title}`,
       'REWARD-' + completion_id, 'success', points]
    )
    if (approvedSoFar + 1 >= Number(c.max_participants)) {
      await client.query(`UPDATE missions SET status='completed' WHERE id=$1`, [c.mission_id])
    }
    await client.query('COMMIT')
    return { ok: true, points, title: c.title }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

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

// Lets the app show the merchant the reward and the total before paying.
router.get('/missions/preview/:budget/:people', (req, res) => {
  const budget = Number(req.params.budget)
  const people = parseInt(req.params.people)
  if (!Number.isFinite(budget) || !Number.isInteger(people) || people < 1) {
    return res.status(400).json({ error: 'Invalid input' })
  }
  const pointsPerPerson = Math.floor((budget * POINTS_PER_NAIRA) / people)
  const serviceFee = Math.round(budget * SERVICE_FEE_RATE * 100) / 100
  let problem = null
  if (budget < MIN_BUDGET || budget > MAX_BUDGET) {
    problem = `Budget must be between ₦${MIN_BUDGET.toLocaleString()} and ₦${MAX_BUDGET.toLocaleString()}`
  } else if (people > MAX_PEOPLE) {
    problem = `Maximum ${MAX_PEOPLE} people per campaign`
  } else if (pointsPerPerson < MIN_POINTS_PER_PERSON) {
    problem = 'Reward per person is too small. Raise the budget or reduce the people.'
  } else if (pointsPerPerson > MAX_POINTS_PER_PERSON) {
    problem = `Reward per person is above ${MAX_POINTS_PER_PERSON.toLocaleString()} points. Add more people or lower the budget.`
  }
  res.json({
    success: !problem,
    problem,
    points_per_person: pointsPerPerson,
    service_fee: serviceFee,
    total: budget + serviceFee
  })
})

// Create a campaign: saves it as pending_payment and returns a Paystack checkout link
router.post('/missions/create', async (req, res) => {
  const {
    merchant_id, email, title, description, type,
    budget, max_participants, proof_type,
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
    const people = parseInt(max_participants)
    if (!title || !Number.isFinite(campaignBudget) || !Number.isInteger(people)) {
      return res.status(400).json({ error: 'Please fill in all campaign details' })
    }
    if (campaignBudget < MIN_BUDGET || campaignBudget > MAX_BUDGET) {
      return res.status(400).json({
        error: `Budget must be between ₦${MIN_BUDGET.toLocaleString()} and ₦${MAX_BUDGET.toLocaleString()}`
      })
    }
    if (people < 1 || people > MAX_PEOPLE) {
      return res.status(400).json({ error: `Number of people must be between 1 and ${MAX_PEOPLE}` })
    }

    // The server decides the reward. The merchant cannot type their own number.
    const pointsPerPerson = Math.floor((campaignBudget * POINTS_PER_NAIRA) / people)
    if (pointsPerPerson < MIN_POINTS_PER_PERSON) {
      return res.status(400).json({
        error: `Each person would get only ${pointsPerPerson} points. Raise the budget or reduce the number of people.`
      })
    }
    if (pointsPerPerson > MAX_POINTS_PER_PERSON) {
      return res.status(400).json({
        error: `Each person would get ${pointsPerPerson.toLocaleString()} points, above the ${MAX_POINTS_PER_PERSON.toLocaleString()} limit. Add more people or lower the budget.`
      })
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
      [merchant_id, title, description, type, pointsPerPerson, campaignBudget,
       people, proof_type, time_estimate, category, reference, totalRequired]
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
      points_per_person: pointsPerPerson,
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

// Approve submission — ZowPoints only (no cash), once, and within the campaign's budget
router.post('/submissions/approve', async (req, res) => {
  const { completion_id } = req.body
  try {
    const r = await approveCompletion(completion_id)
    if (r.error) return res.status(400).json({ error: r.error })
    res.json({ success: true, message: 'Submission approved and ZowPoints sent!' })
  } catch (err) {
    console.error('Approve error:', err)
    res.status(500).json({ error: 'Could not approve submission' })
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
module.exports.approveCompletion = approveCompletion