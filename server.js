const express = require('express');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Database file path
const DB_PATH = './database/nexus.db';
let db;

// Initialize database
async function initDB() {
    const SQL = await initSqlJs();
    let dbData = null;
    
    if (fs.existsSync(DB_PATH)) {
        dbData = fs.readFileSync(DB_PATH);
    }
    
    db = new SQL.Database(dbData);
    
    // Create tables
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        api_key TEXT UNIQUE,
        avatar TEXT DEFAULT 'default.png',
        role TEXT DEFAULT 'free',
        requests_used INTEGER DEFAULT 0,
        requests_limit INTEGER DEFAULT 100,
        referral_code TEXT UNIQUE,
        referred_by TEXT,
        bonus_requests INTEGER DEFAULT 0,
        twofa_secret TEXT,
        twofa_enabled INTEGER DEFAULT 0,
        reset_token TEXT,
        reset_expires TEXT,
        email_verified INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS api_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        endpoint TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS otp_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT,
        otp TEXT,
        expires_at DATETIME
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        order_id TEXT UNIQUE,
        amount INTEGER,
        plan TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        webhook_url TEXT,
        type TEXT DEFAULT 'discord'
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT,
        message TEXT,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Create admin user
    const adminCheck = db.exec(`SELECT * FROM users WHERE username = 'admin'`);
    if (adminCheck.length === 0 || adminCheck[0].values.length === 0) {
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        const apiKey = 'nx_admin_' + Math.random().toString(36).substr(2, 16);
        db.run(`INSERT INTO users (username, email, password, api_key, role, requests_limit, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ['admin', 'admin@nexus.com', hashedPassword, apiKey, 'admin', 999999, 1]);
        console.log('✅ Admin user created: admin / admin123');
    }
    
    saveDB();
}

function saveDB() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

// Email config
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'iciboyyy90@gmail.com',
        pass: 'rristhcufoakvoq'
    }
});

const JWT_SECRET = 'nexus_secret_iciboyyy90_2026';

const storage = multer.diskStorage({
    destination: './uploads/avatars/',
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Helper functions
function getQuery(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
}

function runQuery(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    stmt.free();
    saveDB();
    return db.exec('SELECT last_insert_rowid() as id');
}

// Verify API Key
function verifyApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'API key required' });
    
    const users = getQuery(`SELECT * FROM users WHERE api_key = ?`, [apiKey]);
    if (users.length === 0) return res.status(401).json({ error: 'Invalid API key' });
    
    const user = users[0];
    if (user.expires_at && new Date(user.expires_at) < new Date()) {
        return res.status(403).json({ error: 'Subscription expired' });
    }
    const limit = user.role === 'free' ? user.requests_limit + (user.bonus_requests || 0) : 999999;
    if (user.role === 'free' && user.requests_used >= limit) {
        return res.status(429).json({ error: 'Daily limit exceeded' });
    }
    req.user = user;
    next();
}

// Routes
app.post('/api/register', async (req, res) => {
    const { username, email, password, referralCode } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields required' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const apiKey = 'nx_' + uuidv4().replace(/-/g, '');
    const referralCodeGen = username + Math.random().toString(36).substr(2, 6);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    let referredBy = null;
    let bonusRequests = 0;

    if (referralCode && referralCode !== '') {
        const referrers = getQuery(`SELECT id, username FROM users WHERE referral_code = ?`, [referralCode]);
        if (referrers.length > 0) {
            referredBy = referrers[0].username;
            bonusRequests = 50;
            runQuery(`UPDATE users SET bonus_requests = bonus_requests + 50, requests_limit = requests_limit + 50 WHERE username = ?`, [referrers[0].username]);
        }
    }

    try {
        runQuery(`INSERT INTO users (username, email, password, api_key, referral_code, referred_by, bonus_requests, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [username, email, hashedPassword, apiKey, referralCodeGen, referredBy, bonusRequests, expiresAt.toISOString()]);
        
        const users = getQuery(`SELECT id FROM users WHERE username = ?`, [username]);
        const token = jwt.sign({ id: users[0].id, username }, JWT_SECRET);
        res.json({ token, apiKey, username, referralCode: referralCodeGen });
    } catch(e) {
        res.status(400).json({ error: 'Username or email exists' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password, twofaCode } = req.body;
    
    const users = getQuery(`SELECT * FROM users WHERE username = ?`, [username]);
    if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    
    const user = users[0];
    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    
    if (user.twofa_enabled) {
        if (!twofaCode) return res.status(401).json({ error: '2FA code required', twofa_required: true });
        const verified = speakeasy.totp.verify({ secret: user.twofa_secret, encoding: 'base32', token: twofaCode });
        if (!verified) return res.status(401).json({ error: 'Invalid 2FA code' });
    }
    
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, apiKey: user.api_key, username: user.username, role: user.role });
});

app.post('/api/enable-2fa', verifyApiKey, (req, res) => {
    const secret = speakeasy.generateSecret({ length: 20, name: `NexusAPI:${req.user.username}` });
    qrcode.toDataURL(secret.otpauth_url, (err, qrCode) => {
        runQuery(`UPDATE users SET twofa_secret = ? WHERE api_key = ?`, [secret.base32, req.user.api_key]);
        res.json({ secret: secret.base32, qrCode });
    });
});

app.post('/api/verify-2fa', verifyApiKey, (req, res) => {
    const { code } = req.body;
    const verified = speakeasy.totp.verify({ secret: req.user.twofa_secret, encoding: 'base32', token: code, window: 1 });
    if (verified) {
        runQuery(`UPDATE users SET twofa_enabled = 1 WHERE api_key = ?`, [req.user.api_key]);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Invalid code' });
    }
});

app.post('/api/send-otp', async (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    runQuery(`INSERT INTO otp_codes (email, otp, expires_at) VALUES (?, ?, datetime('now', '+5 minutes'))`, [email, otp]);
    
    try {
        await transporter.sendMail({
            from: 'Nexus API <iciboyyy90@gmail.com>',
            to: email,
            subject: 'Verifikasi Email Nexus API',
            html: `<h3>Kode OTP Anda: <b>${otp}</b></h3><p>Berlaku 5 menit.</p>`
        });
        res.json({ message: 'OTP sent!' });
    } catch(e) {
        res.status(500).json({ error: 'Failed to send email' });
    }
});

app.post('/api/verify-email', (req, res) => {
    const { email, otp } = req.body;
    const codes = getQuery(`SELECT * FROM otp_codes WHERE email = ? AND otp = ? AND expires_at > datetime('now')`, [email, otp]);
    if (codes.length === 0) return res.status(400).json({ error: 'Invalid OTP' });
    runQuery(`UPDATE users SET email_verified = 1 WHERE email = ?`, [email]);
    res.json({ success: true });
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    const resetToken = uuidv4();
    runQuery(`UPDATE users SET reset_token = ?, reset_expires = datetime('now', '+1 hour') WHERE email = ?`, [resetToken, email]);
    
    try {
        await transporter.sendMail({
            from: 'Nexus API <iciboyyy90@gmail.com>',
            to: email,
            subject: 'Reset Password Nexus API',
            html: `<h3>Reset Password</h3><a href="http://localhost:3000/reset-password?token=${resetToken}">Klik disini</a><p>Berlaku 1 jam.</p>`
        });
        res.json({ message: 'Reset link sent!' });
    } catch(e) {
        res.status(500).json({ error: 'Failed to send email' });
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    const users = getQuery(`SELECT * FROM users WHERE reset_token = ? AND reset_expires > datetime('now')`, [token]);
    if (users.length === 0) return res.status(400).json({ error: 'Invalid token' });
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    runQuery(`UPDATE users SET password = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?`, [hashedPassword, users[0].id]);
    res.json({ success: true });
});

app.get('/api/referral-info', verifyApiKey, (req, res) => {
    const data = getQuery(`SELECT referral_code, bonus_requests FROM users WHERE api_key = ?`, [req.user.api_key]);
    res.json({ referralCode: data[0]?.referral_code, bonusRequests: data[0]?.bonus_requests || 0 });
});

app.post('/api/set-webhook', verifyApiKey, (req, res) => {
    const { webhookUrl, type } = req.body;
    const users = getQuery(`SELECT id FROM users WHERE api_key = ?`, [req.user.api_key]);
    runQuery(`INSERT OR REPLACE INTO webhooks (user_id, webhook_url, type) VALUES (?, ?, ?)`, [users[0].id, webhookUrl, type]);
    res.json({ success: true });
});

app.get('/api/export-requests', verifyApiKey, (req, res) => {
    const logs = getQuery(`SELECT endpoint, timestamp FROM api_logs WHERE api_key = ? ORDER BY timestamp DESC LIMIT 1000`, [req.user.api_key]);
    let csv = 'Endpoint,Timestamp\n';
    logs.forEach(log => csv += `"${log.endpoint}","${log.timestamp}"\n`);
    res.header('Content-Type', 'text/csv');
    res.attachment(`nexus_requests_${Date.now()}.csv`);
    res.send(csv);
});

app.get('/api/profile', verifyApiKey, (req, res) => {
    const limit = req.user.role === 'free' ? req.user.requests_limit + (req.user.bonus_requests || 0) : 'unlimited';
    res.json({
        username: req.user.username,
        email: req.user.email,
        api_key: req.user.api_key,
        avatar: req.user.avatar,
        role: req.user.role,
        requests_used: req.user.requests_used,
        requests_limit: limit,
        created_at: req.user.created_at,
        expires_at: req.user.expires_at
    });
});

app.post('/api/upload-avatar', verifyApiKey, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    runQuery(`UPDATE users SET avatar = ? WHERE api_key = ?`, [req.file.filename, req.user.api_key]);
    res.json({ avatar: req.file.filename });
});

app.post('/api/upgrade', verifyApiKey, (req, res) => {
    const { plan } = req.body;
    let expiresAt = new Date();
    if (plan === 'weekly') expiresAt.setDate(expiresAt.getDate() + 7);
    else if (plan === 'monthly') expiresAt.setMonth(expiresAt.getMonth() + 1);
    else return res.status(400).json({ error: 'Invalid plan' });
    
    runQuery(`UPDATE users SET role = 'premium', requests_limit = 999999, expires_at = ? WHERE api_key = ?`, [expiresAt.toISOString(), req.user.api_key]);
    res.json({ message: `Upgraded to ${plan}! Expires: ${expiresAt.toISOString()}` });
});

app.post('/api/create-payment', verifyApiKey, (req, res) => {
    const { plan } = req.body;
    const amount = plan === 'weekly' ? 10000 : 30000;
    const orderId = 'NX-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
    const users = getQuery(`SELECT id FROM users WHERE api_key = ?`, [req.user.api_key]);
    runQuery(`INSERT INTO transactions (user_id, order_id, amount, plan) VALUES (?, ?, ?, ?)`, [users[0].id, orderId, amount, plan]);
    res.json({ manual: true, message: `Transfer Rp${amount} ke Dana/OVO: 08123456789\nKode: ${orderId}`, orderId });
});

app.get('/api/v1/info', verifyApiKey, (req, res) => {
    runQuery(`INSERT INTO api_logs (api_key, endpoint) VALUES (?, ?)`, [req.user.api_key, '/info']);
    runQuery(`UPDATE users SET requests_used = requests_used + 1 WHERE id = ?`, [req.user.id]);
    const limit = req.user.role === 'free' ? req.user.requests_limit + (req.user.bonus_requests || 0) : 'unlimited';
    res.json({ status: 'online', user: req.user.username, role: req.user.role, requests_used: req.user.requests_used, requests_limit: limit });
});

app.get('/api/v1/leaderboard', (req, res) => {
    const users = getQuery(`SELECT username, requests_used FROM users ORDER BY requests_used DESC LIMIT 10`);
    res.json(users);
});

app.get('/api/admin/users', verifyApiKey, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const users = getQuery(`SELECT id, username, email, role, requests_used, requests_limit FROM users`);
    res.json(users);
});

app.delete('/api/admin/users/:id', verifyApiKey, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    runQuery(`DELETE FROM users WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
});

// Chat
io.on('connection', (socket) => {
    const messages = getQuery(`SELECT username, message, timestamp FROM chat_messages ORDER BY timestamp DESC LIMIT 50`);
    socket.emit('chat history', messages.reverse());
    
    socket.on('chat message', (data) => {
        if (!data.username || !data.message) return;
        runQuery(`INSERT INTO chat_messages (username, message) VALUES (?, ?)`, [data.username, data.message]);
        io.emit('chat message', { ...data, timestamp: new Date().toISOString() });
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
initDB().then(() => {
    const PORT = 3000;
    server.listen(PORT, () => {
        console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚀 NEXUS API ULTIMATE RUNNING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 URL: http://localhost:${PORT}
📊 Dashboard: http://localhost:${PORT}
🔑 Admin: admin / admin123
📧 Email: iciboyyy90@gmail.com (ACTIVE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        `);
    });
});
