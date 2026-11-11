const express = require('express')
const router = express.Router()
const pool = require('../db')
require('dotenv').config()

const VTPASS_BASE_URL = process.env.VTPASS_BASE_URL
const VTPASS_API_KEY = process.env.VTPASS_API_KEY
const VTPASS_SECRET_KEY = process.env.VTPASS_SECRET_KEY
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://zowpay.ng'

// ZowPoints: naira spent per 1 point
const POINT_RATE = {
  airtime: 20,
  data: 20,
  betting: 50,
  electricity: 100,
  cable: 100,
  education: 100,
  insurance: 100
}

// One row per bill. Customer pays at checkout, then we deliver.
// status: pending -> processing -> delivered
//   other endings: failed + refunded / refund_due, pending_delivery, amount_mismatch, abandoned
pool.query(`
  CREATE TABLE IF NOT EXISTS bill_orders (
    id SERIAL PRIMARY KEY,
    reference TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    description TEXT,
    details JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    vtpass_response JSONB,
    token TEXT,
    zowpoints_earned INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('bill_orders table error:', err.message))

const DATA_PLANS = {
  mtn: [
    { id: 'mtn-10mb-100', name: '100MB', amount: 100, validity: '1 day' },
    { id: 'mtn-200mb-200', name: '200MB', amount: 200, validity: '3 days' },
    { id: 'mtn-1gb-300', name: '1GB', amount: 300, validity: '30 days' },
    { id: 'mtn-2gb-500', name: '2GB', amount: 500, validity: '30 days' },
    { id: 'mtn-5gb-1000', name: '5GB', amount: 1000, validity: '30 days' },
  ],
  airtel: [
    { id: 'airtel-100mb-100', name: '100MB', amount: 100, validity: '1 day' },
    { id: 'airtel-1gb-300', name: '1GB', amount: 300, validity: '30 days' },
    { id: 'airtel-2gb-500', name: '2GB', amount: 500, validity: '30 days' },
    { id: 'airtel-5gb-1000', name: '5GB', amount: 1000, validity: '30 days' },
  ],
  glo: [
    { id: 'glo-1gb-300', name: '1GB', amount: 300, validity: '30 days' },
    { id: 'glo-2gb-500', name: '2GB', amount: 500, validity: '30 days' },
    { id: 'glo-5gb-1000', name: '5GB', amount: 1000, validity: '30 days' },
  ],
  etisalat: [
    { id: '9mobile-1gb-300', name: '1GB', amount: 300, validity: '30 days' },
    { id: '9mobile-2gb-500', name: '2GB', amount: 500, validity: '30 days' },
    { id: '9mobile-5gb-1000', name: '5GB', amount: 1000, validity: '30 days' },
  ]
}

// What each bill type needs, and what we send to VTPass
const BUILDERS = {
  airtime: {
    required: ['network', 'phone'],
    build: (d, ref, amount) => ({
      description: `${String(d.network).toUpperCase()} Airtime - ${d.phone}`,
      body: { request_id: ref, serviceID: d.network, amount, phone: d.phone }
    })
  },
  data: {
    required: ['network', 'phone', 'plan_id'],
    build: (d, ref, amount) => ({
      description: `${String(d.network).toUpperCase()} Data - ${d.phone}`,
      body: {
        request_id: ref, serviceID: `${d.network}-data`, billersCode: d.phone,
        variation_code: d.plan_id, amount, phone: d.phone
      }
    })
  },
  electricity: {
    required: ['provider', 'meter_number', 'meter_type'],
    build: (d, ref, amount) => ({
      description: `Electricity - ${d.provider} - ${d.meter_number}`,
      body: {
        request_id: ref, serviceID: d.provider, billersCode: d.meter_number,
        variation_code: d.meter_type, amount, phone: d.phone || '08000000000'
      }
    })
  },
  cable: {
    required: ['provider', 'smart_card_number', 'plan_id'],
    build: (d, ref, amount) => ({
      description: `${String(d.provider).toUpperCase()} - ${d.plan_id} - ${d.smart_card_number}`,
      body: {
        request_id: ref, serviceID: d.provider, billersCode: d.smart_card_number,
        variation_code: d.plan_id, amount, phone: d.phone || '08000000000',
        subscription_type: d.subscription_type || 'change'
      }
    })
  },
  betting: {
    required: ['provider', 'customer_id'],
    build: (d, ref, amount) => ({
      description: `${d.provider} funded - ID: ${d.customer_id}`,
      body: {
        request_id: ref, serviceID: d.provider, amount,
        billersCode: d.customer_id, phone: '08000000000'
      }
    })
  },
  education: {
    required: ['provider', 'variation_code', 'phone'],
    build: (d, ref, amount) => ({
      description: `${String(d.provider).toUpperCase()} - ${d.variation_code}`,
      body: {
        request_id: ref, serviceID: d.provider, billersCode: d.phone,
        variation_code: d.variation_code, amount, phone: d.phone,
        quantity: d.quantity || 1
      }
    })
  },
  insurance: {
    required: ['provider', 'variation_code', 'phone', 'plate_number'],
    build: (d, ref, amount) => ({
      description: `${d.provider} Insurance - ${d.plate_number}`,
      body: {
        request_id: ref, serviceID: d.provider, variation_code: d.variation_code,
        amount, phone: d.phone, billersCode: d.plate_number,
        Insured_Name: d.owner_name, Engine_Number: d.engine_number,
        Chasis_Number: d.chasis_number, Plate_Number: d.plate_number,
        Vehicle_Make: d.vehicle_make, Vehicle_Model: d.vehicle_model,
        Year_of_Manufacture: d.year, Contact_Address: 'Nigeria',
        email: d.owner_email || `${d.phone}@zowpay.com`
      }
    })
  }
}

// VTPass wants request_id to start with the Lagos date/time (YYYYMMDDHHmm)
const makeReference = (type) => {
  const lagos = new Date(Date.now() + 60 * 60 * 1000)
    .toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `${lagos}ZOW${type.slice(0, 3).toUpperCase()}${rand}`
}

// Referral bonus: both people get 500 points on the referred user's first purchase
const completeReferral = async (user_id) => {
  try {
    const referral = await pool.query(
      `SELECT * FROM referrals WHERE referred_id=$1 AND status='pending'`,
      [user_id]
    )
    if (referral.rows.length === 0) return
    const ref = referral.rows[0]
    const pointsEach = 500

    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [pointsEach, ref.referrer_id]
    )
    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [pointsEach, user_id]
    )
    await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ref.referrer_id, 'reward', 0, 'Referral bonus — friend made a first purchase!',
       'REF-BONUS-' + Date.now(), 'success', pointsEach]
    )
    await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [user_id, 'reward', 0, 'Welcome bonus — referral code applied!',
       'REF-WELCOME-' + Date.now(), 'success', pointsEach]
    )
    await pool.query(
      `UPDATE referrals SET status='completed', points_awarded=$1 WHERE id=$2`,
      [pointsEach, ref.id]
    )
    console.log('Referral completed for user:', user_id)
  } catch (err) {
    console.log('Referral completion error:', err.message)
  }
}

// VTPass price list for a service (cached 10 minutes). Used so the app can
// never choose its own price for cable, education or insurance.
const variationCache = {}
const getVariations = async (serviceID) => {
  const cached = variationCache[serviceID]
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.list
  const r = await fetch(
    `${VTPASS_BASE_URL}/service-variations?serviceID=${encodeURIComponent(serviceID)}`,
    { headers: { 'api-key': VTPASS_API_KEY } }
  )
  const data = await r.json()
  const list = data?.content?.varations || data?.content?.variations || []
  if (list.length) variationCache[serviceID] = { at: Date.now(), list }
  return list
}

const getOrder = async (reference) => {
  const r = await pool.query('SELECT * FROM bill_orders WHERE reference=$1', [reference])
  return r.rows[0] || null
}

const setStatus = (reference, status, extra = {}) =>
  pool.query(
    `UPDATE bill_orders
     SET status=$2, vtpass_response=COALESCE($3, vtpass_response),
         token=COALESCE($4, token), zowpoints_earned=COALESCE($5, zowpoints_earned),
         updated_at=NOW()
     WHERE reference=$1`,
    [reference, status,
     extra.vtpass ? JSON.stringify(extra.vtpass) : null,
     extra.token || null,
     extra.points ?? null]
  )

// Ask Paystack to return the money when delivery failed
const refundOrder = async (order) => {
  try {
    const r = await fetch('https://api.paystack.co/refund', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ transaction: order.reference })
    })
    const data = await r.json()
    console.log('Paystack refund response:', data.status, data.message)
    return data.status ? 'refunded' : 'refund_due'
  } catch (err) {
    console.error('Refund error:', err.message)
    return 'refund_due'
  }
}

// Called by BOTH the webhook and /confirm. Safe to call many times:
// only the first caller can move an order from 'pending' to 'processing'.
const processPaidOrder = async (reference, paidAmount) => {
  const order = await getOrder(reference)
  if (!order) return null // not a bill payment

  if (Number(order.amount) !== Number(paidAmount)) {
    console.error(`Amount mismatch on ${reference}: order ${order.amount}, paid ${paidAmount}`)
    await setStatus(reference, 'amount_mismatch')
    return order
  }

  const claim = await pool.query(
    `UPDATE bill_orders SET status='processing', updated_at=NOW()
     WHERE reference=$1 AND status='pending' RETURNING *`,
    [reference]
  )
  if (claim.rows.length === 0) return order // already handled

  const o = claim.rows[0]
  const amount = Number(o.amount)
  const { body } = BUILDERS[o.type].build(o.details, o.reference, amount)

  let data
  try {
    const response = await fetch(`${VTPASS_BASE_URL}/pay`, {
      method: 'POST',
      headers: {
        'api-key': VTPASS_API_KEY,
        'secret-key': VTPASS_SECRET_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000)
    })
    data = await response.json()
  } catch (err) {
    // We do not know if VTPass delivered. Do NOT refund or retry automatically.
    console.error('VTPass call error:', err.message)
    await setStatus(reference, 'pending_delivery')
    return getOrder(reference)
  }
  console.log(`VTPass ${o.type} response:`, data)

  const txStatus = data?.content?.transactions?.status
  const inProgress = ['pending', 'initiated', 'processing'].includes(txStatus) || data.code === '099'
  const delivered = txStatus === 'delivered' ||
    (data.code === '000' && !inProgress && !['failed', 'reversed'].includes(txStatus))

  if (delivered) {
    const points = Math.floor(amount / (POINT_RATE[o.type] || 100))
    const token = data?.content?.transactions?.token ||
      data?.content?.transactions?.pin ||
      data?.purchased_code || null

    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [points, o.user_id]
    )
    await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [o.user_id, o.type, amount, o.description, o.reference, 'success', points]
    )
    await setStatus(reference, 'delivered', { vtpass: data, token, points })
    await completeReferral(o.user_id)
  } else if (inProgress) {
    await setStatus(reference, 'pending_delivery', { vtpass: data })
  } else {
    const refundStatus = await refundOrder(o)
    await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [o.user_id, o.type, amount, o.description, o.reference, 'failed', 0]
    ).catch(() => {})
    await setStatus(reference, refundStatus, { vtpass: data })
  }

  return getOrder(reference)
}

const MESSAGES = {
  pending: 'Waiting for your payment to be confirmed.',
  processing: 'Payment received. Delivering your purchase…',
  delivered: 'Purchase successful!',
  pending_delivery: 'Payment received. Your purchase is being processed and will be completed shortly.',
  refunded: 'We could not complete this purchase. Your payment is being refunded.',
  refund_due: 'We could not complete this purchase. Your refund is being processed by our team.',
  amount_mismatch: 'There was a problem with your payment. Our team will contact you.',
  abandoned: 'This payment was not completed.'
}

const publicOrder = (o) => ({
  success: o.status === 'delivered',
  status: o.status,
  message: MESSAGES[o.status] || 'Processing',
  reference: o.reference,
  type: o.type,
  amount: Number(o.amount),
  description: o.description,
  token: o.token,
  zowpoints_earned: o.zowpoints_earned || 0
})

// ---------- Routes ----------

router.get('/airtime/networks', (req, res) => {
  res.json({
    success: true,
    networks: [
      { id: 'mtn', name: 'MTN', color: '#FFD700', icon: '📱' },
      { id: 'airtel', name: 'Airtel', color: '#FF0000', icon: '📱' },
      { id: 'glo', name: 'Glo', color: '#00AA00', icon: '📱' },
      { id: 'etisalat', name: '9mobile', color: '#006400', icon: '📱' },
    ]
  })
})

// Cable plans come live from VTPass
router.get('/cable/plans/:provider', async (req, res) => {
  const { provider } = req.params
  if (!['dstv', 'gotv', 'startimes'].includes(provider)) {
    return res.json({ success: true, plans: [] })
  }
  try {
    const list = await getVariations(provider)
    res.json({
      success: true,
      plans: list.map(v => ({
        id: v.variation_code,
        name: v.name,
        amount: Number(v.variation_amount)
      }))
    })
  } catch (err) {
    console.error('Cable plans error:', err.message)
    res.status(500).json({ error: 'Could not load plans' })
  }
})

router.get('/data/plans/:network', (req, res) => {
  res.json({ success: true, plans: DATA_PLANS[req.params.network] || [] })
})

// Start a bill payment: creates the order and a Paystack checkout link.
// Body: { user_id, email, type, amount, ...fields for that bill type }
router.post('/checkout', async (req, res) => {
  try {
    const { user_id, email, type, ...details } = req.body
    const builder = BUILDERS[type]
    if (!user_id || !builder) {
      return res.status(400).json({ error: 'Invalid request' })
    }

    let amount = Number(details.amount)
    if (type === 'data') {
      const plan = (DATA_PLANS[details.network] || []).find(p => p.id === details.plan_id)
      if (!plan) return res.status(400).json({ error: 'Invalid data plan' })
      amount = plan.amount // price comes from our server, not the app
    }
    if (['cable', 'education', 'insurance'].includes(type)) {
      const code = type === 'cable' ? details.plan_id : details.variation_code
      let match = null
      try {
        const list = await getVariations(details.provider)
        match = list.find(v => v.variation_code === code)
      } catch (e) { /* treated as unavailable below */ }
      if (!match) {
        return res.status(400).json({ error: 'This plan is not available right now' })
      }
      const unit = Number(match.variation_amount)
      if (type === 'education') {
        details.quantity = Math.min(10, Math.max(1, parseInt(details.quantity) || 1))
        if (unit > 0) amount = unit * details.quantity
      } else if (unit > 0) {
        amount = unit
      }
    }
    if (!Number.isFinite(amount) || amount < 50 || amount > 500000) {
      return res.status(400).json({ error: 'Invalid amount' })
    }

    const missing = builder.required.filter(k => !details[k])
    if (missing.length) {
      return res.status(400).json({ error: `Missing: ${missing.join(', ')}` })
    }

    const user = await pool.query('SELECT id FROM users WHERE id=$1', [user_id])
    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const reference = makeReference(type)
    const { description } = builder.build(details, reference, amount)

    await pool.query(
      `INSERT INTO bill_orders (reference, user_id, type, amount, description, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [reference, String(user_id), type, amount, description, JSON.stringify(details)]
    )

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: email || `user${user_id}@zowpay.com`,
        amount: Math.round(amount * 100),
        reference,
        callback_url: `${FRONTEND_URL}/?ref=${reference}`,
        metadata: { user_id, order_type: type, description }
      })
    })
    const data = await response.json()

    if (!data.status) {
      await setStatus(reference, 'abandoned')
      return res.status(400).json({ error: data.message || 'Could not start payment' })
    }

    res.json({
      success: true,
      payment_url: data.data.authorization_url,
      reference,
      amount
    })
  } catch (err) {
    console.error('Checkout error:', err)
    res.status(500).json({ error: 'Could not start payment' })
  }
})

// App calls this after Paystack sends the customer back (backup for the webhook).
router.post('/confirm', async (req, res) => {
  try {
    const { reference } = req.body
    const order = await getOrder(reference)
    if (!order) return res.status(404).json({ error: 'Order not found' })

    if (order.status === 'pending') {
      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
      )
      const data = await response.json()
      if (data.status && data.data.status === 'success') {
        await processPaidOrder(reference, data.data.amount / 100)
      }
    }

    res.json(publicOrder(await getOrder(reference)))
  } catch (err) {
    console.error('Confirm error:', err)
    res.status(500).json({ error: 'Could not confirm payment' })
  }
})

// App polls this while status is pending / processing.
router.get('/order/:reference', async (req, res) => {
  try {
    const order = await getOrder(req.params.reference)
    if (!order) return res.status(404).json({ error: 'Order not found' })
    res.json(publicOrder(order))
  } catch (err) {
    res.status(500).json({ error: 'Could not load order' })
  }
})

module.exports = router
module.exports.processPaidOrder = processPaidOrder
module.exports.completeReferral = completeReferral