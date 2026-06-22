const fs = require('fs');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO_OVERRIDE || process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const API_BASE = 'https://sapl.fortaleza.ce.leg.br/api';
const CATCHUP_FROM = process.env.CATCHUP_FROM || '';
const BASELINE_ONLY = process.env.BASELINE_ONLY === '1';
const DRY_RUN = process.env.DRY_RUN === '1';
const PAGE_SIZE = 100;
const LATEST_PAGES = Number(process.env.LATEST_PAGES || 2);

const TIPOS_PRINCIPAIS = [
  { id: 1, sigla: 'PLO' },
  { id: 5, sigla: 'PLC' },
  { id: 6, sigla: 'PDL' },
  { id: 9, sigla: 'PEL' },
  { id: 13, sigla: 'PIP' },
  { id: 2, sigla: 'PRE' },
  { id: 4, sigla: 'REC' },
  { id: 11, sigla: 'VET' },
  { id: 10, sigla: 'MSG' },
  { id: 8, sigla: 'IND' },
  { id: 3, sigla: 'REQ' },
];

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO))
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function escaparHtml(valor) {
  return String(valor || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function montarUrlMateria(id) {
  return `https://sapl.fortaleza.ce.leg.br/materia/${encodeURIComponent(String(id))}`;
}

function prioridadeTipoEmail(tipo) {
  const t = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function compararTiposEmail(a, b) {
  const prioridadeA = prioridadeTipoEmail(a);
  const prioridadeB = prioridadeTipoEmail(b);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario', 'Boticário', 'Abrasel', 'ANBRASEL',
  'Energisa', 'EnergisaLuz', 'SABESP', 'COMGAS', 'COMGÁS', 'Eletromidia', 'Eletromídia',
  'BRT', 'Regenera', 'Nova Infra', 'Seta', 'SETA', 'AkzoNobel', 'Expedia', 'RTSC',
  'Huawei', 'Carrefour', 'JBS', 'Ajinomoto', 'Vibra', 'Mindlab', 'ABVTEX', 'Neoenergia', 'ENEL',
  'Equatorial', 'Equatorial Goiás', 'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'Equtorial'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}

async function enviarEmail(novas) {
  anotarClientesCitados(novas);
  const nodemailer = require('nodemailer');
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

  const linhas = Object.keys(porTipo).sort(compararTiposEmail).map(tipo => {
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#1a3a5c;font-size:13px;border-top:2px solid #1a3a5c">${tipo} — ${porTipo[tipo].length} matéria(s)</td></tr>`;
    const rows = porTipo[tipo].map(p =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#555;font-size:12px">${escaparHtml(p.tipo || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee"><strong><a href="${escaparHtml(p.url)}">${escaparHtml(p.numero || '-')}/${escaparHtml(p.ano || '-')}</a></strong></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${escaparHtml(p.autor || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${escaparHtml(p.data || '-')}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${renderizarEmentaCliente(p)}</td>
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
    subject: `🏛️ Fortaleza: ${novas.length} nova(s) matéria(s) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} matérias novas.`);
}

async function buscarPaginaMaterias(ano, page, pageSize, tipoId = null) {
  const url = new URL(`${API_BASE}/materia/materialegislativa/`);
  url.searchParams.set('ano', String(ano));
  url.searchParams.set('page', String(page));
  url.searchParams.set('page_size', String(pageSize));
  if (tipoId) url.searchParams.set('tipo', String(tipoId));

  const response = await fetch(url);
  if (!response.ok) {
    console.error(`❌ Erro na API: ${response.status} ${response.statusText} em page=${page}`);
    return { results: [], totalPaginas: 1, total: 0 };
  }
  const json = await response.json();
  const total = json.pagination?.total_entries || json.count || (json.results || []).length;
  const totalPaginas = json.pagination?.total_pages || Math.max(1, Math.ceil(Number(total) / pageSize));
  return { results: json.results || [], totalPaginas, total };
}

async function buscarUltimasPaginasPorTipo(ano, pageSize, tipoId, label) {
  const primeira = await buscarPaginaMaterias(ano, 1, pageSize, tipoId);
  const start = Math.max(1, primeira.totalPaginas - LATEST_PAGES + 1);
  const resultados = [];
  const paginas = [];

  for (let page = start; page <= primeira.totalPaginas; page++) {
    paginas.push(page);
    const pagina = page === 1 ? primeira : await buscarPaginaMaterias(ano, page, pageSize, tipoId);
    resultados.push(...pagina.results);
  }

  console.log(`📡 ${label}: páginas ${paginas.join(', ')} de ${primeira.totalPaginas}; recebidos ${resultados.length}`);
  return resultados;
}

async function buscarProposicoes() {
  const ano = new Date().getFullYear();
  const pageSize = PAGE_SIZE;
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

  console.log(`📦 Total no ano: ${total}; última página estimada: ${totalPaginas}`);

  if (CATCHUP_FROM) {
    console.log(`📥 Modo catch-up ativo desde ${CATCHUP_FROM}`);
    const resultados = [];
    for (let page = totalPaginas; page >= 1; page--) {
      const pagina = await buscarPaginaMaterias(ano, page, pageSize);
      resultados.push(...pagina.results.filter(item => String(item.data_apresentacao || '').slice(0, 10) >= CATCHUP_FROM));
      const datas = pagina.results
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

  const resultados = [];

  for (const tipo of TIPOS_PRINCIPAIS) {
    resultados.push(...await buscarUltimasPaginasPorTipo(ano, pageSize, tipo.id, tipo.sigla));
  }
  resultados.push(...await buscarUltimasPaginasPorTipo(ano, pageSize, null, 'GERAL'));

  const unicos = new Map();
  for (const item of resultados) {
    if (item && item.id) unicos.set(String(item.id), item);
  }
  const recentes = Array.from(unicos.values())
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));

  console.log(`📦 Recebidos nas janelas recentes: ${resultados.length}; únicos: ${unicos.size}; monitorando por tipo: ${recentes.length}`);
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
    ementa: (p.ementa || '-'),
    url: montarUrlMateria(p.id),
  };
}

(async () => {
  console.log('🚀 Iniciando monitor CMFor...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);
  if (CATCHUP_FROM) console.log(`📥 Catch-up solicitado desde ${CATCHUP_FROM}`);
  if (BASELINE_ONLY) console.log('🧭 Modo baseline ativo: marca matérias como vistas sem enviar email');

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

  if (novas.length > 0 && BASELINE_ONLY) {
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
    console.log(`🧭 Baseline atualizado com ${novas.length} matéria(s), sem envio.`);
  } else if (novas.length > 0 && DRY_RUN) {
    const amostra = novas.slice(0, 5).map(p => `${p.tipo} ${p.numero}/${p.ano} -> ${p.url}`).join('\n');
    console.log(`🧪 Dry-run ativo: email não enviado e estado não alterado. Amostra com links:\n${amostra}`);
  } else if (novas.length > 0) {
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
