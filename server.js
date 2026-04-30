const express = require('express')
const cors = require('cors')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json())

// Routes
const authRoutes = require('./routes/auth')
app.use('/api/auth', authRoutes)

const walletRoutes = require('./routes/wallet')
app.use('/api/wallet', walletRoutes)

const paystackRoutes = require('./routes/paystack')
app.use('/api/paystack', paystackRoutes)

const billsRoutes = require('./routes/bills')
app.use('/api/bills', billsRoutes)

const missionsRoutes = require('./routes/missions')
app.use('/api/missions', missionsRoutes)

const merchantsRoutes = require('./routes/merchants')
app.use('/api/merchants', merchantsRoutes)
const rewardsRoutes = require('./routes/rewards')
app.use('/api/rewards', rewardsRoutes)
// Test route
app.get('/', (req, res) => {
  res.json({ message: 'Zowpay Backend is running!' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Zowpay server running on port ${PORT}`)
})