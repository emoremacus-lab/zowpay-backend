const express = require('express')
const router = express.Router()
const pool = require('../db')
require('dotenv').config()

const VTPASS_BASE_URL = process.env.VTPASS_BASE_URL
const VTPASS_API_KEY = process.env.VTPASS_API_KEY
const VTPASS_SECRET_KEY = process.env.VTPASS_SECRET_KEY

// Get airtime networks
router.get('/airtime/networks', async (req, res) => {
  try {
    res.json({
      success: true,
      networks: [
        { id: 'mtn', name: 'MTN', color: '#FFD700', icon: '📱' },
        { id: 'airtel', name: 'Airtel', color: '#FF0000', icon: '📱' },
        { id: 'glo', name: 'Glo', color: '#00AA00', icon: '📱' },
        { id: 'etisalat', name: '9mobile', color: '#006400', icon: '📱' },
      ]
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Buy airtime
router.post('/airtime/buy', async (req, res) => {
  const { user_id, network, phone, amount } = req.body

  try {
    // Check wallet balance
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1',
      [user_id]
    )

    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' })
    }

    const reference = 'ZOW-AIR-' + Date.now()

    // Call VTPass API
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
        amount: amount,
        phone: phone
      })
    })

    const data = await response.json()
    console.log('VTPass response:', data)

    // Check if successful
    const success = data.code === '000' ||
      data?.content?.transactions?.status === 'delivered'

    if (success) {
      // Deduct from wallet
      await pool.query(
        'UPDATE wallets SET balance = balance - $1, updated_at=NOW() WHERE user_id=$2',
        [amount, user_id]
      )

      // Calculate ZowPoints (1 point per ₦10 airtime)
      const zowpoints = Math.floor(amount / 10)

      // Add ZowPoints
      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [zowpoints, user_id]
      )

      // Record transaction
      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, reference, status, zowpoints_earned) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [user_id, 'airtime', amount,
         `${network.toUpperCase()} Airtime - ${phone}`,
         reference, 'success', zowpoints]
      )

      res.json({
        success: true,
        message: `₦${amount} ${network.toUpperCase()} airtime sent to ${phone}!`,
        zowpoints_earned: zowpoints,
        new_balance: wallet.rows[0].balance - amount
      })
    } else {
      res.status(400).json({
        error: data.response_description || 'Airtime purchase failed'
      })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Buy data bundle
router.get('/data/plans/:network', async (req, res) => {
  const { network } = req.params
  try {
    const plans = {
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
    res.json({ success: true, plans: plans[network] || [] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
// Pay electricity
router.post('/electricity/pay', async (req, res) => {
  const { user_id, provider, meter_number, meter_type, amount } = req.body

  try {
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1', [user_id]
    )

    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' })
    }

    const reference = 'ZOW-ELEC-' + Date.now()

    const response = await fetch(`${VTPASS_BASE_URL}/pay`, {
      method: 'POST',
      headers: {
        'api-key': VTPASS_API_KEY,
        'secret-key': VTPASS_SECRET_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        request_id: reference,
        serviceID: provider,
        billersCode: meter_number,
        variation_code: meter_type,
        amount: amount,
        phone: '08000000000'
      })
    })

    const data = await response.json()
    console.log('VTPass electricity response:', data)

    const success = data.code === '000' ||
      data?.content?.transactions?.status === 'delivered'

    if (success) {
      await pool.query(
        'UPDATE wallets SET balance = balance - $1, updated_at=NOW() WHERE user_id=$2',
        [amount, user_id]
      )

      const zowpoints = Math.floor(amount / 100)

      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [zowpoints, user_id]
      )

      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, reference, status, zowpoints_earned) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [user_id, 'electricity', amount,
         `Electricity - ${provider} - ${meter_number}`,
         reference, 'success', zowpoints]
      )

      const token = data?.content?.transactions?.token || null

      res.json({
        success: true,
        message: `₦${amount} electricity payment successful!`,
        token: token,
        zowpoints_earned: zowpoints
      })
    } else {
      res.status(400).json({
        error: data.response_description || 'Payment failed'
      })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})  // Buy data bundle
router.post('/data/buy', async (req, res) => {
  const { user_id, network, phone, plan_id, amount } = req.body

  try {
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1', [user_id]
    )

    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' })
    }

    const reference = 'ZOW-DATA-' + Date.now()

    const response = await fetch(`${VTPASS_BASE_URL}/pay`, {
      method: 'POST',
      headers: {
        'api-key': VTPASS_API_KEY,
        'secret-key': VTPASS_SECRET_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        request_id: reference,
        serviceID: `${network}-data`,
        billersCode: phone,
        variation_code: plan_id,
        amount: amount,
        phone: phone
      })
    })

    const data = await response.json()
    console.log('VTPass data response:', data)

    const success = data.code === '000' ||
      data?.content?.transactions?.status === 'delivered'

    if (success) {
      await pool.query(
        'UPDATE wallets SET balance = balance - $1, updated_at=NOW() WHERE user_id=$2',
        [amount, user_id]
      )

      const zowpoints = Math.floor(amount / 10)

      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [zowpoints, user_id]
      )

      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, reference, status, zowpoints_earned) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [user_id, 'data', amount,
         `${network.toUpperCase()} Data - ${phone}`,
         reference, 'success', zowpoints]
      )

      res.json({
        success: true,
        message: `Data bundle activated for ${phone}!`,
        zowpoints_earned: zowpoints
      })
    } else {
      res.status(400).json({
        error: data.response_description || 'Data purchase failed'
      })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
module.exports = router