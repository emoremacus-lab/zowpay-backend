const express = require('express')
const router = express.Router()
const pool = require('../db')

// ZowPoints balance. No cash balance is held — Zowpay does not store customer money.
router.get('/balance/:user_id', async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query(
      'SELECT user_id, zowpoints FROM wallets WHERE user_id=$1',
      [user_id]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }
    res.json({ success: true, wallet: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Purchase and rewards history
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

module.exports = router