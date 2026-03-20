/**
 * FreshLogic AI — Backend Server
 * Run: npm install && node server.js
 * Default port: 3001
 */
const express = require('express');
const cors    = require('cors');
const { v4: uuid } = require('uuid');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'freshlogic-secret-change-in-prod';

app.use(cors());
app.use(express.json());

// ─── IN-MEMORY DB (swap with MongoDB/PostgreSQL in production) ────────────────
const db = {
  orders:  [],
  members: [],
  admins:  [{
    id: 'admin-1', name: 'FreshLogic Admin',
    email: 'admin@freshlogic.ai',
    passwordHash: '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', // admin123
    role: 'superadmin'
  }]
};

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function authRequired(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { req.admin = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ─── PUBLIC: PLACE ORDER ─────────────────────────────────────────────────────
app.post('/api/order', (req, res) => {
  const { name, businessName, email, phone, address, city, state, pincode,
          gst, plan, planPrice, currency, paymentMethod, autopay } = req.body;
  if (!name || !email || !phone || !plan)
    return res.status(400).json({ error: 'name, email, phone and plan are required' });

  const orderId = 'FL-' + Date.now().toString(36).toUpperCase();
  const trialEnd = new Date(Date.now() + 30 * 864e5).toISOString();

  const order = {
    id: orderId, uid: uuid(),
    name, businessName, email, phone,
    address: { line: address, city, state, pincode },
    gst: gst || null,
    membership:   { fee: 100, currency: 'INR', trialDays: 30, trialEnds: trialEnd },
    subscription: { plan, priceINR: planPrice, currency: currency || 'INR',
                    billingCycle: '3 months per kitchen', autopay: !!autopay,
                    status: 'trial', nextBillingDate: trialEnd },
    payment: { method: paymentMethod || 'UPI', membershipPaid: true,
               membershipAmount: 100, paidAt: new Date().toISOString() },
    status: 'confirmed',
    adminNotes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.orders.push(order);

  let member = db.members.find(m => m.email === email);
  if (!member) {
    member = { id: uuid(), name, email, phone, businessName,
               orders: [], joinedAt: new Date().toISOString() };
    db.members.push(member);
  }
  member.orders.push(orderId);

  console.log(`[ORDER] ${orderId} — ${name} <${email}> — ${plan}`);
  return res.status(201).json({
    success: true, orderId,
    message: 'Order confirmed! Your 30-day free trial starts today.',
    trialEnds: trialEnd
  });
});

// ─── PUBLIC: TRACK ORDER ─────────────────────────────────────────────────────
app.get('/api/order/:id', (req, res) => {
  const o = db.orders.find(o => o.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  return res.json({ id: o.id, name: o.name, plan: o.subscription.plan,
                    status: o.status, trialEnds: o.membership.trialEnds });
});

// ─── PUBLIC: MEMBERSHIP SIGNUP ───────────────────────────────────────────────
app.post('/api/membership', (req, res) => {
  const { name, email, phone, businessName } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  if (db.members.find(m => m.email === email))
    return res.status(409).json({ error: 'Email already registered' });
  const member = { id: 'MEM-' + Date.now().toString(36).toUpperCase(),
                   name, email, phone, businessName, orders: [],
                   trialEnds: new Date(Date.now() + 30 * 864e5).toISOString(),
                   joinedAt: new Date().toISOString() };
  db.members.push(member);
  return res.status(201).json({ success: true, memberId: member.id });
});

// ─── ADMIN: LOGIN ─────────────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  const admin = db.admins.find(a => a.email === req.body.email);
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(req.body.password, admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: admin.id, name: admin.name, email: admin.email, role: admin.role },
                         JWT_SECRET, { expiresIn: '8h' });
  return res.json({ success: true, token, admin: { name: admin.name, email: admin.email } });
});

// ─── ADMIN: DASHBOARD STATS ───────────────────────────────────────────────────
app.get('/api/admin/dashboard', authRequired, (req, res) => {
  const planBreakdown = {};
  db.orders.forEach(o => { planBreakdown[o.subscription.plan] = (planBreakdown[o.subscription.plan]||0)+1; });
  return res.json({
    stats: {
      totalOrders: db.orders.length,
      totalMembers: db.members.length,
      totalRevenue: db.orders.reduce((s,o) => s + (o.payment.membershipAmount||0), 0),
      activeTrial: db.orders.filter(o => o.status === 'confirmed').length,
      cancelled: db.orders.filter(o => o.status === 'cancelled').length
    },
    planBreakdown,
    recentOrders: [...db.orders].reverse().slice(0,8).map(o => ({
      id: o.id, name: o.name, businessName: o.businessName,
      plan: o.subscription.plan, status: o.status, createdAt: o.createdAt
    }))
  });
});

// ─── ADMIN: ORDERS CRUD ───────────────────────────────────────────────────────
app.get('/api/admin/orders', authRequired, (req, res) => {
  let orders = [...db.orders].reverse();
  const { status, plan, search } = req.query;
  if (status) orders = orders.filter(o => o.status === status);
  if (plan)   orders = orders.filter(o => o.subscription.plan === plan);
  if (search) { const q = search.toLowerCase();
    orders = orders.filter(o => o.name.toLowerCase().includes(q) ||
      o.email.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)); }
  return res.json({ total: orders.length, orders });
});

app.get('/api/admin/orders/:id',  authRequired, (req, res) => {
  const o = db.orders.find(o => o.id === req.params.id);
  return o ? res.json(o) : res.status(404).json({ error: 'Not found' });
});

app.patch('/api/admin/orders/:id', authRequired, (req, res) => {
  const o = db.orders.find(o => o.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  const { status, adminNotes } = req.body;
  if (status)     o.status = status;
  if (adminNotes !== undefined) o.adminNotes = adminNotes;
  o.updatedAt = new Date().toISOString();
  return res.json({ success: true, order: o });
});

app.delete('/api/admin/orders/:id', authRequired, (req, res) => {
  const o = db.orders.find(o => o.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  o.status = 'cancelled'; o.updatedAt = new Date().toISOString();
  return res.json({ success: true });
});

// ─── ADMIN: MEMBERS ───────────────────────────────────────────────────────────
app.get('/api/admin/members', authRequired, (req, res) => {
  return res.json({ total: db.members.length, members: [...db.members].reverse() });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'FreshLogic AI Backend' }));

app.listen(PORT, () => {
  console.log(`\n🌿 FreshLogic AI Backend → http://localhost:${PORT}`);
  console.log(`   Admin: admin@freshlogic.ai / admin123\n`);
});
