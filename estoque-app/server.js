import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 3100);
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const UA = 'Zus Estoque (zus.lucasprogramador.com.br)';

// ---------- banco local (localizacao, contador de SKU, token) ----------
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(path.join(__dirname, 'data', 'zus.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT);
  CREATE TABLE IF NOT EXISTS produtos (
    produto_id INTEGER PRIMARY KEY, nome TEXT, preco REAL, local TEXT,
    criado_em TEXT DEFAULT (datetime('now','localtime')));
  CREATE TABLE IF NOT EXISTS variantes (
    sku TEXT PRIMARY KEY, produto_id INTEGER, cor TEXT, tamanho TEXT, qtd INTEGER);
`);
const cfg = {
  get: (k) => db.prepare('SELECT valor FROM config WHERE chave=?').get(k)?.valor,
  set: (k, v) => db.prepare('INSERT INTO config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run(k, String(v)),
};
const storeId = () => env.NUVEMSHOP_STORE_ID || cfg.get('store_id');
const token = () => env.NUVEMSHOP_ACCESS_TOKEN || cfg.get('access_token');

// ---------- login simples por senha ----------
const SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const assinar = (v) => v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const valido = (s) => { if (!s) return false; const v = s.slice(0, s.lastIndexOf('.')); return assinar(v) === s; };

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const ok = env.APP_PASSWORD && req.body?.senha &&
    crypto.timingSafeEqual(Buffer.from(String(req.body.senha).padEnd(64)), Buffer.from(String(env.APP_PASSWORD).padEnd(64)));
  if (!ok) return res.status(401).json({ erro: 'Senha incorreta' });
  res.cookie('zus', assinar('ok:' + Date.now()), { httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https'), maxAge: 1000 * 60 * 60 * 24 * 30 });
  res.json({ ok: true });
});
const auth = (req, res, next) => valido(req.cookies.zus) ? next() : res.status(401).json({ erro: 'Faça login' });

// ---------- Nuvemshop: instalacao (OAuth) ----------
app.get('/instalar', (req, res) => {
  if (!env.NUVEMSHOP_CLIENT_ID) return res.status(500).send('Configure NUVEMSHOP_CLIENT_ID no .env');
  res.redirect(`https://www.nuvemshop.com.br/apps/${env.NUVEMSHOP_CLIENT_ID}/authorize`);
});
app.get('/oauth/callback', async (req, res) => {
  try {
    const r = await fetch('https://www.tiendanube.com/apps/authorize/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.NUVEMSHOP_CLIENT_ID, client_secret: env.NUVEMSHOP_CLIENT_SECRET, grant_type: 'authorization_code', code: req.query.code }),
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(JSON.stringify(j));
    cfg.set('access_token', j.access_token); cfg.set('store_id', j.user_id);
    res.send('<h2>Loja conectada!</h2><p>Pode fechar esta aba e voltar para o <a href="/">sistema</a>.</p>');
  } catch (e) { res.status(500).send('Falha ao conectar: ' + e.message); }
});

async function ns(metodo, caminho, corpo) {
  if (!token() || !storeId()) throw new Error('Loja não conectada. Acesse /instalar');
  const r = await fetch(`https://api.nuvemshop.com.br/v1/${storeId()}${caminho}`, {
    method: metodo,
    headers: { 'Authentication': `bearer ${token()}`, 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  const j = txt ? JSON.parse(txt) : null;
  if (!r.ok) throw new Error(`Nuvemshop ${r.status}: ${txt.slice(0, 400)}`);
  return j;
}

app.get('/api/status', auth, (req, res) => res.json({ loja: !!(token() && storeId()), ia: !!env.OPENAI_API_KEY }));

app.get('/api/categorias', auth, async (req, res) => {
  try {
    const cats = await ns('GET', '/categories?per_page=200');
    const porId = Object.fromEntries(cats.map((c) => [c.id, c]));
    const nome = (c) => (c.name.pt || Object.values(c.name)[0]);
    const lista = cats.map((c) => ({ id: c.id, parent: c.parent || null, nome: c.parent && porId[c.parent] ? `${nome(porId[c.parent])} › ${nome(c)}` : nome(c) }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
    res.json(lista);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- IA: sugere nome/descricao pela foto ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 6 } });
const otimizar = (buf) => sharp(buf).rotate().resize(1200, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();

app.post('/api/ia', auth, upload.single('foto'), async (req, res) => {
  try {
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada');
    const img = (await sharp(req.file.buffer).rotate().resize(768, 768, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer()).toString('base64');
    const dica = req.body.dica ? `Informação da vendedora: ${req.body.dica}.` : '';
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Você cadastra produtos de uma loja de moda feminina brasileira (Zus Store). Responda só JSON. Descreva apenas o que dá para ver na foto; não invente material, medidas ou marca que não estejam visíveis ou informados. Nunca cite marcas de terceiros como "inspiração".' },
          { role: 'user', content: [
            { type: 'text', text: `${dica} Gere: {"nome": título de produto com palavra-chave + tipo + detalhe + cor (até 60 caracteres, sem marca se não informada), "cor": cor principal, "descricao": HTML curto com <p> de abertura, <h2>Como usar</h2><p>…</p> e <h2>Detalhes</h2><ul><li>…</li></ul>, "seo_title": até 60 caracteres terminando em " | Zus Store", "seo_description": até 155 caracteres, "tipo": uma palavra entre vestido, blusa, conjunto, calca, saia, short, casaco, bolsa, calcado, acessorio}` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } },
          ] },
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'Erro na IA');
    res.json(JSON.parse(j.choices[0].message.content));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- cadastro ----------
const sigla = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(' ').filter(Boolean).map((p) => p.slice(0, 3)).join('').slice(0, 6);
function proximoCodigo() {
  const n = Number(cfg.get('seq') || 1000) + 1; cfg.set('seq', n); return 'Z' + n;
}

app.post('/api/produtos', auth, upload.array('fotos', 6), async (req, res) => {
  try {
    const d = JSON.parse(req.body.dados);
    if (!d.nome || !(d.preco > 0)) throw new Error('Nome e preço são obrigatórios');
    if (!req.files?.length) throw new Error('Tire pelo menos uma foto');
    const linhas = (d.variacoes || []).filter((v) => v.qtd > 0);
    if (!linhas.length) throw new Error('Informe pelo menos uma variação com quantidade');

    const base = proximoCodigo();
    const usaCor = linhas.some((v) => v.cor), usaTam = linhas.some((v) => v.tamanho);
    const attributes = [usaCor && { pt: 'Cor' }, usaTam && { pt: 'Tamanho' }].filter(Boolean);
    const variants = linhas.map((v) => {
      const sku = [base, sigla(v.tamanho), sigla(v.cor)].filter(Boolean).join('-');
      const values = [usaCor && { pt: v.cor || 'Única' }, usaTam && { pt: v.tamanho || 'Único' }].filter(Boolean);
      return { price: Number(d.preco).toFixed(2), stock: Number(v.qtd), stock_management: true, sku, barcode: sku,
        weight: d.peso || '0.5', width: '30', height: '6', depth: '25', ...(attributes.length ? { values } : {}) };
    });

    const produto = await ns('POST', '/products', {
      name: { pt: d.nome },
      description: { pt: d.descricao || `<p>${d.nome}</p>` },
      seo_title: { pt: (d.seo_title || `${d.nome} | Zus Store`).slice(0, 70) },
      seo_description: { pt: (d.seo_description || d.nome).slice(0, 320) },
      brand: d.marca || undefined,
      published: !!d.publicar,
      requires_shipping: true,
      categories: d.categorias || [],
      ...(attributes.length ? { attributes } : {}),
      variants,
    });

    const erros = [];
    for (const [i, f] of req.files.entries()) {
      try {
        const buf = await otimizar(f.buffer);
        await ns('POST', `/products/${produto.id}/images`, { attachment: buf.toString('base64'), filename: `${base}-${i + 1}.jpg`, position: i + 1, alt: { pt: d.nome } });
      } catch (e) { erros.push(`Foto ${i + 1}: ${e.message}`); }
    }

    db.prepare('INSERT OR REPLACE INTO produtos(produto_id,nome,preco,local) VALUES(?,?,?,?)').run(produto.id, d.nome, Number(d.preco), d.local || '');
    const ins = db.prepare('INSERT OR REPLACE INTO variantes(sku,produto_id,cor,tamanho,qtd) VALUES(?,?,?,?,?)');
    linhas.forEach((v, i) => ins.run(variants[i].sku, produto.id, v.cor || '', v.tamanho || '', Number(v.qtd)));

    res.json({ ok: true, produto_id: produto.id, url: produto.canonical_url, skus: variants.map((v) => v.sku), avisos: erros });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- etiquetas (PDF 50 x 35 mm, uma por unidade) ----------
const mm = (v) => (v * 72) / 25.4;
async function pdfEtiquetas(itens, res) {
  const doc = new PDFDocument({ size: [mm(50), mm(35)], margin: 0, autoFirstPage: false });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="etiquetas-zus.pdf"');
  doc.pipe(res);
  for (const it of itens) {
    const png = await bwipjs.toBuffer({ bcid: 'code128', text: it.sku, scale: 2, height: 9, includetext: false });
    for (let n = 0; n < it.qtd; n++) {
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(7).text('ZUS STORE', mm(2), mm(1.8), { width: mm(46), align: 'center' });
      doc.font('Helvetica').fontSize(6.5).text(it.nome, mm(2), mm(5), { width: mm(46), height: mm(6), align: 'center', ellipsis: true });
      const varTxt = [it.cor, it.tamanho && `Tam ${it.tamanho}`].filter(Boolean).join(' · ');
      if (varTxt) doc.font('Helvetica-Bold').fontSize(7.5).text(varTxt, mm(2), mm(11), { width: mm(46), align: 'center' });
      doc.image(png, mm(4), mm(14.5), { width: mm(42), height: mm(9) });
      doc.font('Helvetica').fontSize(6).text(it.sku, mm(2), mm(24), { width: mm(46), align: 'center' });
      doc.font('Helvetica-Bold').fontSize(10).text(`R$ ${Number(it.preco).toFixed(2).replace('.', ',')}`, mm(2), mm(27.5), { width: mm(30) });
      if (it.local) doc.font('Helvetica').fontSize(6).text(`Local: ${it.local}`, mm(28), mm(29), { width: mm(20), align: 'right' });
    }
  }
  doc.end();
}
app.get('/api/etiquetas/:produtoId', auth, async (req, res) => {
  const p = db.prepare('SELECT * FROM produtos WHERE produto_id=?').get(req.params.produtoId);
  if (!p) return res.status(404).send('Produto não encontrado no sistema');
  const vs = db.prepare('SELECT * FROM variantes WHERE produto_id=?').all(p.produto_id);
  const so = req.query.sku;
  await pdfEtiquetas(vs.filter((v) => !so || v.sku === so).map((v) => ({ ...v, nome: p.nome, preco: p.preco, local: p.local, qtd: so ? Number(req.query.qtd || 1) : v.qtd })), res);
});

// ---------- buscar peca (nome, SKU ou codigo bipado) ----------
app.get('/api/buscar', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const local = db.prepare('SELECT v.produto_id FROM variantes v WHERE v.sku = ? COLLATE NOCASE').get(q);
    const lista = local ? [await ns('GET', `/products/${local.produto_id}`)] : await ns('GET', `/products?q=${encodeURIComponent(q)}&per_page=20`);
    res.json(lista.map((p) => {
      const l = db.prepare('SELECT local FROM produtos WHERE produto_id=?').get(p.id);
      return { id: p.id, nome: p.name.pt, foto: p.images?.[0]?.src, publicado: p.published, local: l?.local || '', url: p.canonical_url,
        variantes: p.variants.map((v) => ({ sku: v.sku, valores: v.values.map((x) => x.pt).join(' / '), estoque: v.stock, preco: v.price })) };
    }));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/local/:produtoId', auth, async (req, res) => {
  const id = Number(req.params.produtoId), local = String(req.body.local || '');
  const r = db.prepare('UPDATE produtos SET local=? WHERE produto_id=?').run(local, id);
  if (!r.changes) {
    const p = await ns('GET', `/products/${id}`).catch(() => null);
    if (!p) return res.status(404).json({ erro: 'Produto não encontrado' });
    db.prepare('INSERT INTO produtos(produto_id,nome,preco,local) VALUES(?,?,?,?)').run(id, p.name.pt, Number(p.variants[0]?.price || 0), local);
    const ins = db.prepare('INSERT OR IGNORE INTO variantes(sku,produto_id,cor,tamanho,qtd) VALUES(?,?,?,?,?)');
    for (const v of p.variants) if (v.sku) ins.run(v.sku, id, v.values[0]?.pt || '', v.values[1]?.pt || '', Number(v.stock || 0));
  }
  res.json({ ok: true });
});

app.listen(PORT, '127.0.0.1', () => console.log(`Zus Estoque rodando em ${BASE_URL} (porta ${PORT})`));
