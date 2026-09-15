import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;
const app = express();

app.use(express.json({ limit: '1mb' }));

const origin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: origin === '*' ? true : origin }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined
});

const statuses = ['جديد', 'تم التواصل', 'قيد التجهيز', 'خرج للتوصيل', 'تم التسليم', 'ملغي'];

const PRICES = {
  normal: 3.5,
  save: 4.5,
  super: 5.5
};

function admin(req, res, next) {
  const expected = String(process.env.ADMIN_API_KEY || '');
  const received = String(req.get('x-admin-key') || '');

  if (
    !expected ||
    received.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

function packageKey(v) {
  const k = String(v || '').toLowerCase();

  if (k === 'normal' || k === 'save' || k === 'super') return k;
  if (k.includes('سوبر') || k.includes('super')) return 'super';
  if (k.includes('توفير') || k.includes('save')) return 'save';

  return 'normal';
}

// Site content: keeps the editable hero image in PostgreSQL.
app.get('/api/site-content', async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_content (
        id integer PRIMARY KEY,
        content jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const result = await pool.query(
      'SELECT content FROM site_content WHERE id = 1 LIMIT 1'
    );

    res.json({
      content: result.rows[0]?.content || {}
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not load site content'
    });
  }
});

app.put('/api/site-content', admin, async (req, res) => {
  try {
    const content = req.body?.content;

    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return res.status(400).json({
        error: 'Invalid content'
      });
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS site_content (
        id integer PRIMARY KEY,
        content jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await pool.query(`
      INSERT INTO site_content (id, content, updated_at)
      VALUES (1, $1::jsonb, now())
      ON CONFLICT (id)
      DO UPDATE SET
        content = EXCLUDED.content,
        updated_at = now()
    `, [JSON.stringify(content)]);

    res.json({
      ok: true,
      content
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not save site content'
    });
  }
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'exam-success-api' });
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: 'Database unavailable'
    });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const b = req.body || {};

    if (
      !b.customer_name ||
      !b.phone ||
      !b.address ||
      !Array.isArray(b.items) ||
      !b.items.length
    ) {
      return res.status(400).json({
        error: 'Missing required fields'
      });
    }

    const items = b.items.map(i => {
      const key = packageKey(i.package_key || i.package_name);

      const quantity = Math.max(
        1,
        Math.min(100, Number.parseInt(i.quantity, 10) || 1)
      );

      return {
        ...i,
        package_key: key,
        package_name:
          key === 'normal'
            ? 'الباقة العادية'
            : key === 'save'
            ? 'باقة التوفير'
            : 'الباقة السوبر',
        unit_price: PRICES[key],
        quantity
      };
    });

    const subtotal = items.reduce(
      (sum, i) => sum + i.unit_price * i.quantity,
      0
    );

    const delivery_fee = 1;
    const discount = items.length >= 2 ? 1 : 0;
    const total = Math.max(
      0,
      subtotal + delivery_fee - discount
    );

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const code =
        'EN-' +
        Date.now().toString(36).toUpperCase() +
        '-' +
        crypto.randomBytes(2).toString('hex').toUpperCase();

      const q = await client.query(
        `INSERT INTO orders
        (order_code, customer_name, phone, whatsapp, governorate, address,
         subtotal, delivery_fee, discount, total, source)
        VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING id, order_code, created_at`,
        [
          code,
          String(b.customer_name).trim(),
          String(b.phone).trim(),
          String(b.whatsapp || '').trim(),
          String(b.governorate || '').trim(),
          String(b.address).trim(),
          subtotal,
          delivery_fee,
          discount,
          total,
          String(b.source || 'website')
        ]
      );

      for (const i of items) {
        await client.query(
          `INSERT INTO order_items
          (order_id, product_id, grade, subject, package_key,
           package_name, unit_price, quantity)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            q.rows[0].id,
            i.product_id || null,
            i.grade || '',
            i.subject || '',
            i.package_key,
            i.package_name,
            i.unit_price,
            i.quantity
          ]
        );
      }

      await client.query('COMMIT');

      res.status(201).json(q.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not create order'
    });
  }
});

app.get('/api/orders', admin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM orders
      ORDER BY created_at DESC
      LIMIT 500
    `);

    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not load orders'
    });
  }
});

app.patch('/api/orders/:id', admin, async (req, res) => {
  try {
    const status = String(req.body?.status || '');

    if (!statuses.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status'
      });
    }

    const result = await pool.query(
      `UPDATE orders
       SET status = $1
       WHERE id = $2
       RETURNING *`,
      [status, req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: 'Order not found'
      });
    }

    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Could not update order'
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log('API listening on ' + port);
});
