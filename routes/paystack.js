const express = require('express')
const router = express.Router()
const pool = require('../db')
require('dotenv').config()

// Initialize payment
router.post('/initialize', async (req, res) => {
  const { user_id, amount, email } = req.body
  try {
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        amount: amount * 100, // Paystack uses kobo
        metadata: { user_id }
      })
    })

    const data = await response.json()

    if (!data.status) {
      return res.status(400).json({ error: data.message })
    }

    res.json({
      success: true,
      payment_url: data.data.authorization_url,
      reference: data.data.reference
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Verify payment
router.post('/verify', async (req, res) => {
  const { reference, user_id } = req.body
  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
      }
    })

    const data = await response.json()

    if (!data.status || data.data.status !== 'success') {
      return res.status(400).json({ error: 'Payment not successful' })
    }

    const amount = data.data.amount / 100 // Convert back from kobo

    // Fund the wallet
    await pool.query(
      'UPDATE wallets SET balance = balance + $1, updated_at=NOW() WHERE user_id=$2',
      [amount, user_id]
    )

    // Calculate ZowPoints (1 point per ₦100)
    const zowpoints = Math.floor(amount / 100)

    // Add ZowPoints
    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [zowpoints, user_id]
    )

    // Record transaction
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, description, reference, status, zowpoints_earned) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [user_id, 'deposit', amount, `Wallet funded via Paystack`, reference, 'success', zowpoints]
    )

    res.json({
      success: true,
      message: `₦${amount} added to wallet! Earned ${zowpoints} ZowPoints`,
      amount,
      zowpoints
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router