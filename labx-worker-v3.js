/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  LAB-X 3.0 — Cloudflare Worker                              ║
 * ║  Motor de Data Intelligence — LABRIOLAG Holding             ║
 * ║  Integração: IBGE SIDRA · BCB SGS · Motor Vetorial 16D      ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * DEPLOY:
 *   wrangler deploy
 *
 * ENDPOINTS:
 *   GET  /health
 *   GET  /feed                    → Economic Feed (SELIC, IPCA, IBC-Br)
 *   GET  /ibge/:codMunicipio      → Dados municipais (CEMPRE + pop)
 *   POST /calcular                → Motor vetorial 16D + Rating MSCL
 *   POST /salvar                  → KV Storage
 *   GET  /historico               → Lista análises salvas
 *   GET  /analise/:id             → Buscar análise por ID
 *   DELETE /analise/:id           → Excluir análise
 */

// ─── CORS ────────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-LABX-Token",
  "Content-Type": "application/json",
};

// ─── CACHE TTL ────────────────────────────────────────────────────────────────
const TTL_BCB   = 60 * 60 * 4;    // 4 horas (dados macro)
const TTL_IBGE  = 60 * 60 * 24;   // 24 horas (dados CEMPRE)
const TTL_CALC  = 60 * 60 * 24 * 90; // 90 dias (análises)

// ─── SÉRIES BCB/SGS ──────────────────────────────────────────────────────────
const BCB_SERIES = {
  SELIC:  11,    // Taxa SELIC Over (% a.a.)
  IPCA:   433,   // IPCA (variação % mensal)
  IBCBR:  24363, // IBC-Br (proxy do PIB mensal, índice)
  CAMBIO: 1,     // USD/BRL (PTAX venda)
  IGP_M:  189,   // IGP-M (var. % mensal)
};

// ─── LIMITES HISTÓRICOS para Min-Max Scaling ─────────────────────────────────
// Baseados em dados históricos BR 2002-2025
const BOUNDS = {
  SELIC:  { min: 2.0,  max: 15.0 }, // % a.a.
  IPCA:   { min: 0.0,  max: 1.5  }, // % mensal
  IBCBR:  { min: 95.0, max: 145.0}, // índice
  empresas_pop: { min: 0.005, max: 0.12 }, // empresas/habitante
  pib_pc: { min: 5000, max: 80000 }, // R$
};

// ─── HELPER: Min-Max Normalization ─────────────────────────────────────────
function minmax(v, min, max) {
  return Math.max(0, Math.min(1, (v - min) / (max - min)));
}
function clamp(v) { return Math.max(0, Math.min(10, v)); }
function round2(v) { return Number(v.toFixed(2)); }
function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

// ─── FETCH BCB SGS ───────────────────────────────────────────────────────────
async function fetchBCB(serie, ultimos = 1) {
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${serie}/dados/ultimos/${ultimos}?formato=json`;
  const r = await fetch(url, { cf: { cacheTtl: TTL_BCB, cacheEverything: true } });
  if (!r.ok) throw new Error(`BCB ${serie} error ${r.status}`);
  const d = await r.json();
  return d[d.length - 1]; // { data, valor }
}

// ─── FETCH IBGE SIDRA ─────────────────────────────────────────────────────────
// Tabela 6321 = CEMPRE — empresas por município
async function fetchIBGEEmpresas(codMunicipio) {
  // SIDRA Tabela 6321: Total de empresas ativas por município
  const url = `https://apisidra.ibge.gov.br/values/t/6321/n6/${codMunicipio}/v/allxp/p/last%201/f/u`;
  const r = await fetch(url, { cf: { cacheTtl: TTL_IBGE, cacheEverything: true } });
  if (!r.ok) throw new Error(`IBGE SIDRA error ${r.status}`);
  const d = await r.json();
  // Resposta: array de objetos [{D1C, D2C, V, ...}]
  const row = d.find(x => x.V && x.V !== '-') || d[1];
  return row ? parseInt(row.V.replace(/\./g, ''), 10) || 0 : 0;
}

// IBGE Tabela 6579: Pessoal ocupado (com e sem vínculo) por município
async function fetchIBGEPessoal(codMunicipio) {
  const url = `https://apisidra.ibge.gov.br/values/t/6579/n6/${codMunicipio}/v/allxp/p/last%201/f/u`;
  const r = await fetch(url, { cf: { cacheTtl: TTL_IBGE, cacheEverything: true } });
  if (!r.ok) throw new Error(`IBGE Pessoal error ${r.status}`);
  const d = await r.json();
  const row = d.find(x => x.V && x.V !== '-') || d[1];
  return row ? parseInt(row.V.replace(/\./g, ''), 10) || 0 : 0;
}

// IBGE Estimativa populacional
async function fetchIBGEPopulacao(codMunicipio) {
  const url = `https://servicodados.ibge.gov.br/api/v3/agregados/6579/periodos/2023/variaveis/allxp?localidades=N6[${codMunicipio}]`;
  const r = await fetch(url, { cf: { cacheTtl: TTL_IBGE, cacheEverything: true } });
  if (!r.ok) {
    // Fallback: API de municipios
    const r2 = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/municipios/${codMunicipio}`);
    if (r2.ok) { const m = await r2.json(); return { nome: m.nome, pop: 50000 }; }
    return { nome: 'Município', pop: 50000 };
  }
  const d = await r.json();
  try {
    const val = d[0]?.resultados?.[0]?.series?.[0]?.serie?.['2022'] || '50000';
    return { nome: d[0]?.resultados?.[0]?.series?.[0]?.localidade?.nome || 'Município', pop: parseInt(val, 10) };
  } catch { return { nome: 'Município', pop: 50000 }; }
}

// ─── RATING MSCL ─────────────────────────────────────────────────────────────
/**
 * Matriz de Score Comparativo Labriolag (MSCL)
 *
 * Score = Pilar_Tracao(40%) + Pilar_Liquidez(35%) + Pilar_IAC(25%)
 *
 * Min-Max Scaling em todos os inputs para score 0-10.
 * Rating: AAA(≥9) | AA(≥8) | A(≥7) | B(≥6) | C(≥5) | D(≥3) | E(<3)
 */
function calcularRating({ empresas, populacao, rendaMedia, selic, ipca, ibcbr, iac }) {

  // ── Pilar A: Tração (IBGE CEMPRE) ────────────────────────────────────────
  const densEmp = empresas / Math.max(populacao, 1);
  const densNorm = minmax(densEmp, BOUNDS.empresas_pop.min, BOUNDS.empresas_pop.max);
  // Fator de crescimento setorial: IBC-Br acima de 120 = economia em expansão
  const ibcbrNorm = minmax(ibcbr || 120, BOUNDS.IBCBR.min, BOUNDS.IBCBR.max);
  const fatCrescimento = ibcbrNorm > 0.5 ? 1.15 : 1.0; // +15% bônus se economia crescendo
  const pilarTracao = clamp(densNorm * 10 * fatCrescimento);

  // ── Pilar B: Liquidez (BCB) ───────────────────────────────────────────────
  // Renda real: ajustada pela inflação
  const rendaReal = rendaMedia / (1 + (ipca || 0.5) / 100);
  // SELIC penaliza: quanto maior, menor o poder de expansão via crédito
  const selicPenalty = minmax(selic || 10, BOUNDS.SELIC.min, BOUNDS.SELIC.max);
  const fatorSELIC = 1 - (selicPenalty * 0.4); // até -40% penalidade
  const ipc = (rendaReal / 5000) * fatorSELIC;
  const pilarLiquidez = clamp(ipc * 10);

  // ── Pilar C: IAC (Motor Vetorial) ────────────────────────────────────────
  const pilarIAC = clamp(iac);

  // ── Score Final ───────────────────────────────────────────────────────────
  const score = round2(
    pilarTracao   * 0.40 +
    pilarLiquidez * 0.35 +
    pilarIAC      * 0.25
  );

  // ── Rating ────────────────────────────────────────────────────────────────
  let rating, desc;
  if      (score >= 9.0) { rating = 'AAA'; desc = 'Oceano Azul — Alta renda, baixa saturação'; }
  else if (score >= 8.0) { rating = 'AA';  desc = 'Expansão qualificada — Mercado receptivo'; }
  else if (score >= 7.0) { rating = 'A';   desc = 'Mercado em maturação — Ótimo para consolidação'; }
  else if (score >= 6.0) { rating = 'B';   desc = 'Mercado competitivo — Nicho necessário'; }
  else if (score >= 5.0) { rating = 'C';   desc = 'Saturação moderada — Renda estagnada'; }
  else if (score >= 3.0) { rating = 'D';   desc = 'Risco elevado — Baixa liquidez territorial'; }
  else                   { rating = 'E';   desc = 'Risco crítico — Não recomendado no momento'; }

  return {
    score,
    rating,
    desc,
    pilares: {
      tracao:   round2(pilarTracao),
      liquidez: round2(pilarLiquidez),
      iac:      round2(pilarIAC),
    },
    fatores: {
      densidadeEmpresas: round2(densEmp * 1000), // por mil habitantes
      fatCrescimento: round2(fatCrescimento),
      fatorSELIC:     round2(fatorSELIC),
      rendaReal:      Math.round(rendaReal),
    }
  };
}

// ─── MOTOR VETORIAL 16 DIREÇÕES ──────────────────────────────────────────────
function calcularVetores({ renda, cnpjs, populacao, pib, modo = 1.0, bcbData = {}, ibgeData = {} }) {
  const { selic = 10.5, ipca = 0.44, ibcbr = 118 } = bcbData;
  const { empresas = cnpjs * 100 } = ibgeData; // fallback se não veio do IBGE

  // Normalizações base
  const rN  = Math.min(renda / 5000, 1);
  const dN  = Math.min(cnpjs / 200, 1);
  const pN  = Math.min(populacao / 500000, 1);
  const gN  = Math.min(pib / 200, 1);

  // Índices derivados de dados reais
  const selicN  = minmax(selic, BOUNDS.SELIC.min, BOUNDS.SELIC.max);   // 0=baixa, 1=alta
  const ipcaN   = minmax(ipca,  0, 1.5);                               // 0=baixa, 1=alta
  const ibcN    = minmax(ibcbr, BOUNDS.IBCBR.min, BOUNDS.IBCBR.max);  // 0=recessão, 1=expansão

  // Saturação de mercado
  const sat = dN > 0.7 ? (dN - 0.7) * 3 : 0;
  const liq = (rN + gN) / 2;

  // Taxa de novos CNPJs vs. baixas (simulado até integração com Receita Federal)
  const inovFator = ibcN > 0.5 ? 1.1 : 0.9;

  // ── CARDINAIS ────────────────────────────────────────────────────────────
  const N_estrutura  = clamp((gN * 8 + pN * 2) * modo);
  // S agora alimentado por dados reais IBGE
  const S_dados      = clamp((dN * 5 + (ibgeData.pessoal ? Math.min(ibgeData.pessoal / 50000, 1) : dN) * 3 + rN * 2) * modo);
  const L_percepcao  = clamp(((1 - sat) * 6 + liq * 3 + ibcN * 1) * modo);
  const O_impacto    = clamp((rN * 4 + gN * 4 + (1 - selicN) * 2) * modo); // SELIC penaliza impacto

  // ── COLATERAIS ───────────────────────────────────────────────────────────
  const NE_estrategia = clamp(((N_estrutura + L_percepcao) / 2 * 0.9) * modo);
  // SE alimentado pelo PIB municipal (dado IBGE)
  const SE_mercado    = clamp((gN * 6 + ibcN * 2 + rN * 2) * 0.9 * modo);
  // SO: SELIC alta = risco de crédito sobe
  const SO_risco      = clamp((sat * 4 + selicN * 4 + (1 - liq) * 2) * 0.8 * modo);
  const NO_visao      = clamp(((N_estrutura + O_impacto) / 2 * 0.9) * modo);

  // ── SUBCOLATERAIS ────────────────────────────────────────────────────────
  const NNE_tecnica     = clamp(((NE_estrategia + N_estrutura) / 2 * 0.85) * modo);
  const ENE_psicologia  = clamp((liq * 6 + pN * 2 + (1 - ipcaN) * 2) * 0.8 * modo); // inflação afeta psicologia
  const ESE_engajamento = clamp((dN * 4 + rN * 3 + ibcN * 3) * 0.8 * modo);
  // SSE alimentado pelo IPCA e IBC-Br (BCB)
  const SSE_metricas    = clamp(((ibcN * 7 + (1 - ipcaN) * 3) * 0.85) * modo);
  // SSO: limitações correlacionadas com SELIC
  const SSO_limitacoes  = clamp((selicN * 5 + sat * 3 + (1 - gN) * 2) * 0.8 * modo);
  const OSO_competicao  = clamp((sat * 8 + dN * 2) * 0.8 * modo);
  // ONO: Inovação = taxa de novos CNPJs * fator IBC-Br
  const ONO_inovacao    = clamp(((NO_visao + NE_estrategia) / 2 * inovFator * 0.85) * modo);
  const NNO_identidade  = clamp(((N_estrutura * 0.5 + pN * 3 + ibcN * 1.5) * 0.8) * modo);

  const vetores = {
    N: round2(N_estrutura),   S: round2(S_dados),      L: round2(L_percepcao),  O: round2(O_impacto),
    NE: round2(NE_estrategia), SE: round2(SE_mercado),  SO: round2(SO_risco),   NO: round2(NO_visao),
    NNE: round2(NNE_tecnica), ENE: round2(ENE_psicologia), ESE: round2(ESE_engajamento), SSE: round2(SSE_metricas),
    SSO: round2(SSO_limitacoes), OSO: round2(OSO_competicao), ONO: round2(ONO_inovacao), NNO: round2(NNO_identidade),
  };

  // ── IAC ──────────────────────────────────────────────────────────────────
  const card = [N_estrutura, S_dados, L_percepcao, O_impacto];
  const cola = [NE_estrategia, SE_mercado, SO_risco, NO_visao];
  const sub  = [NNE_tecnica, ENE_psicologia, ESE_engajamento, SSE_metricas,
                SSO_limitacoes, OSO_competicao, ONO_inovacao, NNO_identidade];

  const iac = round2(avg(card) * 0.5 + avg(cola) * 0.3 + avg(sub) * 0.2);

  const entries = Object.entries(vetores);
  const dom = [...entries].sort((a, b) => b[1] - a[1])[0][0];
  const neg = entries.filter(([, v]) => v < 4).map(([k]) => k);
  const crit = entries.filter(([k, v]) => ['N','S','L','O','NE','SE','SO','NO'].includes(k) && v < 5).map(([k]) => k);

  // ── Rating MSCL ──────────────────────────────────────────────────────────
  const rating = calcularRating({
    empresas: ibgeData.empresas || cnpjs * 50,
    populacao,
    rendaMedia: renda,
    selic,
    ipca,
    ibcbr,
    iac,
  });

  return {
    vetores,
    iac,
    rating,
    diagnostico: {
      dominante: dom,
      negligenciadas: neg,
      criticas: crit,
      mediaGeral: round2(avg(Object.values(vetores))),
      score: iac >= 7 ? 'FORTE' : iac >= 4 ? 'EQUILIBRIO' : 'RISCO',
    },
    fontes: {
      selic:  round2(selic),
      ipca:   round2(ipca),
      ibcbr:  round2(ibcbr),
      empresas: ibgeData.empresas || null,
      pessoal:  ibgeData.pessoal  || null,
      populacao,
    },
    parametros: { renda, cnpjs, populacao, pib, modo },
    timestamp: new Date().toISOString(),
  };
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Auth helper ───────────────────────────────────────────────────────
    const SECRET = env.LABX_TOKEN || 'labx2026';
    function auth() {
      const t = request.headers.get('X-LABX-Token');
      return t === SECRET;
    }

    // ── GET /health ───────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return ok({ status: 'online', version: '3.0', engine: 'LAB-X Data Intelligence', ts: new Date().toISOString() });
    }

    // ── GET /feed — Economic Feed (BCB) ───────────────────────────────────
    if (url.pathname === '/feed') {
      // Cache no KV por 4h
      const cacheKey = 'feed:macro';
      if (env.LABX_KV) {
        const cached = await env.LABX_KV.get(cacheKey).catch(() => null);
        if (cached) return ok(JSON.parse(cached));
      }

      try {
        const [selicR, ipcaR, ibcbrR, cambioR] = await Promise.allSettled([
          fetchBCB(BCB_SERIES.SELIC,  1),
          fetchBCB(BCB_SERIES.IPCA,   1),
          fetchBCB(BCB_SERIES.IBCBR,  1),
          fetchBCB(BCB_SERIES.CAMBIO, 1),
        ]);

        const feed = {
          selic:  selicR.status  === 'fulfilled' ? selicR.value  : { data: '-', valor: '10.50' },
          ipca:   ipcaR.status   === 'fulfilled' ? ipcaR.value   : { data: '-', valor: '0.44'  },
          ibcbr:  ibcbrR.status  === 'fulfilled' ? ibcbrR.value  : { data: '-', valor: '118.0' },
          cambio: cambioR.status === 'fulfilled' ? cambioR.value : { data: '-', valor: '5.20'  },
          capturedAt: new Date().toISOString(),
        };

        if (env.LABX_KV) {
          await env.LABX_KV.put(cacheKey, JSON.stringify(feed), { expirationTtl: TTL_BCB });
        }
        return ok(feed);
      } catch (e) {
        return ok({ error: 'BCB unavailable', fallback: true, selic: { valor: '10.50' }, ipca: { valor: '0.44' }, ibcbr: { valor: '118.0' } });
      }
    }

    // ── GET /ibge/:codMunicipio ────────────────────────────────────────────
    if (url.pathname.startsWith('/ibge/') && request.method === 'GET') {
      const cod = url.pathname.replace('/ibge/', '').trim();
      if (!cod || !/^\d{7}$/.test(cod)) return err('Código IBGE inválido (7 dígitos)', 400);

      const cacheKey = `ibge:${cod}`;
      if (env.LABX_KV) {
        const cached = await env.LABX_KV.get(cacheKey).catch(() => null);
        if (cached) return ok(JSON.parse(cached));
      }

      try {
        const [empR, pesR, popR] = await Promise.allSettled([
          fetchIBGEEmpresas(cod),
          fetchIBGEPessoal(cod),
          fetchIBGEPopulacao(cod),
        ]);

        const data = {
          codMunicipio: cod,
          nome:      popR.status === 'fulfilled' ? popR.value.nome : 'Município',
          populacao: popR.status === 'fulfilled' ? popR.value.pop  : 50000,
          empresas:  empR.status === 'fulfilled' ? empR.value      : null,
          pessoal:   pesR.status === 'fulfilled' ? pesR.value      : null,
          fonte: 'IBGE CEMPRE/SIDRA',
          capturedAt: new Date().toISOString(),
        };

        if (env.LABX_KV) {
          await env.LABX_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: TTL_IBGE });
        }
        return ok(data);
      } catch (e) {
        return err('IBGE SIDRA indisponível: ' + e.message, 503);
      }
    }

    // ── POST /calcular ─────────────────────────────────────────────────────
    if (url.pathname === '/calcular' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!auth() && body.token !== SECRET) return err('Unauthorized', 401);

      const { renda = 0, cnpjs = 0, populacao = 50000, pib = 35, modo = 1.0, codMunicipio } = body;

      // Buscar dados reais em paralelo
      let bcbData = {}, ibgeData = {};
      const [bcbRes, ibgeRes] = await Promise.allSettled([
        // BCB feed (usa cache do KV se disponível)
        (async () => {
          if (env.LABX_KV) {
            const c = await env.LABX_KV.get('feed:macro').catch(()=>null);
            if (c) { const d = JSON.parse(c); return { selic: +d.selic.valor, ipca: +d.ipca.valor, ibcbr: +d.ibcbr.valor }; }
          }
          const [s, i, b] = await Promise.all([fetchBCB(BCB_SERIES.SELIC,1), fetchBCB(BCB_SERIES.IPCA,1), fetchBCB(BCB_SERIES.IBCBR,1)]);
          return { selic: +s.valor, ipca: +i.valor, ibcbr: +b.valor };
        })(),
        // IBGE por código de município
        codMunicipio && /^\d{7}$/.test(codMunicipio) ? (async () => {
          if (env.LABX_KV) {
            const c = await env.LABX_KV.get(`ibge:${codMunicipio}`).catch(()=>null);
            if (c) return JSON.parse(c);
          }
          const [empR, pesR] = await Promise.allSettled([fetchIBGEEmpresas(codMunicipio), fetchIBGEPessoal(codMunicipio)]);
          return { empresas: empR.status==='fulfilled' ? empR.value : null, pessoal: pesR.status==='fulfilled' ? pesR.value : null };
        })() : Promise.resolve({})
      ]);

      if (bcbRes.status === 'fulfilled')  bcbData  = bcbRes.value;
      if (ibgeRes.status === 'fulfilled') ibgeData = ibgeRes.value;

      const resultado = calcularVetores({
        renda: Number(renda), cnpjs: Number(cnpjs),
        populacao: Number(populacao), pib: Number(pib),
        modo: Number(modo), bcbData, ibgeData,
      });

      // Salvar no KV
      if (env.LABX_KV) {
        const key = `calc:${Date.now()}`;
        await env.LABX_KV.put(key, JSON.stringify(resultado), { expirationTtl: TTL_CALC });
        resultado.kvKey = key;
      }
      return ok(resultado);
    }

    // ── POST /salvar ───────────────────────────────────────────────────────
    if (url.pathname === '/salvar' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!auth() && body.token !== SECRET) return err('Unauthorized', 401);
      if (!env.LABX_KV) return err('KV not configured', 503);

      const id = body.id || `LAB-${Date.now().toString(36).toUpperCase()}`;
      const record = { ...body, id, savedAt: new Date().toISOString() };
      await env.LABX_KV.put(`analise:${id}`, JSON.stringify(record), { expirationTtl: TTL_CALC });
      return ok({ ok: true, id });
    }

    // ── GET /historico ─────────────────────────────────────────────────────
    if (url.pathname === '/historico') {
      if (!auth()) return err('Unauthorized', 401);
      if (!env.LABX_KV) return err('KV not configured', 503);

      const list = await env.LABX_KV.list({ prefix: 'analise:' });
      const ids = list.keys.map(k => k.name.replace('analise:', ''));

      // Carregar metadados (sem o payload completo)
      const meta = await Promise.all(
        ids.slice(0, 50).map(async id => {
          const raw = await env.LABX_KV.get(`analise:${id}`).catch(() => null);
          if (!raw) return null;
          const d = JSON.parse(raw);
          return { id: d.id, name: d.name, timestamp: d.timestamp, results: d.results, engine: d.engine };
        })
      );
      return ok({ total: ids.length, analyses: meta.filter(Boolean) });
    }

    // ── GET /analise/:id ───────────────────────────────────────────────────
    if (url.pathname.startsWith('/analise/') && request.method === 'GET') {
      if (!auth()) return err('Unauthorized', 401);
      if (!env.LABX_KV) return err('KV not configured', 503);

      const id = url.pathname.replace('/analise/', '');
      const raw = await env.LABX_KV.get(`analise:${id}`).catch(() => null);
      if (!raw) return err('Not found', 404);
      return ok(JSON.parse(raw));
    }

    // ── DELETE /analise/:id ────────────────────────────────────────────────
    if (url.pathname.startsWith('/analise/') && request.method === 'DELETE') {
      if (!auth()) return err('Unauthorized', 401);
      if (!env.LABX_KV) return err('KV not configured', 503);

      const id = url.pathname.replace('/analise/', '');
      await env.LABX_KV.delete(`analise:${id}`);
      return ok({ ok: true, deleted: id });
    }

    return err('Not found', 404);
  }
};

// ─── RESPONSE HELPERS ────────────────────────────────────────────────────────
function ok(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS_HEADERS });
}
function err(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers: CORS_HEADERS });
}
