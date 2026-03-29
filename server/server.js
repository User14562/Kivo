const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-geheim';
const DATA_FILE = path.join(__dirname, 'data.json');

// Datenbank-Dummy (In-Memory oder lokale Datei)
let db = { users: [], pools: [], progress: [] };
if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE));
}

const saveDb = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

// --- AUTH API ---
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'User existiert bereits' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = { id: Date.now(), username, email, password: hashedPassword };
    db.users.push(newUser);
    saveDb();
    
    const token = jwt.sign({ userId: newUser.id }, JWT_SECRET);
    res.json({ token, user: { username, email } });
});

app.post('/api/login', async (req, res) => {
    const { login, password } = req.body;
    const user = db.users.find(u => u.email === login || u.username === login);
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Falsche Zugangsdaten' });
    }
    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    res.json({ token, user: { username: user.username, email: user.email } });
});

// --- POOLS & PROGRESS ---
const auth = (req, res, next) => {
    try {
        const token = req.headers.authorization.split(' ')[1];
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch { res.status(401).json({ error: 'Nicht autorisiert' }); }
};

app.get('/api/pools', auth, (req, res) => {
    const userPools = db.pools.filter(p => p.userId === req.user.userId);
    res.json(userPools);
});

app.put('/api/pools/:id', auth, (req, res) => {
    const index = db.pools.findIndex(p => p.id === req.params.id && p.userId === req.user.userId);
    const poolData = { ...req.body, userId: req.user.userId, id: req.params.id };
    if (index > -1) db.pools[index] = poolData;
    else db.pools.push(poolData);
    saveDb();
    res.json({ success: true });
});

app.get('/api/progress', auth, (req, res) => {
    const prog = db.progress.find(p => p.userId === req.user.userId);
    res.json(prog ? prog.data : {});
});

app.put('/api/progress/:poolId', auth, (req, res) => {
    let prog = db.progress.find(p => p.userId === req.user.userId);
    if (!prog) {
        prog = { userId: req.user.userId, data: {} };
        db.progress.push(prog);
    }
    prog.data[req.params.poolId] = req.body;
    saveDb();
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));