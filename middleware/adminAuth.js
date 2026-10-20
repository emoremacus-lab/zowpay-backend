// middleware/adminAuth.js
// Admin login (password -> short-lived JWT), route protection and audit trail.
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const rateLimit = require('express-rate-limit')
const pool = require('../db')

const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET
const TOKEN_TTL = '8h'

// Create the audit table once (safe to run on every start)
const ensureAuditTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        method VARCHAR(10),
        path TEXT,
        details JSONB,
        ip TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`)
  } catch (err) {
    console.error('Audit table error:', err.message)
  }
}
ensureAuditTable()

// Max 5 password attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Try again in 15 minutes.' }
})

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

const adminLogin = (req, res) => {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected || !ADMIN_SECRET) {
    console.error('ADMIN_PASSWORD or JWT secret is not set')
    return res.status(500).json({ success: false, error: 'Admin login is not configured' })
  }
  const { password } = req.body || {}
  if (!password || !safeEqual(password, expected)) {
    pool.query(
      'INSERT INTO admin_audit_log (method, path, details, ip) VALUES ($1,$2,$3,$4)',
      ['POST', '/login', JSON.stringify({ result: 'failed' }), req.ip]
    ).catch(() => {})
    return res.status(401).json({ success: false, error: 'Incorrect password' })
  }
  const token = jwt.sign({ role: 'admin' }, ADMIN_SECRET, { expiresIn: TOKEN_TTL })
  pool.query(
    'INSERT INTO admin_audit_log (method, path, details, ip) VALUES ($1,$2,$3,$4)',
    ['POST', '/login', JSON.stringify({ result: 'success' }), req.ip]
  ).catch(() => {})
  res.json({ success: true, token })
}

const requireAdmin = (req, res, next) => {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ success: false, error: 'Admin login required' })
  try {
    const payload = jwt.verify(token, ADMIN_SECRET)
    if (payload.role !== 'admin') throw new Error('not admin')
    req.admin = payload
    next()
  } catch {
    res.status(401).json({ success: false, error: 'Session expired. Sign in again.' })
  }
}

// Logs every successful change (POST/PUT/DELETE) made through the admin API
const auditLogger = (req, res, next) => {
  if (req.method === 'GET') return next()
  res.on('finish', () => {
    if (res.statusCode >= 400) return
    const body = { ...(req.body || {}) }
    ;['password', 'pin', 'token'].forEach(k => delete body[k])
    pool.query(
      'INSERT INTO admin_audit_log (method, path, details, ip) VALUES ($1,$2,$3,$4)',
      [req.method, req.originalUrl, JSON.stringify(body), req.ip]
    ).catch(err => console.error('Audit log error:', err.message))
  })
  next()
}

module.exports = { adminLogin, loginLimiter, requireAdmin, auditLogger }