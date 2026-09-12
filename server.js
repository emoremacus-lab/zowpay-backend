const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
require('dotenv').config()

const app = express()

// ═══════════════════════════════════════
// SECURITY HEADERS
// ═══════════════════════════════════════
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}))

// ═══════════════════════════════════════
// CORS — only allow Zowpay frontend
// ═══════════════════════════════════════
const allowedOrigins = [
  'https://zowpay.ng',
  'https://www.zowpay.ng',
  'http://localhost:5173',
  'http://localhost:3000'
]

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman)
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) {
      return callback(null, true)
    }
    callback(new Error('Not allowed by CORS'))
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}))

// ═══════════════════════════════════════
// BODY PARSING — limit payload size
// ═══════════════════════════════════════
app.use(express.json({ limit: '10kb' }))
app.use(express.urlencoded({ extended: true, limit: '10kb' }))

// ═══════════════════════════════════════
// RATE LIMITERS
// ═══════════════════════════════════════

// General API limiter — 100 requests per 15 minutes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
})

// OTP limiter — max 5 OTP requests per 15 minutes per IP
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    error: 'Too many OTP requests. Please wait 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false
})

// Payment limiter — max 10 payment requests per 15 minutes
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: 'Too many payment requests. Please slow down.'
  },
  standardHeaders: true,
  legacyHeaders: false
})

// Admin limiter — stricter for admin routes
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: {
    error: 'Too many admin requests.'
  },
  standardHeaders: true,
  legacyHeaders: false
})

// ═══════════════════════════════════════
// APPLY GENERAL LIMITER TO ALL ROUTES
// ═══════════════════════════════════════
app.use('/api/', generalLimiter)

// ═══════════════════════════════════════
// ROUTES WITH SPECIFIC LIMITERS
// ═══════════════════════════════════════

// Auth — OTP rate limited
const authRoutes = require('./routes/auth')
app.use('/api/auth/send-otp', otpLimiter)
app.use('/api/auth', authRoutes)

// Wallet
const walletRoutes = require('./routes/wallet')
app.use('/api/wallet', walletRoutes)

// Paystack — payment rate limited
const paystackRoutes = require('./routes/paystack')
app.use('/api/paystack/initialize', paymentLimiter)
app.use('/api/paystack', paystackRoutes)

// Bills
const billsRoutes = require('./routes/bills')
app.use('/api/bills', billsRoutes)

// Missions
const missionsRoutes = require('./routes/missions')
app.use('/api/missions', missionsRoutes)

// Merchants
const merchantsRoutes = require('./routes/merchants')
app.use('/api/merchants', merchantsRoutes)

// Rewards
const rewardsRoutes = require('./routes/rewards')
app.use('/api/rewards', rewardsRoutes)

// Referrals
const referralsRoutes = require('./routes/referrals')
app.use('/api/referrals', referralsRoutes)

// Admin — stricter limiter
const adminRoutes = require('./routes/admin')
app.use('/api/admin', adminLimiter)
app.use('/api/admin', adminRoutes)

// ═══════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ message: 'Zowpay Backend is running!' })
})

// ═══════════════════════════════════════
// GLOBAL ERROR HANDLER
// ═══════════════════════════════════════
app.use((err, req, res, next) => {
  console.error('Server error:', err.message)

  // CORS error
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Access denied' })
  }

  // Don't expose internal errors to users
  res.status(500).json({
    error: 'Something went wrong. Please try again.'
  })
})

// ═══════════════════════════════════════
// 404 HANDLER
// ═══════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Zowpay server running on port ${PORT}`)
})