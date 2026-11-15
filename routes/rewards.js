const express = require('express')
const router = express.Router()
const pool = require('../db')
require('dotenv').config()

const VTPASS_BASE_URL = process.env.VTPASS_BASE_URL
const VTPASS_API_KEY = process.env.VTPASS_API_KEY
const VTPASS_SECRET_KEY = process.env.VTPASS_SECRET_KEY

// ZowPoints are loyalty points with no cash value. They can be redeemed for
// airtime only (MVP) — never exchanged for money.
// Fixed value: 2 points = NGN 1 of airtime, so points are always backed by merchant money.
const POINTS_PER_NAIRA = 2
const MAX_REDEMPTIONS_PER_DAY = 5

const airtime = (id, value) => ({
  id,
  title: `Airtime ₦${value.toLocaleString()}`,
  points: value * POINTS_PER_NAIRA,
  type: 'airtime',
  value,
  description: `Get ₦${value.toLocaleString()} airtime on the network you choose`,
  icon: '📞',
  category: 'Airtime'
})
const REWARDS = {
  1: airtime(1, 100),
  2: airtime(2, 200),
  3: airtime(3, 500),
  4: airtime(4, 1000)
}

const NETWORKS = [
  { id: 'mtn', name: 'MTN' },
  { id: 'airtel', name: 'Airtel' },
  { id: 'glo', name: 'Glo' },
  { id: 'etisalat', name: '9mobile (T2)' }
]

// VTPass request ids must start with today's Lagos date and time (YYYYMMDDHHmm)
const makeReference = () => {
  const lagos = new Date(Date.now() + 60 * 60 * 1000)
    .toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `${lagos}ZOWRDM${rand}`
}

// Get rewards catalog
router.get('/catalog', (req, res) => {
  const rewards = Object.values(REWARDS).map(r => ({
    id: r.id,
    title: r.title,
    description: r.description,
    points_required: r.points,
    reward_type: r.type,
    reward_value: r.value,
    icon: r.icon,
    category: r.category
  }))
  res.json({ success: true, rewards, networks: NETWORKS })
})

// Redeem a reward. Steps:
// 1. take the points (only if the user has enough),
// 2. send the airtime through VTPass,
// 3. if VTPass clearly fails, give the points back.
router.post('/redeem', async (req, res) => {
  const { user_id, reward_id, phone, network } = req.body

  const reward = REWARDS[reward_id]
  if (!reward) {
    return res.status(400).json({ error: 'Invalid reward' })
  }
  if (!NETWORKS.some(n => n.id === network)) {
    return res.status(400).json({ error: 'Choose the network for this number' })
  }
  if (!/^0[789][01]\d{8}$/.test(String(phone || ''))) {
    return res.status(400).json({ error: 'Enter a valid 11-digit Nigerian phone number' })
  }
  if (!user_id) {
    return res.status(400).json({ error: 'Invalid request' })
  }

  try {
    // Limit how many redemptions one account can make per day
    const today = await pool.query(
      `SELECT COUNT(*) FROM transactions
       WHERE user_id=$1 AND reference LIKE '%ZOWRDM%'
       AND created_at > NOW() - INTERVAL '24 hours'`,
      [user_id]
    )
    if (Number(today.rows[0].count) >= MAX_REDEMPTIONS_PER_DAY) {
      return res.status(429).json({ error: 'Daily redemption limit reached. Try again tomorrow.' })
    }

    // 1. Deduct points only if the user has enough — one atomic step
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

    const reference = makeReference()
    await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [user_id, 'reward', 0,
       `ZowPoints redeemed: ${reward.title} for ${phone}`,
       reference, 'pending', -reward.points]
    )

    // 2. Send the airtime
    let data
    try {
      const response = await fetch(`${VTPASS_BASE_URL}/pay`, {
        method: 'POST',
        headers: {
          'api-key': VTPASS_API_KEY,
          'secret-key': VTPASS_SECRET_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          request_id: reference,
          serviceID: network,
          amount: reward.value,
          phone
        }),
        signal: AbortSignal.timeout(45000)
      })
      data = await response.json()
    } catch (err) {
      // We cannot tell whether VTPass delivered. Keep the points deducted and leave
      // the request as 'pending' so nobody is paid twice. Zowpay checks it by hand.
      console.error('Redeem VTPass call error:', err.message)
      return res.json({
        success: true,
        status: 'processing',
        message: `${reward.title} is being processed. It will reach ${phone} shortly.`,
        points_used: reward.points,
        remaining_points: deducted.rows[0].zowpoints
      })
    }
    console.log('VTPass redeem response:', data)

    const txStatus = data?.content?.transactions?.status
    const inProgress = ['pending', 'initiated', 'processing'].includes(txStatus) || data.code === '099'
    const delivered = txStatus === 'delivered' ||
      (data.code === '000' && !inProgress && !['failed', 'reversed'].includes(txStatus))

    if (delivered) {
      await pool.query(
        `UPDATE transactions SET status='success' WHERE reference=$1`, [reference]
      )
      return res.json({
        success: true,
        status: 'delivered',
        message: `${reward.title} has been sent to ${phone}!`,
        reward_type: reward.type,
        reward_value: reward.value,
        points_used: reward.points,
        remaining_points: deducted.rows[0].zowpoints
      })
    }

    if (inProgress) {
      return res.json({
        success: true,
        status: 'processing',
        message: `${reward.title} is being processed. It will reach ${phone} shortly.`,
        points_used: reward.points,
        remaining_points: deducted.rows[0].zowpoints
      })
    }

    // 3. VTPass clearly failed: give the points back (only once)
    const marked = await pool.query(
      `UPDATE transactions SET status='failed', zowpoints_earned=0
       WHERE reference=$1 AND status='pending' RETURNING id`,
      [reference]
    )
    let remaining = deducted.rows[0].zowpoints
    if (marked.rows.length > 0) {
      const back = await pool.query(
        `UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2 RETURNING zowpoints`,
        [reward.points, user_id]
      )
      remaining = back.rows[0].zowpoints
    }
    return res.status(502).json({
      error: 'We could not deliver the airtime right now. Your points have been returned.',
      remaining_points: remaining
    })
  } catch (err) {
    console.error('Redeem error:', err)
    res.status(500).json({ error: 'Could not complete the redemption' })
  }
})

// Get redemption history
router.get('/history/:user_id', async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query(
      `SELECT * FROM transactions
       WHERE user_id=$1 AND type='reward'
       AND (reference LIKE '%ZOWRDM%' OR reference LIKE 'ZOW-REDEEM-%')
       ORDER BY created_at DESC
       LIMIT 20`,
      [user_id]
    )
    res.json({ success: true, history: result.rows })
  } catch (err) {
    console.error('History error:', err)
    res.status(500).json({ error: 'Could not load history' })
  }
})

module.exports = router