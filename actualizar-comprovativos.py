from pathlib import Path

# ---------- BOT.JS ----------
p = Path("bot.js")
s = p.read_text()

s = s.replace(
    "app.use(express.json({ limit: '30kb' }));",
    "app.use(express.json({ limit: '6mb' }));"
)

if "const PROOF_DIR" not in s:
    s = s.replace(
        "const DB_FILE = path.join(DB_DIR, 'data.json');",
        "const DB_FILE = path.join(DB_DIR, 'data.json');\n"
        "const PROOF_DIR = path.join(DB_DIR, 'proofs');"
    )
    s = s.replace(
        "fs.mkdirSync(DB_DIR, { recursive: true });",
        "fs.mkdirSync(DB_DIR, { recursive: true });\n"
        "fs.mkdirSync(PROOF_DIR, { recursive: true });"
    )

s = s.replace(
    "  const paymentReference = String(req.body.paymentReference || '').trim();\n",
    ""
)

s = s.replace(
    """  if (paymentReference.length > 100) {
    return res.status(400).json({ error: 'Referência inválida.' });
  }
""",
    ""
)

s = s.replace(
    "    paymentReference,\n",
    ""
)

# Receber comprovativo do cliente
proof_route = r"""
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

"""

if "app.post('/api/orders/:code/proof'" not in s:
    s = s.replace(
        "app.get('/api/orders/:code',",
        proof_route + "app.get('/api/orders/:code',",
        1
    )

# Admin recebe imagem em formato data URL, sem tornar a pasta pública
old = """app.get('/api/admin/orders', adminAuth, (req, res) => {
  res.json(db.orders);
});"""

new = """app.get('/api/admin/orders', adminAuth, (req, res) => {
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
});"""

if old in s:
    s = s.replace(old, new)
elif "proofImageData" not in s:
    raise SystemExit("ERRO: Não encontrei a rota administrativa das encomendas.")

p.write_text(s)

# ---------- INDEX.HTML ----------
p = Path("public/index.html")
s = p.read_text()

s = s.replace(
    "Paga pelo M-Pesa ou e-Mola e envia a referência da transacção.",
    "Paga pelo M-Pesa ou e-Mola e envia o comprovativo."
)

s = s.replace(
    """    <div class="field">
     <label>Referência da transacção (opcional)</label>
     <input id="paymentReference" maxlength="100" placeholder="Código da transacção">
    </div>
""",
    ""
)

s = s.replace(
    '<div class="field"><label>Referência da transacção (opcional)</label><input id="paymentReference" maxlength="100" placeholder="Código da transacção"></div>',
    ""
)

s = s.replace(
    " const paymentReference=document.getElementById('paymentReference').value.trim();\n",
    ""
)

s = s.replace(
    "body:JSON.stringify({packageId:selectedPackage.id,phone,paymentMethod,paymentReference})",
    "body:JSON.stringify({packageId:selectedPackage.id,phone,paymentMethod})"
)

old = """   <p class="notice">Depois do pagamento, guarda a referência da transacção e envia-a à equipa. A encomenda fica pendente até à confirmação do dinheiro recebido. A entrega dos megas é manual.</p>
   <button class="submit" onclick="closeOrder();document.getElementById('trackCode').value='${escapeHTML(data.order.code)}';trackOrder();document.getElementById('acompanhar').scrollIntoView({behavior:'smooth'})">Acompanhar encomenda</button>`;"""

new = """   <p class="notice">Depois de pagares, envia uma imagem do comprovativo ou cola a mensagem SMS de confirmação. O pagamento será verificado pela equipa antes da entrega.</p>

   <form id="proofForm" onsubmit="submitProof(event,'${escapeHTML(data.order.code)}')">
    <div class="field">
     <label>🖼️ Comprovativo em imagem (opcional)</label>
     <input id="proofImage" type="file" accept="image/jpeg,image/png,image/webp">
     <small>JPG, PNG ou WebP. Máximo 4 MB.</small>
    </div>
    <div class="field">
     <label>📩 Ou cola a mensagem SMS de confirmação</label>
     <textarea id="proofSms" rows="5" maxlength="5000" placeholder="Cola aqui a mensagem recebida do M-Pesa ou e-Mola..."></textarea>
    </div>
    <button class="submit" type="submit">Enviar comprovativo</button>
   </form>
   <div id="proofMessage" class="notice">Podes enviar uma imagem, uma mensagem SMS ou ambos.</div>
   <button class="submit" onclick="closeOrder();document.getElementById('trackCode').value='${escapeHTML(data.order.code)}';trackOrder();document.getElementById('acompanhar').scrollIntoView({behavior:'smooth'})">Acompanhar encomenda</button>`;"""

if old in s:
    s = s.replace(old, new)
else:
    print("AVISO: Não encontrei o bloco final da encomenda. Será necessário verificar manualmente.")

proof_js = r"""
async function submitProof(e, code) {
 e.preventDefault();

 const imageInput = document.getElementById('proofImage');
 const smsText = document.getElementById('proofSms').value.trim();
 const file = imageInput.files[0];
 const message = document.getElementById('proofMessage');
 const button = e.target.querySelector('button[type=submit]');

 if (!file && !smsText) {
  alert('Escolhe uma imagem ou cola a mensagem SMS de confirmação.');
  return;
 }

 if (file && file.size > 4 * 1024 * 1024) {
  alert('A imagem deve ter no máximo 4 MB.');
  return;
 }

 let imageData = '';

 if (file) {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) {
   alert('Formato inválido. Usa JPG, PNG ou WebP.');
   return;
  }

  imageData = await new Promise((resolve, reject) => {
   const reader = new FileReader();
   reader.onload = () => resolve(reader.result);
   reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
   reader.readAsDataURL(file);
  });
 }

 button.disabled = true;
 button.textContent = 'A enviar comprovativo...';

 try {
  const response = await fetch('/api/orders/' + encodeURIComponent(code) + '/proof', {
   method: 'POST',
   headers: {'Content-Type':'application/json'},
   body: JSON.stringify({imageData, smsText})
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Erro ao enviar comprovativo.');

  message.textContent = '✅ ' + data.message;
  button.textContent = 'Comprovativo enviado';
 } catch (error) {
  alert(error.message);
  button.disabled = false;
  button.textContent = 'Enviar comprovativo';
 }
}

"""

if "async function submitProof(" not in s:
    s = s.replace("async function trackOrder(){", proof_js + "async function trackOrder(){", 1)

p.write_text(s)

# ---------- ADMIN.HTML ----------
p = Path("public/admin.html")
s = p.read_text()

s = s.replace(
    "<th>Referência</th>",
    "<th>Comprovativo</th>"
)

old_cell = """    <td>${escapeHTML(o.paymentReference || 'Não indicada')}</td>"""
new_cell = """    <td>
     ${o.proofImageData ? `<a href="${o.proofImageData}" target="_blank"><img src="${o.proofImageData}" alt="Comprovativo" style="width:90px;max-height:90px;object-fit:contain;border-radius:8px"></a>` : ''}
     ${o.proofSms ? `<details><summary>Ver SMS</summary><div style="white-space:pre-wrap;max-width:260px;overflow-wrap:anywhere">${escapeHTML(o.proofSms)}</div></details>` : ''}
     ${(!o.proofImageData && !o.proofSms) ? 'Ainda não enviado' : ''}
    </td>"""

if old_cell in s:
    s = s.replace(old_cell, new_cell)
else:
    print("AVISO: Não encontrei a célula de referência no painel.")

p.write_text(s)

print("Alterações aplicadas.")
