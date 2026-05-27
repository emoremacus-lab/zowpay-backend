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
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1', [user_id]
    )
    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' })
    }

    const reference = 'ZOW-AIR-' + Date.now()

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
    console.log('VTPass airtime response:', data)

    const success = data.code === '000' ||
      data?.content?.transactions?.status === 'delivered'

    if (success) {
      await pool.query(
        'UPDATE wallets SET balance = balance - $1, updated_at=NOW() WHERE user_id=$2',
        [amount, user_id]
      )

      // ₦20 = 1 ZowPoint for airtime
      const zowpoints = Math.floor(amount / 20)

      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [zowpoints, user_id]
      )

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

// Get data plans
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

// Buy data bundle
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

      // ₦20 = 1 ZowPoint for data
      const zowpoints = Math.floor(amount / 20)

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

      // ₦100 = 1 ZowPoint for electricity
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
})

// Pay cable TV
router.post('/cable/pay', async (req, res) => {
  const { user_id, provider, smart_card_number, plan_id, amount } = req.body
  try {
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1', [user_id]
    )
    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' })
    }

    const reference = 'ZOW-CABLE-' + Date.now()

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
        billersCode: smart_card_number,
        variation_code: plan_id,
        amount: amount,
        phone: '08000000000'
      })
    })

    const data = await response.json()
    console.log('VTPass cable response:', data)

    const success = data.code === '000' ||
      data?.content?.transactions?.status === 'delivered'

    if (success) {
      await pool.query(
        'UPDATE wallets SET balance = balance - $1, updated_at=NOW() WHERE user_id=$2',
        [amount, user_id]
      )

      // ₦100 = 1 ZowPoint for cable TV
      const zowpoints = Math.floor(amount / 100)

      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [zowpoints, user_id]
      )

      await pool.query(
        'INSERT INTO transactions (user_id, type, amount, description, reference, status, zowpoints_earned) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [user_id, 'cable', amount,
         `${provider.toUpperCase()} - ${plan_id} - ${smart_card_number}`,
         reference, 'success', zowpoints]
      )

      res.json({
        success: true,
        message: `${provider.toUpperCase()} subscription activated!`,
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
})
// Fund betting account
router.post('/betting/fund', async (req, res) => {
  const { user_id, provider, customer_id, amount } = req.body
  try {
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1', [user_id]
    )
    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' })
    }

    const reference = 'ZOW-BET-' + Date.now()

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
        amount: amount,
        billersCode: customer_id,
        phone: '08000000000'
      })
    })

    const data = await response.json()
    console.log('VTPass betting response:', data)

    const success = data.code === '000' ||
      data?.content?.transactions?.status === 'delivered'

    if (success) {
      await pool.query(
        'UPDATE wallets SET balance = balance - $1, updated_at=NOW() WHERE user_id=$2',
        [amount, user_id]
      )

      // ₦50 = 1 ZowPoint for betting
      const zowpoints = Math.floor(amount / 50)

      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [zowpoints, user_id]
      )

      await pool.query(
        `INSERT INTO transactions
         (user_id, type, amount, description, reference, status, zowpoints_earned)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user_id, 'betting', amount,
          `${provider} funded - ID: ${customer_id}`,
          reference, 'success', zowpoints
        ]
      )

      res.json({
        success: true,
        message: `₦${amount} funded to ${provider} account ${customer_id}!`,
        zowpoints_earned: zowpoints
      })
    } else {
      res.status(400).json({
        error: data.response_description || 'Funding failed'
      })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
// Pay education bills
router.post('/education/pay', async (req, res) => {
  const { user_id, provider, variation_code, amount, phone, quantity } = req.body
  try {
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1', [user_id]
    )
    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' })
    }

    const reference = 'ZOW-EDU-' + Date.now()

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
        billersCode: phone,
        variation_code,
        amount,
        phone,
        quantity: quantity || 1
      })
    })

    const data = await response.json()
    console.log('VTPass education response:', data)

    const success = data.code === '000' ||
      data?.content?.transactions?.status === 'delivered'

    if (success) {
      await pool.query(
        'UPDATE wallets SET balance = balance - $1, updated_at=NOW() WHERE user_id=$2',
        [amount, user_id]
      )

      // ₦100 = 1 ZowPoint for education
      const zowpoints = Math.floor(amount / 200)

      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [zowpoints, user_id]
      )

      await pool.query(
        `INSERT INTO transactions
         (user_id, type, amount, description, reference, status, zowpoints_earned)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user_id, 'education', amount,
          `${provider.toUpperCase()} - ${variation_code}`,
          reference, 'success', zowpoints
        ]
      )

      const token = data?.content?.transactions?.token ||
        data?.content?.transactions?.pin || null

      res.json({
        success: true,
        message: `${provider.toUpperCase()} payment successful!`,
        token,
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
})
// Pay insurance
router.post('/insurance/pay', async (req, res) => {
  const {
    user_id, provider, variation_code, amount, phone,
    plate_number, vehicle_make, vehicle_model, year,
    engine_number, chasis_number, owner_name, owner_email
  } = req.body

  try {
    const wallet = await pool.query(
      'SELECT * FROM wallets WHERE user_id=$1', [user_id]
    )
    if (!wallet.rows[0] || wallet.rows[0].balance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' })
    }

    const reference = 'ZOW-INS-' + Date.now()

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
        variation_code,
        amount,
        phone,
        billersCode: plate_number,
        Insured_Name: owner_name,
        Engine_Number: engine_number,
        Chasis_Number: chasis_number,
        Plate_Number: plate_number,
        Vehicle_Make: vehicle_make,
        Vehicle_Model: vehicle_model,
        Year_of_Manufacture: year,
        Contact_Address: 'Nigeria',
        email: owner_email || `${phone}@zowpay.com`
      })
    })

    const data = await response.json()
    console.log('VTPass insurance response:', data)

    const success = data.code === '000' ||
      data?.content?.transactions?.status === 'delivered'

    if (success) {
      await pool.query(
        'UPDATE wallets SET balance = balance - $1, updated_at=NOW() WHERE user_id=$2',
        [amount, user_id]
      )

      // ₦100 = 1 ZowPoint for insurance
      const zowpoints = Math.floor(amount / 100)

      await pool.query(
        'UPDATE wallets SET zowpoints = zowpoints + $1 WHERE user_id=$2',
        [zowpoints, user_id]
      )

      await pool.query(
        `INSERT INTO transactions
         (user_id, type, amount, description, reference, status, zowpoints_earned)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          user_id, 'insurance', amount,
          `${provider} Insurance - ${plate_number}`,
          reference, 'success', zowpoints
        ]
      )

      const token = data?.content?.transactions?.token ||
        data?.content?.transactions?.pin ||
        data?.content?.transactions?.reference || null

      res.json({
        success: true,
        message: `${provider} insurance activated for ${plate_number}!`,
        token,
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
})
module.exports = router