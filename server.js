const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'nexus_secret_2024_change_this';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/nexus';
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, Date.now() + '_' + Math.random().toString(36).substr(2, 8) + ext);
    }
});
const upload = multer({
    storage, limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        ok.includes(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(new Error('Only images allowed'));
    }
});

mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(e => console.error('MongoDB error:', e));

const UserSch = new mongoose.Schema({
    username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 30 },
    password: { type: String, required: true },
    photo: { type: String, default: '' },
    joined: { type: Date, default: Date.now },
    lastLogin: { type: Date, default: null }
});
const User = mongoose.model('User', UserSch);

function auth(req, res, next) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    try {
        const d = jwt.verify(h.split(' ')[1], JWT_SECRET);
        req.userId = d.userId;
        next();
    } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Fill all fields' });
        if (username.length < 3) return res.status(400).json({ error: 'Username min 3 chars' });
        if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
        if (await User.findOne({ username: username.toLowerCase() })) return res.status(409).json({ error: 'Username taken' });
        const salt = await bcrypt.genSalt(12);
        const user = await User.create({ username: username.toLowerCase(), password: await bcrypt.hash(password, salt) });
        res.status(201).json({ message: 'Registered', user: { username: user.username, photo: user.photo, joined: user.joined } });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Fill all fields' });
        const user = await User.findOne({ username: username.toLowerCase() });
        if (!user || !await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Wrong credentials' });
        user.lastLogin = Date.now(); await user.save();
        const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ message: 'Logged in', token, user: { username: user.username, photo: user.photo, joined: user.joined, lastLogin: user.lastLogin } });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/auth/verify', auth, async (req, res) => {
    const user = await User.findById(req.userId).select('-password');
    user ? res.json({ valid: true, user }) : res.status(404).json({ error: 'User not found' });
});

app.get('/api/user/profile', auth, async (req, res) => {
    const user = await User.findById(req.userId).select('-password');
    user ? res.json({ user }) : res.status(404).json({ error: 'Not found' });
});

app.put('/api/user/username', auth, async (req, res) => {
    try {
        const { username } = req.body;
        if (!username || username.length < 3) return res.status(400).json({ error: 'Username min 3 chars' });
        if (await User.findOne({ username: username.toLowerCase(), _id: { $ne: req.userId } })) return res.status(409).json({ error: 'Username taken' });
        const user = await User.findByIdAndUpdate(req.userId, { username: username.toLowerCase() }, { new: true }).select('-password');
        res.json({ message: 'Username updated', user });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/user/password', auth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Fill all fields' });
        if (newPassword.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
        const user = await User.findById(req.userId);
        if (!await bcrypt.compare(currentPassword, user.password)) return res.status(401).json({ error: 'Wrong password' });
        user.password = await bcrypt.hash(newPassword, await bcrypt.genSalt(12));
        await user.save();
        res.json({ message: 'Password changed' });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/upload/photo', auth, upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const url = '/uploads/' + req.file.filename;
        const user = await User.findById(req.userId);
        if (user.photo && user.photo.startsWith('/uploads/')) {
            const old = path.join(__dirname, user.photo);
            if (fs.existsSync(old)) fs.unlinkSync(old);
        }
        user.photo = url; await user.save();
        res.json({ message: 'Photo uploaded', photo: url });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return err.code === 'LIMIT_FILE_SIZE' ? res.status(400).json({ error: 'Max 5MB' }) : res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log('Nexus API running on port ' + PORT));
