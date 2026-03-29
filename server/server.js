const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 10mb for base64 images
app.use(express.static(path.join(__dirname, '../client')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'vocabflow-secret-change-me';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';
const DATA_FILE = path.join(__dirname, 'data.json');

// ── In-memory DB (persisted to JSON file) ────────────────────────────────────
let db = { users: [], pools: [], progress: [], shares: [] };
if (fs.existsSync(DATA_FILE)) {
  try { db = { users:[], pools:[], progress:[], shares:[], ...JSON.parse(fs.readFileSync(DATA_FILE,'utf8')) }; }
  catch(e) { console.error('DB load error:', e.message); }
}
const saveDb = () => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch(e) { console.error('DB save error:', e.message); }
};

// ── Auth middleware ───────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Nicht autorisiert' });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Token ungültig oder abgelaufen' }); }
};

// ── Health check (used by frontend to detect server) ─────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '2.0', nvidia: !!NVIDIA_API_KEY });
});

// ── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Alle Felder erforderlich' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Passwort mindestens 6 Zeichen' });
  if (db.users.find(u => u.email === email.toLowerCase()))
    return res.status(409).json({ error: 'E-Mail bereits registriert' });
  if (db.users.find(u => u.username === username))
    return res.status(409).json({ error: 'Nutzername bereits vergeben' });
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = { id: Date.now(), username: username.trim(), email: email.trim().toLowerCase(), password: hashedPassword, createdAt: new Date().toISOString() };
  db.users.push(newUser);
  saveDb();
  const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: newUser.id, username: newUser.username, email: newUser.email } });
});

app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password)
    return res.status(400).json({ error: 'Login und Passwort erforderlich' });
  const user = db.users.find(u => u.email === login.toLowerCase() || u.username === login);
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: 'Falsche Zugangsdaten' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
});

// /api/me — session check (needed by frontend)
app.get('/api/me', auth, (req, res) => {
  const user = db.users.find(u => u.id === req.user.userId);
  if (!user) return res.status(404).json({ error: 'Nutzer nicht gefunden' });
  res.json({ user: { id: user.id, username: user.username, email: user.email } });
});

// ── POOLS ─────────────────────────────────────────────────────────────────────
app.get('/api/pools', auth, (req, res) => {
  const userPools = db.pools.filter(p => p.userId === req.user.userId);
  res.json(userPools); // returns array directly (compatible with both server versions)
});

app.put('/api/pools/:id', auth, (req, res) => {
  const { lang, name, data } = req.body || {};
  if (!lang || !name) return res.status(400).json({ error: 'lang und name erforderlich' });
  const poolData = { id: req.params.id, userId: req.user.userId, lang, name, data: data || {}, updatedAt: new Date().toISOString() };
  const idx = db.pools.findIndex(p => p.id === req.params.id && p.userId === req.user.userId);
  if (idx > -1) db.pools[idx] = poolData;
  else db.pools.push(poolData);
  saveDb();
  res.json({ success: true });
});

app.delete('/api/pools/:id', auth, (req, res) => {
  db.pools = db.pools.filter(p => !(p.id === req.params.id && p.userId === req.user.userId));
  saveDb();
  res.json({ success: true });
});

// ── SHARE ─────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

app.post('/api/pools/:id/share', auth, (req, res) => {
  const pool = db.pools.find(p => p.id === req.params.id && p.userId === req.user.userId);
  if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });
  let share = db.shares.find(s => s.poolId === req.params.id);
  if (!share) {
    share = { token: crypto.randomBytes(8).toString('hex'), poolId: req.params.id, userId: req.user.userId, createdAt: new Date().toISOString() };
    db.shares.push(share);
    saveDb();
  }
  const url = `${req.protocol}://${req.get('host')}/share/${share.token}`;
  res.json({ token: share.token, url });
});

app.delete('/api/pools/:id/share', auth, (req, res) => {
  db.shares = db.shares.filter(s => !(s.poolId === req.params.id && s.userId === req.user.userId));
  saveDb();
  res.json({ success: true });
});

app.get('/api/share/:token', (req, res) => {
  const share = db.shares.find(s => s.token === req.params.token);
  if (!share) return res.status(404).json({ error: 'Link ungültig oder abgelaufen' });
  const pool = db.pools.find(p => p.id === share.poolId);
  if (!pool) return res.status(404).json({ error: 'Pool nicht mehr vorhanden' });
  const owner = db.users.find(u => u.id === share.userId);
  res.json({ pool: { ...pool, username: owner ? owner.username : 'unbekannt' } });
});

// ── PROGRESS ─────────────────────────────────────────────────────────────────
app.get('/api/progress', auth, (req, res) => {
  const prog = db.progress.find(p => p.userId === req.user.userId);
  // Return in format frontend expects: {progress: {poolKey: [knownIds]}}
  res.json({ progress: prog ? prog.data : {} });
});

app.put('/api/progress/:poolId', auth, (req, res) => {
  const { known } = req.body || {};
  let prog = db.progress.find(p => p.userId === req.user.userId);
  if (!prog) { prog = { userId: req.user.userId, data: {} }; db.progress.push(prog); }
  prog.data[decodeURIComponent(req.params.poolId)] = Array.isArray(known) ? known : [];
  saveDb();
  res.json({ success: true });
});

// ── AI SCAN (key stays server-side!) ─────────────────────────────────────────
// Rate limiting: max 20 scans per user per day
const scanUsage = {};
function checkScanLimit(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${userId}:${today}`;
  scanUsage[key] = (scanUsage[key] || 0) + 1;
  return scanUsage[key] <= 20;
}

app.post('/api/scan', auth, async (req, res) => {
  if (!NVIDIA_API_KEY)
    return res.status(503).json({ error: 'Foto-Import nicht konfiguriert (kein NVIDIA_API_KEY)' });
  if (!checkScanLimit(req.user.userId))
    return res.status(429).json({ error: 'Tageslimit erreicht (20 Scans/Tag)' });

  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'Kein Bild' });

  const prompt = `Du bist ein Vokabelextraktions-Assistent. Analysiere dieses Bild und extrahiere ALLE Vokabelpaare.

Gib NUR die Vokabelpaare aus, ein Paar pro Zeile, im Format:
Deutsches Wort = Englische Übersetzung

Keine Erklärungen, keine Nummerierung, nur die Paare.`;

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${NVIDIA_API_KEY}` },
      body: JSON.stringify({
        model: 'meta/llama-3.2-11b-vision-instruct',
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` } }
        ]}],
        max_tokens: 1024,
        temperature: 0.1
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.message || 'NVIDIA API Fehler' });
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    res.json({ text, pairs: text.split('\n').filter(l => l.includes('=') && l.trim()).length });
  } catch(e) {
    console.error('Scan error:', e);
    res.status(500).json({ error: 'Scan fehlgeschlagen: ' + e.message });
  }
});

// ── Share page + SPA fallback ─────────────────────────────────────────────────
app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ VocabFlow Server läuft auf Port ${PORT}`);
  console.log(`🔑 NVIDIA Key: ${NVIDIA_API_KEY ? 'gesetzt ✓' : 'nicht gesetzt (Foto-Import deaktiviert)'}`);
});
