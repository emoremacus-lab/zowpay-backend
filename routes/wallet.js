const express = require('express')
const router = express.Router()
const pool = require('../db')

// Get wallet balance
router.get('/balance/:user_id', async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1',
      [user_id]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wallet not found' })
    }
    res.json({ success: true, wallet: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get transaction history
router.get('/transactions/:user_id', async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [user_id]
    )
    res.json({ success: true, transactions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Add money to wallet (after Paystack payment)
router.post('/fund', async (req, res) => {
  const { user_id, amount, reference } = req.body
  try {
    // Update wallet balance
    await pool.query(
      'UPDATE wallets SET balance = balance + $1, updated_at=NOW() WHERE user_id=$2',
      [amount, user_id]
    )

    // Record transaction in ledger
    const zowpoints = Math.floor(amount / 100)
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, description, reference, status, zowpoints_earned) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [user_id, 'deposit', amount, `Wallet funded with ₦${amount}`, reference, 'success', zowpoints]
    )

    // Add ZowPoints
    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [zowpoints, user_id]
    )

    res.json({ success: true, message: `Wallet funded! Earned ${zowpoints} ZowPoints` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Send money
router.post('/send', async (req, res) => {
  const { sender_id, receiver_phone, amount } = req.body
  try {
    // Check sender balance
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1',
      [sender_id]
    )
    if (wallet.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' })
    }

    // Find receiver
    const receiver = await pool.query(
      'SELECT * FROM users WHERE phone=$1',
      [receiver_phone]
    )
    if (receiver.rows.length === 0) {
      return res.status(404).json({ error: 'Receiver not found' })
    }

    const receiverId = receiver.rows[0].id
    const reference = 'ZOW' + Date.now()

    // Deduct from sender
    await pool.query(
      'UPDATE wallets SET balance = balance - $1 WHERE user_id=$2',
      [amount, sender_id]
    )

    // Add to receiver
    await pool.query(
      'UPDATE wallets SET balance = balance + $1 WHERE user_id=$2',
      [amount, receiverId]
    )

    // Record sender transaction
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, description, reference, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [sender_id, 'send', amount, `Sent ₦${amount} to ${receiver_phone}`, reference, 'success']
    )

    // Record receiver transaction
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, description, reference, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [receiverId, 'receive', amount, `Received ₦${amount}`, reference + '_R', 'success']
    )

    // ZowPoints for sender
    const zowpoints = Math.floor(amount / 200)
    await pool.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [zowpoints, sender_id]
    )

    res.json({ success: true, message: `₦${amount} sent successfully! Earned ${zowpoints} ZowPoints` })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router