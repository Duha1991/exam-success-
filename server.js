import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: true, credentials: false }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
});

const PORT = process.env.PORT || 3000;
const PRICES = { normal: 3.5, save: 4.5, super: 5.5 };
const STATUSES = ['جديد', 'تم التواصل', 'قيد التجهيز', 'خرج للتوصيل', 'تم التسليم', 'ملغي'];
const sessions = new Map();

const DEFAULT_CONTENT = {
  hero: { title: 'طريقك إلى النجاح يبدأ من هنا 🎯', desc: 'تدرّب، اختبر نفسك، واعرف مستواك من خلال منصة تعليمية سهلة للطلاب والمعلمين.', button: 'تصفح الامتحانات', buttonLink: '#exams', image: '' },
  sections: [
    { id: 'home', title: 'الرئيسية', description: 'الواجهة الرئيسية للموقع', visible: true },
    { id: 'why', title: 'لماذا امتحان النجاح؟', description: 'أدوات بسيطة تساعدك على الوصول لنتيجة أفضل', visible: true },
    { id: 'exams', title: 'متجر الامتحانات', description: 'اختر الامتحان المناسب واطلبه بسهولة', visible: true },
    { id: 'order-cta', title: 'طريقة الطلب', description: 'خطوات بسيطة لإتمام الطلب', visible: true },
    { id: 'testimonials', title: 'آراء العملاء', description: 'تجارب وآراء العملاء', visible: true },
    { id: 'contact', title: 'تواصل معنا', description: 'واتساب وفيسبوك وتيليجرام', visible: true },
    { id: 'social-codes', title: 'الأكواد الاجتماعية', description: 'QR وروابط التواصل', visible: true },
    { id: 'footer', title: 'الفوتر', description: 'معلومات أسفل الموقع', visible: true },
  ],
  products: [
    { id: 1, title: 'امتحان اللغة الإنجليزية - الصف الثامن', grade: 'الصف الثامن', subject: 'اللغة الإنجليزية', package: 'normal', price: 3.5, desc: 'امتحان جاهز للطباعة · ⭐ 4.9', visible: true },
    { id: 2, title: 'امتحان مراجعة شامل - الصف السابع', grade: 'الصف السابع', subject: 'مراجعة شاملة', package: 'normal', price: 3.5, desc: 'أسئلة مراجعة · ⭐ 4.8', visible: true },
    { id: 3, title: 'امتحان تأسيس اللغة الإنجليزية', grade: 'أخرى', subject: 'اللغة الإنجليزية', package: 'normal', price: 3.5, desc: 'مناسب للمراجعة والتدريب', visible: true },
  ],
  social: { whatsapp: '+962789762287', facebook: 'https://www.facebook.com/share/1BqhuM6bJf/', telegram: 'https://t.me/Success_exam' },
  design: { primary: '#173f78', button: '#168c52', radius: 16 },
  settings: { delivery: 1, normal: 3.5, save: 4.5, super: 5.5, freeNormal: true },
};

function packageKey(value) {
  const k = String(value || '').toLowerCase();
  if (['normal', 'save', 'super'].includes(k)) return k;
  if (k.includes('سوبر') || k.includes('super')) return 'super';
  if (k.includes('توفير') || k.includes('save')) return 'save';
  return 'normal';
}
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function hashPassword(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function safeEqual(a, b) { const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b)); return aa.length === bb.length && crypto.timingSafeEqual(aa, bb); }
async function adminCredentials() {
  const q = await pool.query('SELECT username,password_hash FROM admin_credentials WHERE id=1');
  if (q.rowCount) return { user: q.rows[0].username, hash: q.rows[0].password_hash };
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASSWORD || '1234';
  return { user, hash: hashPassword(pass) };
}
function isAdmin(req) {
  const bearer = String(req.get('authorization') || '');
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
  if (token && sessions.has(token) && sessions.get(token) > Date.now()) return true;
  const expectedKey = String(process.env.ADMIN_API_KEY || '');
  return !!expectedKey && String(req.get('x-admin-key') || '') === expectedKey;
}
function requireAdmin(req, res, next) { if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' }); next(); }

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_content (id INTEGER PRIMARY KEY, content JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS admin_credentials (id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS orders (id BIGSERIAL PRIMARY KEY, order_code TEXT UNIQUE NOT NULL, customer_name TEXT DEFAULT '', phone TEXT NOT NULL, whatsapp TEXT DEFAULT '', backup_phone TEXT DEFAULT '', governorate TEXT DEFAULT '', address TEXT NOT NULL, notes TEXT DEFAULT '', subtotal NUMERIC(10,2) NOT NULL DEFAULT 0, delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 1, discount NUMERIC(10,2) NOT NULL DEFAULT 0, total NUMERIC(10,2) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'جديد', free_normal BOOLEAN NOT NULL DEFAULT FALSE, free_normal_value NUMERIC(10,2) NOT NULL DEFAULT 0, source TEXT DEFAULT 'website', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS order_items (id BIGSERIAL PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, product_id BIGINT, grade TEXT DEFAULT '', subject TEXT DEFAULT '', package_key TEXT NOT NULL, package_name TEXT NOT NULL, unit_price NUMERIC(10,2) NOT NULL, quantity INTEGER NOT NULL DEFAULT 1);
  `);
  const alters = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS backup_phone TEXT DEFAULT ''`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS free_normal BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS free_normal_value NUMERIC(10,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT DEFAULT ''`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'website'`,
  ];
  for (const sql of alters) await pool.query(sql);
  const existing = await pool.query('SELECT id FROM site_content WHERE id=1');
  if (!existing.rowCount) await pool.query('INSERT INTO site_content(id,content) VALUES(1,$1)', [JSON.stringify(DEFAULT_CONTENT)]);
  const admin = await pool.query('SELECT id FROM admin_credentials WHERE id=1');
  if (!admin.rowCount) {
    const user = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASSWORD || '1234';
    await pool.query('INSERT INTO admin_credentials(id,username,password_hash) VALUES(1,$1,$2)', [user, hashPassword(pass)]);
  }
}

app.get('/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'exam-success-api' }); }
  catch { res.status(503).json({ ok: false, error: 'Database unavailable' }); }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const user = String(req.body?.username || '');
    const pass = String(req.body?.password || '');
    const c = await adminCredentials();
    if (user !== c.user || !safeEqual(hashPassword(pass), c.hash)) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    const token = makeToken();
    sessions.set(token, Date.now() + 1000 * 60 * 60 * 12);
    res.json({ ok: true, token });
  } catch (e) { console.error(e); res.status(500).json({ error: 'تعذر تسجيل الدخول' }); }
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 6) return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف أو أرقام على الأقل' });
    const c = await adminCredentials();
    if (!safeEqual(hashPassword(currentPassword), c.hash)) return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
    await pool.query('UPDATE admin_credentials SET password_hash=$1,updated_at=NOW() WHERE id=1', [hashPassword(newPassword)]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'تعذر تغيير كلمة المرور' }); }
});

app.get('/api/site-content', async (_req, res) => {
  try { const q = await pool.query('SELECT content FROM site_content WHERE id=1'); res.json({ content: q.rows[0]?.content || DEFAULT_CONTENT }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not load site content' }); }
});
app.put('/api/site-content', requireAdmin, async (req, res) => {
  try {
    const content = req.body?.content;
    if (!content || typeof content !== 'object') return res.status(400).json({ error: 'Invalid content' });
    await pool.query('INSERT INTO site_content(id,content,updated_at) VALUES(1,$1,NOW()) ON CONFLICT(id) DO UPDATE SET content=EXCLUDED.content,updated_at=NOW()', [JSON.stringify(content)]);
    res.json({ ok: true, content });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not save site content' }); }
});

app.post('/api/orders', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.phone || !b.address || !Array.isArray(b.items) || !b.items.length) return res.status(400).json({ error: 'Missing required fields' });
    const items = b.items.map(i => { const key=packageKey(i.package_key||i.package_name); const quantity=Math.max(1,Math.min(100,Number.parseInt(i.quantity,10)||1)); return {...i,package_key:key,package_name:key==='normal'?'الباقة العادية':key==='save'?'باقة التوفير':'باقة السوبر',unit_price:PRICES[key],quantity}; });
    const packageCount=items.reduce((s,i)=>s+i.quantity,0), superCount=items.filter(i=>i.package_key==='super').reduce((s,i)=>s+i.quantity,0);
    const subtotal=items.reduce((s,i)=>s+i.unit_price*i.quantity,0), deliveryFee=1, discount=packageCount>=2?1:0, freeNormal=superCount>=2, freeNormalValue=freeNormal?PRICES.normal:0, total=Math.max(0,subtotal+deliveryFee-discount);
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const code='EN-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();
      const q=await client.query(`INSERT INTO orders(order_code,customer_name,phone,whatsapp,backup_phone,governorate,address,notes,subtotal,delivery_fee,discount,total,status,free_normal,free_normal_value,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'جديد',$13,$14,$15) RETURNING id,order_code,created_at,total,discount,free_normal,free_normal_value`, [code,String(b.customer_name||'').trim(),String(b.phone).trim(),String(b.whatsapp||'').trim(),String(b.backup_phone||'').trim(),String(b.governorate||'').trim(),String(b.address).trim(),String(b.notes||'').trim(),subtotal,deliveryFee,discount,total,freeNormal,freeNormalValue,String(b.source||'website')]);
      for (const i of items) await client.query(`INSERT INTO order_items(order_id,product_id,grade,subject,package_key,package_name,unit_price,quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [q.rows[0].id,i.product_id||null,String(i.grade||''),String(i.subject||''),i.package_key,i.package_name,i.unit_price,i.quantity]);
      await client.query('COMMIT'); res.status(201).json(q.rows[0]);
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } catch(e) { console.error(e); res.status(500).json({ error:'Could not create order' }); }
});

app.get('/api/orders', requireAdmin, async (req,res)=>{
  try {
    const status=req.query.status,args=[],where=status&&status!=='الكل'?(args.push(status),'WHERE o.status=$1'):'';
    const q=await pool.query(`SELECT o.*,COALESCE(json_agg(json_build_object('id',i.id,'product_id',i.product_id,'grade',i.grade,'subject',i.subject,'package_key',i.package_key,'package_name',i.package_name,'unit_price',i.unit_price,'quantity',i.quantity) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),'[]') AS items FROM orders o LEFT JOIN order_items i ON i.order_id=o.id ${where} GROUP BY o.id ORDER BY o.created_at DESC`,args);
    res.json(q.rows);
  } catch(e) { console.error(e); res.status(500).json({ error:'Could not load orders' }); }
});
app.patch('/api/orders/:id', requireAdmin, async (req,res)=>{
  try { if(!STATUSES.includes(req.body?.status)) return res.status(400).json({error:'Invalid status'}); const q=await pool.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',[req.body.status,req.params.id]); if(!q.rowCount)return res.status(404).json({error:'Not found'}); res.json(q.rows[0]); }
  catch(e){ console.error(e); res.status(500).json({error:'Could not update order'}); }
});

initDb().then(()=>app.listen(PORT,()=>console.log('API listening on '+PORT))).catch(e=>{console.error('Database initialization failed:',e);process.exit(1)});
