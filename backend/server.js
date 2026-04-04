const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = '8358311702';

app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const defaultDB = {
            users: [],
            messages: [{ id: '1', username: 'System', message: 'Selamat datang di Nexus', userId: 'system', time: new Date().toISOString() }],
            activities: []
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB, null, 2));
        return defaultDB;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
}

// ============ AUTH ============
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Semua field wajib diisi' });
    }
    const db = loadDB();
    if (db.users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'Email sudah terdaftar' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: Date.now().toString(),
        username,
        email,
        password: hashedPassword,
        plan: 'free',
        apiKey: 'nx_' + Math.random().toString(36).substring(2, 30),
        totalRequests: 0,
        joinedAt: new Date().toISOString(),
        planExpiry: null
    };
    db.users.push(newUser);
    saveDB(db);
    const token = jwt.sign({ userId: newUser.id, email: newUser.email }, SECRET_KEY, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: newUser.id, username, email, plan: 'free', apiKey: newUser.apiKey, totalRequests: 0, joinedAt: newUser.joinedAt } });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.email === email || u.username === email);
    if (!user) return res.status(401).json({ error: 'User tidak ditemukan' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Password salah' });
    const token = jwt.sign({ userId: user.id, email: user.email }, SECRET_KEY, { expiresIn: '7d' });
    res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, plan: user.plan, apiKey: user.apiKey, totalRequests: user.totalRequests, joinedAt: user.joinedAt, planExpiry: user.planExpiry } });
});

app.get('/api/auth/me', verifyToken, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
    res.json({ id: user.id, username: user.username, email: user.email, plan: user.plan, apiKey: user.apiKey, totalRequests: user.totalRequests, joinedAt: user.joinedAt, planExpiry: user.planExpiry });
});

// ============ API KEYS ============
app.get('/api/keys', verifyToken, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.userId);
    const keys = user.apiKeys || [];
    res.json({ keys });
});

app.post('/api/keys', verifyToken, (req, res) => {
    const { name } = req.body;
    const db = loadDB();
    const userIndex = db.users.findIndex(u => u.id === req.userId);
    const newKey = {
        id: Date.now().toString(),
        name,
        key: 'nx_' + Math.random().toString(36).substring(2, 42),
        created: new Date().toISOString(),
        active: true
    };
    if (!db.users[userIndex].apiKeys) db.users[userIndex].apiKeys = [];
    db.users[userIndex].apiKeys.push(newKey);
    saveDB(db);
    res.json({ success: true, key: newKey });
});

app.delete('/api/keys/:id', verifyToken, (req, res) => {
    const db = loadDB();
    const userIndex = db.users.findIndex(u => u.id === req.userId);
    db.users[userIndex].apiKeys = (db.users[userIndex].apiKeys || []).filter(k => k.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

// ============ CHAT ============
app.get('/api/chat/messages', (req, res) => {
    const db = loadDB();
    res.json({ messages: db.messages.slice(-50).reverse() });
});

app.post('/api/chat/messages', verifyToken, (req, res) => {
    const { message } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === req.userId);
    if (!message) return res.status(400).json({ error: 'Pesan kosong' });
    const newMessage = {
        id: Date.now().toString(),
        username: user.username,
        message,
        userId: user.id,
        time: new Date().toISOString()
    };
    db.messages.push(newMessage);
    if (db.messages.length > 200) db.messages.shift();
    saveDB(db);
    res.json({ success: true, message: newMessage });
});

// ============ LEADERBOARD ============
app.get('/api/leaderboard', (req, res) => {
    const db = loadDB();
    const leaderboard = [...db.users]
        .sort((a, b) => (b.totalRequests || 0) - (a.totalRequests || 0))
        .slice(0, 20)
        .map(u => ({ username: u.username, totalRequests: u.totalRequests || 0, plan: u.plan }));
    res.json({ leaderboard });
});

// ============ PROFILE ============
app.put('/api/user/profile', verifyToken, (req, res) => {
    const { username } = req.body;
    const db = loadDB();
    const userIndex = db.users.findIndex(u => u.id === req.userId);
    if (userIndex === -1) return res.status(404).json({ error: 'User tidak ditemukan' });
    if (username) db.users[userIndex].username = username;
    saveDB(db);
    res.json({ success: true, user: db.users[userIndex] });
});

// ============ UPGRADE PLAN ============
app.post('/api/upgrade', verifyToken, (req, res) => {
    const { plan } = req.body;
    const db = loadDB();
    const userIndex = db.users.findIndex(u => u.id === req.userId);
    const plans = { starter: 3, pro: 7, enterprise: 30 };
    if (!plans[plan]) return res.status(400).json({ error: 'Plan tidak valid' });
    db.users[userIndex].plan = plan;
    db.users[userIndex].planExpiry = new Date(Date.now() + plans[plan] * 86400000).toISOString();
    saveDB(db);
    res.json({ success: true, plan, planExpiry: db.users[userIndex].planExpiry });
});

// ============ TRACK REQUEST ============
app.post('/api/track', verifyToken, (req, res) => {
    const db = loadDB();
    const userIndex = db.users.findIndex(u => u.id === req.userId);
    if (userIndex !== -1) {
        db.users[userIndex].totalRequests = (db.users[userIndex].totalRequests || 0) + 1;
        saveDB(db);
    }
    res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Nexus Backend on http://localhost:${PORT}`);
    console.log(`📡 ready!`);
});
