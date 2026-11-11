const express = require('express')
const crypto = require('crypto')
const router = express.Router()
const { processPaidOrder } = require('./bills')
const { processPaidCampaign } = require('./merchants')
require('dotenv').config()

// Paystack tells us a payment succeeded.
// 1. Check the signature (proves the message really came from Paystack)
// 2. Reply 200 straight away (so Paystack does not keep retrying)
// 3. Match reference + amount to our order and deliver it once
router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-paystack-signature']
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body))
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(raw)
    .digest('hex')

  const valid =
    typeof signature === 'string' &&
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))

  if (!valid) {
    console.warn('Webhook rejected: bad signature')
    return res.sendStatus(401)
  }

  res.sendStatus(200)

  const event = req.body
  console.log('Webhook received:', event.event)

  if (event.event === 'charge.success') {
    try {
      const ref = event.data.reference
      const paid = event.data.amount / 100
      // A bill payment, or else a merchant campaign payment
      const handled = await processPaidOrder(ref, paid)
      if (!handled) await processPaidCampaign(ref, paid)
    } catch (err) {
      console.error('Webhook processing error:', err)
    }
  }
})

module.exports = router