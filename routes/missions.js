const express = require('express')
const router = express.Router()
const pool = require('../db')
const multer = require('multer')
const { approveCompletion } = require('./merchants')
const { onlySelf } = require('../middleware/userAuth')

// Multer setup — store in memory, max 5MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
})

// Get all active missions
router.get('/all', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.full_name as merchant_name, u.phone as merchant_phone
       FROM missions m
       LEFT JOIN users u ON m.merchant_id = u.id
       WHERE m.status = 'active'
       ORDER BY m.created_at DESC`
    )
    res.json({ success: true, missions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get mission by ID
router.get('/:id', async (req, res) => {
  const { id } = req.params
  try {
    const result = await pool.query(
      `SELECT m.*, u.full_name as merchant_name, u.phone as merchant_phone
       FROM missions m
       LEFT JOIN users u ON m.merchant_id = u.id
       WHERE m.id = $1`,
      [id]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Mission not found' })
    }
    res.json({ success: true, mission: result.rows[0] })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get missions by category
router.get('/category/:cat', async (req, res) => {
  const { cat } = req.params
  try {
    const result = await pool.query(
      `SELECT m.*, u.full_name as merchant_name
       FROM missions m
       LEFT JOIN users u ON m.merchant_id = u.id
       WHERE m.category = $1 AND m.status = 'active'
       ORDER BY m.created_at DESC`,
      [cat]
    )
    res.json({ success: true, missions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Submit mission proof — fixed to handle FormData + file upload
router.post('/submit', upload.single('proof_file'), async (req, res) => {
  // The user comes from the login pass, never from the request body
  const { mission_id, proof_text } = req.body
  const user_id = req.userId
  try {
    if (!mission_id || !user_id) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Check if already submitted
    const existing = await pool.query(
      'SELECT * FROM mission_completions WHERE mission_id=$1 AND user_id=$2',
      [mission_id, user_id]
    )
    if (existing.rows.length > 0) {
      return res.status(400).json({
        error: 'You have already submitted proof for this mission'
      })
    }

    // Get mission details
    const mission = await pool.query(
      'SELECT * FROM missions WHERE id=$1', [mission_id]
    )
    if (mission.rows.length === 0) {
      return res.status(404).json({ error: 'Mission not found' })
    }
    if (String(mission.rows[0].merchant_id) === String(user_id)) {
      return res.status(400).json({ error: 'You cannot complete your own campaign' })
    }
    if (mission.rows[0].status !== 'active') {
      return res.status(400).json({ error: 'This campaign is not open' })
    }
    // Pending and approved submissions both use up a place; rejected ones free it
    const taken = await pool.query(
      `SELECT COUNT(*) FROM mission_completions
       WHERE mission_id=$1 AND status IN ('pending','approved')`,
      [mission_id]
    )
    if (Number(taken.rows[0].count) >= Number(mission.rows[0].max_participants)) {
      return res.status(400).json({ error: 'This campaign is full' })
    }

    // Handle file if uploaded — convert to base64
    let proof_url = null
    if (req.file) {
      // Only pictures are accepted as proof
      if (!req.file.mimetype.startsWith('image/') || req.file.mimetype.includes('svg')) {
        return res.status(400).json({ error: 'Please upload a photo or screenshot' })
      }
      const base64 = req.file.buffer.toString('base64')
      const mimeType = req.file.mimetype
      proof_url = `data:${mimeType};base64,${base64}`
    }

    // Save submission
    await pool.query(
      `INSERT INTO mission_completions
       (mission_id, user_id, proof_text, proof_url, status, submitted_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())`,
      [mission_id, user_id, proof_text || '', proof_url]
    )

    // Update participant count
    await pool.query(
      `UPDATE missions
       SET current_participants = current_participants + 1
       WHERE id=$1`,
      [mission_id]
    )

    res.json({
      success: true,
      message: 'Proof submitted! Waiting for merchant approval.'
    })
  } catch (err) {
    console.error('Submit proof error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Check if user already submitted for a mission
router.get('/check/:mission_id/:user_id', onlySelf('user_id'), async (req, res) => {
  const { mission_id, user_id } = req.params
  try {
    const result = await pool.query(
      `SELECT * FROM mission_completions
       WHERE mission_id=$1 AND user_id=$2`,
      [mission_id, user_id]
    )
    res.json({
      success: true,
      submitted: result.rows.length > 0,
      submission: result.rows[0] || null
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get user's mission submissions
router.get('/user/:user_id', onlySelf('user_id'), async (req, res) => {
  const { user_id } = req.params
  try {
    const result = await pool.query(
      `SELECT mc.*, m.title as mission_title,
       m.reward_points, m.reward_cash
       FROM mission_completions mc
       JOIN missions m ON mc.mission_id = m.id
       WHERE mc.user_id = $1
       ORDER BY mc.submitted_at DESC`,
      [user_id]
    )
    res.json({ success: true, submissions: result.rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Only the merchant who owns the campaign may review its proofs, and nobody
// can review their own submission.
const ownerCheck = async (completion_id, userId) => {
  const found = await pool.query(
    `SELECT mc.user_id, m.merchant_id
     FROM mission_completions mc
     JOIN missions m ON m.id = mc.mission_id
     WHERE mc.id=$1`,
    [completion_id]
  )
  if (found.rows.length === 0) return { status: 404, error: 'Submission not found' }
  const row = found.rows[0]
  if (String(row.merchant_id) !== String(userId)) {
    return { status: 403, error: 'Only the campaign owner can review this' }
  }
  if (String(row.user_id) === String(userId)) {
    return { status: 403, error: 'You cannot review your own submission' }
  }
  return null
}

// Approve mission completion — same safe logic as the merchant route
router.post('/approve', async (req, res) => {
  const { completion_id } = req.body
  try {
    const denied = await ownerCheck(completion_id, req.userId)
    if (denied) return res.status(denied.status).json({ error: denied.error })
    const r = await approveCompletion(completion_id)
    if (r.error) return res.status(400).json({ error: r.error })
    res.json({ success: true, message: 'Mission approved and ZowPoints sent!' })
  } catch (err) {
    console.error('Approve error:', err)
    res.status(500).json({ error: 'Could not approve submission' })
  }
})

// Reject mission completion
router.post('/reject', async (req, res) => {
  const { completion_id } = req.body
  try {
    const denied = await ownerCheck(completion_id, req.userId)
    if (denied) return res.status(denied.status).json({ error: denied.error })
    await pool.query(
      `UPDATE mission_completions
       SET status='rejected', reviewed_at=NOW()
       WHERE id=$1 AND status='pending'`,
      [completion_id]
    )
    res.json({ success: true, message: 'Submission rejected' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// (The old test-data "seed" route was removed: it let anyone create campaigns
// that no merchant had paid for.)

module.exports = router