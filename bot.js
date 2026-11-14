const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const DB_DIR = path.join(ROOT, 'database');
const DATA_DIR = path.resolve(process.env.DATA_DIR || DB_DIR);
const DB_FILE = path.join(DATA_DIR, 'data.json');
const PROOF_DIR = path.join(DATA_DIR, 'proofs');

fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROOF_DIR, { recursive: true });

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;

  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  });
}

loadEnv();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 10) {
  console.error('ERRO: configura ADMIN_PASSWORD no ficheiro .env');
  process.exit(1);
}

function initialData() {
  const catalogFile = path.join(DB_DIR, 'packages.json');
  let packages = [];

  if (fs.existsSync(catalogFile)) {
    packages = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  }

  return {
    packages: Array.isArray(packages) ? packages : [],
    orders: [],
    createdAt: new Date().toISOString()
  };
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(initialData(), null, 2));
    }

    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

    if (!Array.isArray(data.packages)) data.packages = [];
    if (!Array.isArray(data.orders)) data.orders = [];

    return data;
  } catch (error) {
    console.error('Erro ao ler base de dados:', error.message);
    throw error;
  }
}

function saveDB(data) {
  const temp = DB_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, DB_FILE);
}

let db = readDB();

app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const sessions = new Set();
const loginAttempts = new Map();

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer /i, '');

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'Sessão administrativa inválida.' });
  }

  next();
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', app: 'MEGA FÁCIL MZ' });
});

app.get('/api/packages', (req, res) => {
  res.json(db.packages.filter(p => p.active));
});

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'local';
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || { count: 0, time: now };

  if (now - attempts.time > 10 * 60 * 1000) {
    attempts.count = 0;
    attempts.time = now;
  }

  if (attempts.count >= 5) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde 10 minutos.' });
  }

  const password = String(req.body.password || '');

  const expected = Buffer.from(ADMIN_PASSWORD);
  const received = Buffer.from(password);

  const valid = expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);

  if (!valid) {
    attempts.count++;
    loginAttempts.set(ip, attempts);
    return res.status(401).json({ error: 'Palavra-passe incorrecta.' });
  }

  loginAttempts.delete(ip);

  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);

  res.json({ success: true, token });
});

app.post('/api/admin/logout', adminAuth, (req, res) => {
  const token = req.headers.authorization.replace(/^Bearer /i, '');
  sessions.delete(token);
  res.json({ success: true });
});

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
  const total = db.orders.length;
  const pending = db.orders.filter(o => o.status === 'aguardando_pagamento').length;
  const paid = db.orders.filter(o => o.status === 'pagamento_confirmado').length;
  const delivered = db.orders.filter(o => o.status === 'megas_enviados').length;

  const revenue = db.orders
    .filter(o => o.status === 'pagamento_confirmado' || o.status === 'megas_enviados')
    .reduce((sum, o) => sum + Number(o.price || 0), 0);

  res.json({
    total,
    pending,
    paid,
    delivered,
    revenue
  });
});

app.get('/api/admin/packages', adminAuth, (req, res) => {
  res.json(db.packages);
});

app.post('/api/admin/packages', adminAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const megabytes = Number(req.body.megabytes);
  const price = Number(req.body.price);

  if (!name || name.length > 60 ||
      !Number.isInteger(megabytes) || megabytes <= 0 ||
      !Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'Verifica o nome, quantidade e preço.' });
  }

  const pack = {
    id: crypto.randomUUID(),
    name,
    megabytes,
    price,
    active: true,
    createdAt: new Date().toISOString()
  };

  db.packages.push(pack);
  saveDB(db);

  res.json({ success: true, package: pack });
});

app.patch('/api/admin/packages/:id', adminAuth, (req, res) => {
  const pack = db.packages.find(p => p.id === req.params.id);

  if (!pack) return res.status(404).json({ error: 'Pacote não encontrado.' });

  if (req.body.active !== undefined) {
    pack.active = Boolean(req.body.active);
  }

  saveDB(db);
  res.json({ success: true, package: pack });
});

app.post('/api/orders', (req, res) => {
  const packageId = String(req.body.packageId || '');
  const phone = String(req.body.phone || '').trim();
  const paymentMethod = String(req.body.paymentMethod || '');

  const pack = db.packages.find(p => p.id === packageId && p.active);

  if (!pack) {
    return res.status(400).json({ error: 'Pacote indisponível.' });
  }

  if (!/^(8[234567]|9[0-9])[0-9]{7}$/.test(phone)) {
    return res.status(400).json({ error: 'Número de telefone inválido.' });
  }

  if (!['M-Pesa', 'e-Mola'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'Método de pagamento inválido.' });
  }


  const order = {
    id: crypto.randomUUID(),
    code: 'MF-' + Date.now().toString().slice(-8) + '-' +
      crypto.randomBytes(2).toString('hex').toUpperCase(),
    packageId: pack.id,
    packageName: pack.name,
    megabytes: pack.megabytes,
    price: pack.price,
    phone,
    paymentMethod,
    status: 'aguardando_pagamento',
    adminNote: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.orders.unshift(order);
  saveDB(db);

  res.status(201).json({
    success: true,
    message: 'Encomenda registada. Aguarde a verificação do pagamento.',
    order: {
      code: order.code,
      status: order.status
    }
  });
});


app.post('/api/orders/:code/proof', (req, res) => {
  const order = db.orders.find(o => o.code === req.params.code);

  if (!order) {
    return res.status(404).json({ error: 'Encomenda não encontrada.' });
  }

  if (order.status !== 'aguardando_pagamento') {
    return res.status(400).json({ error: 'Esta encomenda já não aceita comprovativos.' });
  }

  const smsText = String(req.body.smsText || '').trim();
  const imageData = String(req.body.imageData || '');

  if (!smsText && !imageData) {
    return res.status(400).json({ error: 'Envia uma imagem ou cola a mensagem de confirmação.' });
  }

  if (smsText.length > 5000) {
    return res.status(400).json({ error: 'A mensagem é demasiado grande.' });
  }

  if (imageData) {
    const match = imageData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);

    if (!match) {
      return res.status(400).json({ error: 'Formato de imagem inválido. Usa JPG, PNG ou WebP.' });
    }

    const buffer = Buffer.from(match[2], 'base64');

    if (!buffer.length || buffer.length > 4 * 1024 * 1024) {
      return res.status(400).json({ error: 'A imagem deve ter no máximo 4 MB.' });
    }

    const extensions = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp'
    };

    const filename = crypto.randomBytes(24).toString('hex') + extensions[match[1]];
    fs.writeFileSync(path.join(PROOF_DIR, filename), buffer);

    if (order.proofImage) {
      try { fs.unlinkSync(path.join(PROOF_DIR, path.basename(order.proofImage))); } catch {}
    }

    order.proofImage = filename;
  }

  order.proofSms = smsText;
  order.proofSubmittedAt = new Date().toISOString();
  order.updatedAt = new Date().toISOString();

  saveDB(db);

  res.json({
    success: true,
    message: 'Comprovativo enviado. Aguarde a verificação do pagamento.'
  });
});

app.get('/api/orders/:code', (req, res) => {
  const order = db.orders.find(o => o.code === req.params.code);

  if (!order) return res.status(404).json({ error: 'Encomenda não encontrada.' });

  res.json({
    code: order.code,
    packageName: order.packageName,
    status: order.status,
    createdAt: order.createdAt
  });
});

app.get('/api/admin/orders', adminAuth, (req, res) => {
  const orders = db.orders.map(order => {
    let proofImageData = '';

    if (order.proofImage) {
      try {
        const filename = path.basename(order.proofImage);
        const imagePath = path.join(PROOF_DIR, filename);
        const ext = path.extname(filename).toLowerCase();
        const mime = ext === '.png' ? 'image/png' :
          ext === '.webp' ? 'image/webp' : 'image/jpeg';

        if (fs.existsSync(imagePath)) {
          proofImageData = 'data:' + mime + ';base64,' +
            fs.readFileSync(imagePath).toString('base64');
        }
      } catch (e) {
        console.error('Erro ao carregar comprovativo:', e.message);
      }
    }

    return { ...order, proofImageData };
  });

  res.json(orders);
});

app.patch('/api/admin/orders/:id', adminAuth, (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);

  if (!order) return res.status(404).json({ error: 'Encomenda não encontrada.' });

  const status = String(req.body.status || '');

  const allowed = [
    'aguardando_pagamento',
    'pagamento_confirmado',
    'megas_enviados',
    'cancelado'
  ];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Estado inválido.' });
  }

  if (status === 'megas_enviados' && order.status !== 'pagamento_confirmado') {
    return res.status(400).json({
      error: 'Primeiro confirma o pagamento. Só depois podes marcar os megas como enviados.'
    });
  }

  if (status === 'pagamento_confirmado' &&
      order.status !== 'aguardando_pagamento') {
    return res.status(400).json({ error: 'Estado do pedido não permite esta alteração.' });
  }

  order.status = status;
  order.updatedAt = new Date().toISOString();

  if (req.body.adminNote !== undefined) {
    order.adminNote = String(req.body.adminNote).slice(0, 500);
  }

  saveDB(db);

  res.json({ success: true, order });
});


app.post('/api/chat', (req, res) => {
  const original = String(req.body.message || '').trim();
  const message = original.toUpperCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (message === 'MEGA' || message === 'MEGAS') {
    const categories = ['DIÁRIO', 'SEMANAL', 'MENSAL', 'DIAMANTE'];
    let reply = '📦 CATÁLOGO VODACOM — MEGA FÁCIL MZ\\n';

    for (const category of categories) {
      const packages = db.packages.filter(p =>
        p.active && p.category === category
      );

      if (!packages.length) continue;

      reply += '\\n━━━━━━━━━━━━━━━━━━\\n';
      reply += '📦 ' + category + '\\n';

      for (const p of packages) {
        const amount = p.megabytes >= 1024
          ? (p.megabytes / 1024).toFixed(p.megabytes % 1024 === 0 ? 0 : 1) + ' GB'
          : p.megabytes + ' MB';

        reply += amount + ' — ' + p.price + ' MT\\n';
      }

      reply += 'Validade: ' +
        (packages[0].validityDays === 1 ? '1 dia' : packages[0].validityDays + ' dias') +
        '\\n';
    }

    reply += '\\n📌 Escolhe o pacote e escreve PAGAMENTO para ver como pagar.';
    return res.json({ reply });
  }

  if (message === 'PAGAMENTO' || message === 'PAGAR') {
    return res.json({
      reply:
        '💳 FORMAS DE PAGAMENTO\\n\\n' +
        '📱 M-PESA\\n' +
        'Número: 848737335\\n' +
        'Titular: ISABEL FABIAO\\n\\n' +
        '📱 E-MOLA\\n' +
        'Número: 870737473\\n' +
        'Titular: JOAQUIM SÉRGIO SITOL\\n\\n' +
        '📸 DEPOIS DE PAGAR\\n' +
        'Envia o texto do comprovativo na tua encomenda.\\n' +
        'O administrador verificará o pagamento antes da entrega.\\n\\n' +
        '⚠️ Não envies PIN, senha ou código OTP.'
    });
  }

  if (message === 'AJUDA') {
    return res.json({
      reply:
        '👋 BEM-VINDO AO MEGA FÁCIL MZ!\\n\\n' +
        '📦 MEGA — consultar pacotes\\n' +
        '💳 PAGAMENTO — ver números de pagamento\\n' +
        '📍 ESTADO — consultar uma encomenda\\n' +
        '⭐ PONTOS — informação sobre fidelidade\\n' +
        '🔥 STREAK — informação sobre bónus\\n\\n' +
        'Escolhe um comando para continuar.'
    });
  }

  if (message === 'PONTOS') {
    return res.json({
      reply: '⭐ O programa de pontos de fidelidade ainda está a ser preparado. Em breve poderás consultar os teus pontos aqui.'
    });
  }

  if (message === 'STREAK') {
    return res.json({
      reply: '🔥 O sistema de dias consecutivos e bónus ainda está a ser preparado.'
    });
  }

  if (message === 'ESTADO') {
    return res.json({
      reply: '📍 Para consultar a tua encomenda, envia o código recebido depois de fazeres o pedido.'
    });
  }

  if (/ID DA TRANSACAO|ID DA TRANSAÇÃO|TRANSFERISTE|TRANSFERENCIA|TRANSFERÊNCIA/.test(message)) {
    return res.json({
      reply:
        '📩 Recebemos uma mensagem com dados de transação.\\n\\n' +
        '⚠️ O comprovativo ainda precisa de validação.\\n' +
        'O administrador verificará se o dinheiro entrou na conta oficial.\\n' +
        'Não consideramos uma transferência confirmada apenas pelo texto enviado.'
    });
  }

  return res.json({
    reply: 'Não compreendi. Escreve MEGA, PAGAMENTO ou AJUDA.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('================================');
  console.log('       MEGA FÁCIL MZ');
  console.log('================================');
  console.log('Servidor iniciado na porta ' + PORT);
  console.log('Site: http://localhost:' + PORT);
  console.log('Admin: http://localhost:' + PORT + '/admin.html');
});
