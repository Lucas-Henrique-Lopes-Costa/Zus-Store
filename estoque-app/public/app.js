const $ = (id) => document.getElementById(id);
const TAMANHOS = ['Único', 'PP', 'P', 'M', 'G', 'GG', 'XG', 'G1', 'G2', 'G3', '34', '36', '38', '40', '42', '44', '46'];
let arquivos = [];

async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  if (r.status === 401 && !url.endsWith('/login')) { mostrar('login'); throw new Error('Faça login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Erro');
  return j;
}
const msg = (el, texto, tipo = 'ok') => { $(el).innerHTML = texto ? `<div class="msg ${tipo}">${texto}</div>` : ''; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function mostrar(tela) {
  for (const t of ['login', 'cadastro', 'buscar']) $(t).classList.toggle('hidden', t !== tela);
  $('tabs').classList.toggle('hidden', tela === 'login');
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tela));
}
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => mostrar(b.dataset.t));

// ---------- login ----------
$('btnLogin').onclick = async () => {
  try { await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: $('senha').value }) }); iniciar(); }
  catch (e) { msg('loginMsg', e.message, 'err'); }
};
$('senha').onkeydown = (e) => e.key === 'Enter' && $('btnLogin').click();

async function iniciar() {
  try {
    const s = await api('/api/status');
    mostrar('cadastro');
    $('st').textContent = s.loja ? 'loja conectada' : 'loja NÃO conectada';
    if (!s.ia) $('btnIA').classList.add('hidden');
    if (s.loja) carregarCategorias(); else $('categoria').innerHTML = '<option value="">Loja não conectada — acesse /instalar</option>';
  } catch { mostrar('login'); }
}

async function carregarCategorias() {
  try {
    const cats = await api('/api/categorias');
    $('categoria').innerHTML = '<option value="">Escolha…</option>' + cats.map((c) => `<option value="${c.id}" data-parent="${c.parent || ''}">${esc(c.nome)}</option>`).join('');
  } catch (e) { $('categoria').innerHTML = `<option value="">${esc(e.message)}</option>`; }
}

// ---------- fotos ----------
$('fotos').onchange = () => {
  arquivos = arquivos.concat([...$('fotos').files]).slice(0, 6);
  $('fotos').value = '';
  desenharFotos();
};
function desenharFotos() {
  $('preview').innerHTML = '';
  arquivos.forEach((f, i) => {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(f);
    img.title = 'Toque para remover';
    img.onclick = () => { arquivos.splice(i, 1); desenharFotos(); };
    $('preview').appendChild(img);
  });
}

// ---------- IA ----------
$('btnIA').onclick = async () => {
  if (!arquivos.length) return msg('cadMsg', 'Tire uma foto primeiro', 'err');
  const b = $('btnIA'); b.disabled = true; b.textContent = 'Gerando…';
  try {
    const fd = new FormData(); fd.append('foto', arquivos[0]); fd.append('dica', $('dica').value);
    const r = await api('/api/ia', { method: 'POST', body: fd });
    $('nome').value = r.nome || ''; $('descricao').value = r.descricao || '';
    window._seo = { seo_title: r.seo_title, seo_description: r.seo_description };
    if (r.cor && !document.querySelector('.var .cor')?.value) document.querySelectorAll('.var .cor').forEach((el) => el.value ||= r.cor);
    msg('cadMsg', 'Confira o texto antes de cadastrar.');
  } catch (e) { msg('cadMsg', e.message, 'err'); }
  b.disabled = false; b.textContent = '✨ Gerar nome e descrição pela foto';
};

// ---------- variacoes ----------
$('chipsTam').innerHTML = TAMANHOS.map((t) => `<button class="chip" type="button">${t}</button>`).join('');
$('chipsTam').querySelectorAll('.chip').forEach((c) => c.onclick = () => {
  const vazia = [...document.querySelectorAll('.var')].find((v) => !v.querySelector('.tam').value && !v.querySelector('.cor').value);
  if (vazia) vazia.querySelector('.tam').value = c.textContent; else addVar('', c.textContent, 1);
});
function addVar(cor = '', tam = '', qtd = 1) {
  const d = document.createElement('div'); d.className = 'var';
  d.innerHTML = `<input class="cor" placeholder="Cor" value="${esc(cor)}"><input class="tam" placeholder="Tam." value="${esc(tam)}"><input class="qtd" type="number" min="0" inputmode="numeric" value="${qtd}"><button class="x" type="button">×</button>`;
  d.querySelector('.x').onclick = () => d.remove();
  $('vars').appendChild(d);
}
addVar();

// ---------- locais recentes ----------
const locais = () => JSON.parse(localStorage.getItem('zusLocais') || '[]');
const lembrarLocal = (l) => { if (!l) return; const a = [l, ...locais().filter((x) => x !== l)].slice(0, 15); localStorage.setItem('zusLocais', JSON.stringify(a)); desenharLocais(); };
const desenharLocais = () => { $('locais').innerHTML = locais().map((l) => `<option value="${esc(l)}">`).join(''); };
desenharLocais();

// ---------- salvar ----------
$('btnSalvar').onclick = async () => {
  const b = $('btnSalvar');
  const preco = Number(String($('preco').value).replace(/\./g, '').replace(',', '.'));
  const variacoes = [...document.querySelectorAll('.var')].map((v) => ({ cor: v.querySelector('.cor').value.trim(), tamanho: v.querySelector('.tam').value.trim(), qtd: Number(v.querySelector('.qtd').value) }));
  const opt = $('categoria').selectedOptions[0];
  const categorias = opt?.value ? [Number(opt.value), ...(opt.dataset.parent ? [Number(opt.dataset.parent)] : [])] : [];
  const dados = { nome: $('nome').value.trim(), marca: $('marca').value.trim(), preco, descricao: $('descricao').value, categorias, variacoes, local: $('local').value.trim().toUpperCase(), publicar: $('publicar').checked, ...(window._seo || {}) };
  if (!arquivos.length) return msg('cadMsg', 'Tire pelo menos uma foto', 'err');
  if (!dados.nome || !(preco > 0)) return msg('cadMsg', 'Preencha nome e preço', 'err');
  b.disabled = true; b.textContent = 'Cadastrando…';
  try {
    const fd = new FormData(); arquivos.forEach((f) => fd.append('fotos', f)); fd.append('dados', JSON.stringify(dados));
    const r = await api('/api/produtos', { method: 'POST', body: fd });
    lembrarLocal(dados.local);
    msg('cadMsg', `✅ Cadastrado! SKUs: ${r.skus.join(', ')}${r.avisos.length ? '<br>⚠️ ' + r.avisos.map(esc).join('<br>') : ''}<br><br>
      <a href="/api/etiquetas/${r.produto_id}" target="_blank"><button type="button">🖨️ Abrir etiquetas</button></a>
      <a href="${esc(r.url)}" target="_blank" class="muted">ver na loja</a>`);
    arquivos = []; desenharFotos();
    ['nome', 'marca', 'preco', 'descricao', 'dica'].forEach((i) => $(i).value = '');
    $('vars').innerHTML = ''; addVar(); window._seo = null;
    window.scrollTo(0, document.body.scrollHeight);
  } catch (e) { msg('cadMsg', e.message, 'err'); }
  b.disabled = false; b.textContent = 'Cadastrar e gerar etiquetas';
};

// ---------- buscar ----------
$('btnBuscar').onclick = buscar;
$('q').onkeydown = (e) => e.key === 'Enter' && buscar();
async function buscar() {
  $('resultados').innerHTML = '<p class="muted">Buscando…</p>';
  try {
    const lista = await api('/api/buscar?q=' + encodeURIComponent($('q').value));
    $('resultados').innerHTML = lista.length ? '' : '<p class="muted">Nada encontrado.</p>';
    for (const p of lista) {
      const el = document.createElement('div'); el.className = 'card';
      el.innerHTML = `<div class="res"><img src="${esc(p.foto || '')}" alt=""><div style="flex:1">
        <b>${esc(p.nome)}</b> ${p.publicado ? '' : '<span class="muted">(oculto)</span>'}
        <div style="margin:6px 0">📍 <b class="loc">${esc(p.local || 'sem local')}</b></div>
        ${p.variantes.map((v) => `<div class="muted">${esc(v.valores || 'Único')} · estoque ${v.estoque ?? '∞'} · R$ ${esc(v.preco)} <a href="/api/etiquetas/${p.id}?sku=${encodeURIComponent(v.sku || '')}&qtd=1" target="_blank">🏷️</a></div>`).join('')}
        <div class="row" style="margin-top:8px"><input class="novoLocal" placeholder="Novo local"><button class="sec" style="flex:0">Salvar</button></div>
      </div></div>`;
      el.querySelector('button.sec').onclick = async () => {
        const novo = el.querySelector('.novoLocal').value.trim().toUpperCase();
        try { await api('/api/local/' + p.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ local: novo }) }); el.querySelector('.loc').textContent = novo || 'sem local'; lembrarLocal(novo); }
        catch (e) { alert(e.message); }
      };
      $('resultados').appendChild(el);
    }
  } catch (e) { $('resultados').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
}

iniciar();
