// Login passes (tokens) for customers and merchants.
// Admin has its own protection in middleware/adminAuth.js.
const jwt = require('jsonwebtoken')

const TOKEN_LIFETIME = '30d'

// Create a pass for a user. Returns null (and logs) if the secret is not set,
// so login keeps working while the secret is being added.
function signUserToken(user) {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32) {
    console.error('JWT_SECRET is missing or too short: login passes are disabled')
    return null
  }
  return jwt.sign({ uid: user.id }, secret, {
    algorithm: 'HS256',
    expiresIn: TOKEN_LIFETIME
  })
}

// Read the user id from the "Authorization: Bearer <pass>" header.
// Returns null when there is no valid pass.
function readUserId(req) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return null
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET, {
      algorithms: ['HS256']
    })
    return payload.uid || null
  } catch (err) {
    return null
  }
}

// Attaches req.userId when a valid pass is present, never blocks.
// Used while we move routes over one by one.
function optionalUser(req, res, next) {
  req.userId = readUserId(req)
  next()
}

// Blocks the request unless a valid pass is present.
function requireUser(req, res, next) {
  const id = readUserId(req)
  if (!id) {
    return res.status(401).json({
      error: 'Please sign in again',
      code: 'AUTH_REQUIRED'
    })
  }
  req.userId = id
  next()
}

module.exports = { signUserToken, optionalUser, requireUser }