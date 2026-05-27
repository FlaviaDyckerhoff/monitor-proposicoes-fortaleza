const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO_OVERRIDE || process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const API_BASE = 'https://sapl.fortaleza.ce.leg.br/api';
const CATCHUP_FROM = process.env.CATCHUP_FROM || '';

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO))
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    const tipo = p.tipo || 'OUTROS';
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(p);
  });

  const linhas = Object.keys(porTipo).sort().map(tipo => {
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#1a3a5c;font-size:13px;border-top:2px solid #1a3a5c">${tipo} — ${porTipo[tipo].length} matéria(s)</td></tr>`;
    const rows = porTipo[tipo].map(p =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#555;font-size:12px">${p.tipo || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee"><strong>${p.numero || '-'}/${p.ano || '-'}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa || '-'}</td>
      </tr>`
    ).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ CMFor — ${novas.length} nova(s) matéria(s)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left">Tipo</th>
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://sapl.fortaleza.ce.leg.br/materia/pesquisar-materia">sapl.fortaleza.ce.leg.br</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor CMFor" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ CMFor: ${novas.length} nova(s) matéria(s) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} matérias novas.`);
}

async function buscarPaginaMaterias(ano, page, pageSize) {
  const url = `${API_BASE}/materia/materialegislativa/?ano=${ano}&page=${page}&page_size=${pageSize}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`❌ Erro na API: ${response.status} ${response.statusText} em page=${page}`);
    return [];
  }
  const json = await response.json();
  return json.results || [];
}

async function buscarProposicoes() {
  const ano = new Date().getFullYear();
  const pageSize = 100;
  const primeiraUrl = `${API_BASE}/materia/materialegislativa/?ano=${ano}&page=1&page_size=${pageSize}`;

  console.log(`🔍 Buscando matérias de ${ano}...`);
  console.log(`📡 URL inicial: ${primeiraUrl}`);

  const primeiraResponse = await fetch(primeiraUrl);

  if (!primeiraResponse.ok) {
    console.error(`❌ Erro na API: ${primeiraResponse.status} ${primeiraResponse.statusText}`);
    return [];
  }

  const primeiraJson = await primeiraResponse.json();
  const total = primeiraJson.pagination?.total_entries || primeiraJson.count || (primeiraJson.results || []).length;
  const totalPaginas = Math.max(1, Math.ceil(Number(total) / pageSize));
  const paginas = Array.from(new Set([Math.max(1, totalPaginas - 1), totalPaginas]));

  console.log(`📦 Total no ano: ${total}; última página estimada: ${totalPaginas}`);

  if (CATCHUP_FROM) {
    console.log(`📥 Modo catch-up ativo desde ${CATCHUP_FROM}`);
    const resultados = [];
    for (let page = totalPaginas; page >= 1; page--) {
      const pagina = await buscarPaginaMaterias(ano, page, pageSize);
      resultados.push(...pagina.filter(item => String(item.data_apresentacao || '').slice(0, 10) >= CATCHUP_FROM));
      const datas = pagina
        .map(item => String(item.data_apresentacao || '').slice(0, 10))
        .filter(Boolean)
        .sort();
      if (datas[0] && datas[0] < CATCHUP_FROM) break;
    }
    const unicos = new Map();
    for (const item of resultados) {
      if (item && item.id) unicos.set(String(item.id), item);
    }
    const recentes = Array.from(unicos.values())
      .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    console.log(`📦 Catch-up coletado: ${recentes.length} matéria(s)`);
    return recentes;
  }

  console.log(`📡 Páginas recentes: ${paginas.join(', ')}`);

  const resultados = [];
  for (const page of paginas) {
    resultados.push(...await buscarPaginaMaterias(ano, page, pageSize));
  }

  const unicos = new Map();
  for (const item of resultados) {
    if (item && item.id) unicos.set(String(item.id), item);
  }
  const recentes = Array.from(unicos.values())
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))
    .slice(0, pageSize);

  console.log(`📦 Recebidos nas páginas recentes: ${resultados.length}; únicos: ${unicos.size}; monitorando últimos: ${recentes.length}`);
  return recentes;
}

function normalizarProposicao(p) {
  let tipo = 'OUTROS';
  if (p.__str__) {
    const match = p.__str__.match(/^(.+?)\s+n[ºo°]/i);
    if (match) tipo = match[1].trim().toUpperCase();
  }

  return {
    id: String(p.id),
    tipo,
    numero: p.numero || '-',
    ano: p.ano || '-',
    autor: '-',
    data: p.data_apresentacao || '-',
    ementa: (p.ementa || '-').substring(0, 200),
  };
}

(async () => {
  console.log('🚀 Iniciando monitor CMFor...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);
  if (CATCHUP_FROM) console.log(`📥 Catch-up solicitado desde ${CATCHUP_FROM}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas.map(String));

  const raw = await buscarProposicoes();

  if (raw.length === 0) {
    console.log('⚠️ Nenhuma matéria encontrada.');
    process.exit(0);
  }

  const proposicoes = raw.map(normalizarProposicao).filter(p => p.id);
  console.log(`📊 Total normalizado: ${proposicoes.length}`);

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Matérias novas: ${novas.length}`);

  if (novas.length > 0) {
    novas.sort((a, b) => {
      if (a.tipo < b.tipo) return -1;
      if (a.tipo > b.tipo) return 1;
      return (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0);
    });
    await enviarEmail(novas);
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
})();
