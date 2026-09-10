const express = require('express')
const router = express.Router()
const pool = require('../db')
require('dotenv').config()

// Helper — check if user is merchant
const isMerchant = async (user_id) => {
  const result = await pool.query(
    'SELECT user_type FROM users WHERE id=$1', [user_id]
  )
  return result.rows[0]?.user_type === 'merchant'
}

// Initialize payment
router.post('/initialize', async (req, res) => {
  const { user_id, amount, email } = req.body
  try {
    const response = await fetch(
      'https://api.paystack.co/transaction/initialize',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email,
          amount: amount * 100,
          metadata: { user_id }
        })
      }
    )

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
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    )

    const data = await response.json()

    if (!data.status || data.data.status !== 'success') {
      return res.status(400).json({ error: 'Payment not successful' })
    }

    const amount = data.data.amount / 100

    // Fund the wallet
    await pool.query(
      'UPDATE wallets SET balance = balance + $1, updated_at=NOW() WHERE user_id=$2',
      [amount, user_id]
    )

    // Only customers earn ZowPoints — merchants do not
    const merchantUser = await isMerchant(user_id)
    const zowpoints = merchantUser ? 0 : Math.floor(amount / 200)

    if (zowpoints > 0) {
      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [zowpoints, user_id]
      )
    }

    // Record transaction
    await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, description, reference, status, zowpoints_earned)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user_id, 'deposit', amount,
        'Wallet funded via Paystack',
        reference, 'success', zowpoints
      ]
    )

    res.json({
      success: true,
      message: merchantUser
        ? `₦${amount} added to wallet!`
        : `₦${amount} added to wallet! Earned ${zowpoints} ZowPoints`,
      amount,
      zowpoints
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Complete referral if first deposit
try {
  const pool2 = require('../db')
  const referral = await pool2.query(
    `SELECT * FROM referrals WHERE referred_id=$1 AND status='pending'`,
    [user_id]
  )
  if (referral.rows.length > 0) {
    const ref = referral.rows[0]
    const pointsEach = 500
    await pool2.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [pointsEach, ref.referrer_id]
    )
    await pool2.query(
      'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
      [pointsEach, user_id]
    )
    await pool2.query(
      `UPDATE referrals SET status='completed', points_awarded=$1 WHERE id=$2`,
      [pointsEach, ref.id]
    )
    console.log('Referral completed for user:', user_id)
  }
} catch (refErr) {
  console.log('Referral error:', refErr.message)
}

// Create virtual account
router.post('/create-virtual-account', async (req, res) => {
  const { user_id, phone, email, full_name } = req.body
  try {
    const customerRes = await fetch(
      'https://api.paystack.co/customer',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: email || `${phone}@zowpay.com`,
          phone: phone,
          first_name: full_name?.split(' ')[0] || 'Zowpay',
          last_name: full_name?.split(' ')[1] || 'User'
        })
      }
    )

    const customerData = await customerRes.json()
    console.log('Customer created:', customerData)

    if (!customerData.status) {
      return res.status(400).json({
        error: customerData.message || 'Failed to create customer'
      })
    }

    const customerCode = customerData.data.customer_code

    const accountRes = await fetch(
      'https://api.paystack.co/dedicated_account',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          customer: customerCode,
          preferred_bank: 'wema-bank'
        })
      }
    )

    const accountData = await accountRes.json()
    console.log('Virtual account:', accountData)

    if (!accountData.status) {
      return res.status(400).json({
        error: accountData.message || 'Failed to create virtual account'
      })
    }

    const account = accountData.data

    await pool.query(
      `INSERT INTO virtual_accounts
       (user_id, account_number, account_name, bank_name, customer_code)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
       account_number = $2, account_name = $3,
       bank_name = $4, customer_code = $5`,
      [
        user_id,
        account.account_number,
        account.account_name,
        account.bank.name,
        customerCode
      ]
    )

    res.json({
      success: true,
      account: {
        account_number: account.account_number,
        account_name: account.account_name,
        bank_name: account.bank.name
      }
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get virtual account
router.get('/virtual-account/:user_id', async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query(
      'SELECT * FROM virtual_accounts WHERE user_id=$1',
      [user_id]
    )
    if (result.rows.length === 0) {
      return res.json({ success: false, account: null })
    }
    res.json({ success: true, account: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Webhook — auto fund wallet on bank transfer
router.post('/webhook', async (req, res) => {
  const event = req.body
  console.log('Webhook received:', event.event)

  if (
    event.event === 'charge.success' ||
    event.event === 'transfer.success'
  ) {
    try {
      const data = event.data
      const amount = data.amount / 100
      const customerCode = data.customer?.customer_code

      if (customerCode) {
        const accountResult = await pool.query(
          'SELECT user_id FROM virtual_accounts WHERE customer_code=$1',
          [customerCode]
        )

        if (accountResult.rows.length > 0) {
          const userId = accountResult.rows[0].user_id
          const reference = data.reference

          // Check if already processed
          const existing = await pool.query(
            'SELECT id FROM transactions WHERE reference=$1',
            [reference]
          )

          if (existing.rows.length === 0) {
            // Fund wallet
            await pool.query(
              'UPDATE wallets SET balance = balance + $1, updated_at=NOW() WHERE user_id=$2',
              [amount, userId]
            )

            // Only customers earn ZowPoints
            const merchantUser = await isMerchant(userId)
            const zowpoints = merchantUser
              ? 0 : Math.floor(amount / 200)

            if (zowpoints > 0) {
              await pool.query(
                'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
                [zowpoints, userId]
              )
            }

            await pool.query(
              `INSERT INTO transactions
               (user_id, type, amount, description, reference, status, zowpoints_earned)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                userId, 'deposit', amount,
                'Bank Transfer received',
                reference, 'success', zowpoints
              ]
            )

            console.log(`Wallet funded: ₦${amount} for user ${userId}`)
          }
        }
      }
    } catch (err) {
      console.error('Webhook error:', err)
    }
  }

  res.sendStatus(200)
})

module.exports = router