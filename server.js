const express = require('express');
const oracledb = require('oracledb');
const cors = require('cors');
const csv = require('fast-csv');
const path = require('path');
const app = express();
const fs = require('fs-extra'); 
const PORT = 3300;

app.use(cors());

const dbConfig = {
  user: 'consultadebx',
  password: 'olsadeb2025',
  connectString: '10.109.132.163:1521/ORCL.MAGNA.GLOBAL'
};

// ==========================================
// ROTAS OLSA (SCHEMA: olsa / OLSA)
// ==========================================

/**
 * FUNÇÃO AUXILIAR DE CONSULTA MERGE (Lógica unificada para MLB e JARINU)
 * Executa o SQL exatamente como fornecido, aplicando o prefixo do schema.
 */
// ==========================================
// FUNÇÃO AUXILIAR DE CONSULTA MERGE (Lógica unificada para MLB e JARINU)
// ==========================================
async function executarConsultaMerge(schema, startDate, endDate, labelPlanta) {
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig);

        // 1. Busca Operações da Rotina (Usando F_ROTINA que é mais estável)
        const queryRotina = `
            SELECT ROT_ROTEIR, ROT_CODPRO, ROT_N_OPER 
            FROM ${schema}.F_ROTINA 
            WHERE ROT_N_OPER > 0
        `;

        // 2. Query Principal de Produção (Kardex)
        // SQL adaptado para usar F_ROTINA no lugar de F_ROTVER para evitar ORA-00942
        const queryKardex = `
            SELECT 
                K.KAR_CODPRO AS PRODUTO, P.PRO_DESCRI AS DESCRICAO, K.KAR_DATMOV AS DATA, K.KAR_QTDMOV AS QUANTIDADE,
                K.KAR_NUMDOC AS ORDEM_PROD, O.COF_ROTEIR AS ROT, K.KAR_CODSEQ AS OP,
                ROUND(NVL(K.KAR_QTDMOV, 0) / DECODE(NVL(R.ROT_PROHOR, 0), 0, 1, R.ROT_PROHOR), 5) AS TEMPO,
                M.MAQ_CODIGO AS MAQUINA, M.MAQ_DESCRI AS DESC_MAQUINA, 
                C.CEL_DESCRI AS DESC_C_CUSTO, C.CEL_CCUSTO AS C_CUSTO, P.PRO_GRPROD AS GRUPO
            FROM ${schema}.F_KARDEX K
            INNER JOIN ${schema}.F_PRODS P ON P.PRO_CODPRO = K.KAR_CODPRO
            LEFT JOIN ${schema}.F_OF O ON O.COF_CODIOF = K.KAR_NUMDOC
            LEFT JOIN ${schema}.F_ROTINA R ON (R.ROT_CODPRO = K.KAR_CODPRO AND R.ROT_ROTEIR = O.COF_ROTEIR)
            LEFT JOIN ${schema}.F_MAQUINA M ON M.MAQ_CODIGO = R.ROT_CODMAQ
            LEFT JOIN ${schema}.F_CELULA C ON C.CEL_CODCEL = M.MAQ_CELULA
            WHERE K.KAR_DATMOV BETWEEN TO_DATE(:sd, 'YYYY-MM-DD') AND TO_DATE(:ed, 'YYYY-MM-DD')
              AND K.KAR_TIPMOV = 'EAC'
            ORDER BY K.KAR_CODPRO, K.KAR_DATMOV
        `;

        const rotinaRes = await connection.execute(queryRotina, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const kardexRes = await connection.execute(queryKardex, { sd: startDate, ed: endDate }, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        const rotinaMap = {};
        rotinaRes.rows.forEach(r => {
            if (!rotinaMap[r.ROT_ROTEIR]) rotinaMap[r.ROT_ROTEIR] = {};
            rotinaMap[r.ROT_ROTEIR][r.ROT_CODPRO] = r.ROT_N_OPER;
        });

        return kardexRes.rows.map(row => {
            const nroOp = rotinaMap[row.ROT]?.[row.PRODUTO] || 1;
            return {
                Planta: labelPlanta,
                Produto: row.PRODUTO,
                Descricao: row.DESCRICAO,
                Data: row.DATA,
                Quantidade: row.QUANTIDADE,
                OF: row.ORDEM_PROD,
                Rot: row.ROT || "S/R",
                Op: row.OP || "0",
                "HH GERADA": row.TEMPO * nroOp,
                Maquina: row.MAQUINA,
                Desc_Maquina: row.DESC_MAQUINA,
                Desc_C_Custo: row.DESC_C_CUSTO || "NÃO MAPEADO",
                C_Custo: row.C_CUSTO,
                Grupo: row.GRUPO
            };
        });
    } catch (err) {
        console.error(`⚠️ Falha na planta ${labelPlanta} (${schema}):`, err.message);
        return []; // Retorna lista vazia para não quebrar o dashboard global
    } finally {
        if (connection) await connection.close();
    }
}

// --- ENDPOINTS ---

app.get('/api/merge/all', async (req, res) => {
    const { start, end } = req.query;
    console.log(`\n🔍 [GLOBAL] Iniciando busca unificada: ${start} até ${end}`);
    const dataMLB = await executarConsultaMerge('olsa', start, end, 'MLB');
    const dataMJN = await executarConsultaMerge('MAGNA_JARINU', start, end, 'MJN');
    const total = [...dataMLB, ...dataMJN];
    console.log(`✅ [GLOBAL] Enviando ${total.length} registros totais.`);
    res.json(total);
});

app.get('/api/merge', async (req, res) => {
    res.json(await executarConsultaMerge('olsa', req.query.start, req.query.end, 'MLB'));
});

app.get('/api/jarinu/merge', async (req, res) => {
    res.json(await executarConsultaMerge('MAGNA_JARINU', req.query.start, req.query.end, 'MJN'));
});


app.get('/api/refugo', async (req, res) => {
  let connection;
  const start = req.query.start;
  const end = req.query.end;
  if (!start || !end) {
    return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios no formato YYYY-MM-DD' });
  }
  try {
    connection = await oracledb.getConnection(dbConfig);
    const query = `
      SELECT *
      FROM (
        SELECT   
          PRODUTO_FINAL     AS "Prod.Final",
          VDESCRI           AS "Desc.Prod.Final",
          VUNIMED           AS "UN.F",
          PRT_NEGOCIO       AS "Negocio",
          PRT_TIPOPRO       AS "Tipo Prod.",
          PRT_PROJETO       AS "Projeto",
          DATREF            AS "Data",
          CODTUR            AS "Tur.",
          CODMAQ            AS "Maquina",
          CODPRO            AS "Material",
          PRO_DESCRI        AS "Desc. Material",
          PRO_UNIMED        AS "Un.M.",
          CODIOF            AS "O.F.",
          IND               AS "IND",
          MOTREF            AS "Ref.",
          TBL_DESCRI        AS "Motivo Refugo",
          REFTOT            AS "Qtde Ref.",
          (REFTOT * NVL(CUSFINAL, PRMEDI)) AS "Valor Ref.",
          CEL_DESCRI        AS "Celula"
          FROM olsa.ALJ_V_PROD_TOPICOS,
               olsa.F_MAQUINA,
               olsa.F_CELULA,
               (
                 SELECT DATREF, CODTUR, CODMAQ, CODPRO, PRO_DESCRI, PRO_UNIMED, CODIOF, CUSFINAL,
                        PRO_PRMEDI PRMEDI, NVL(PRO_COMP09, PRO_CODPRO) PRODUTO_FINAL, SUBSTR(INDICE, 1, 3) IND,
                        MOTREF, TBL_DESCRI, SUM(QTDREF) REFTOT
                   FROM olsa.F_TABELAS,
                        olsa.F_PRODS,
                        (
                          SELECT RFG_DT_RFG DATREF, RFG_CODPRO CODPRO, 
                                 RFG_QT_RFG QTDREF, RFG_CODREF MOTREF,
                                 'REF' || LPAD(TO_CHAR(RFG_CODIGO), 6, '0') INDICE,
                                 RFG_CODIGO CODIGO, RFG_CODIOF CODIOF,
                                 ROF_CODMAQ CODMAQ, RFG_CODTUR CODTUR
                            FROM olsa.F_ROTOF,
                                 olsa.F_REFUGO
                           WHERE ROF_CODIOF = RFG_CODIOF
                             AND ROF_CODSEQ = RFG_CODSEQ
                          UNION ALL
                          SELECT OFS_DTLANC DATREF, OFS_CODPRO CODPRO,
                                 OFS_QTDPRO QTDREF, OFS_CODMOT MOTREF,
                                 'OFS' || TO_CHAR(OFS_CODIGO) INDICE,
                                 TO_CHAR(OFS_CODIGO) CODIGO, OFS_CODIOF CODIOF,
                                 ROF_CODMAQ CODMAQ, OFS_CODTUR CODTUR
                            FROM olsa.F_ROTOF,
                                 olsa.F_OFSUCATA
                           WHERE ROF_CODIOF(+) = OFS_CODIOF
                             AND ROF_CODSEQ(+) = OFS_CODSEQ
                          UNION ALL
                          SELECT SUC_DATSUC DATREF, SUC_CODPRO CODPRO,
                                 SUC_QTDPRO QTDREF, SUC_MOTIVO MOTREF,
                                 'SUC' || TO_CHAR(SUC_CODIGO) INDICE,
                                 TO_CHAR(SUC_CODIGO) CODIGO, NULL CODIOF,
                                 'SUCATA' CODMAQ, SUC_CODTUR CODTUR
                            FROM olsa.F_SUCATA
                          UNION ALL
                          SELECT KAR_DATMOV DATREF, KAR_CODPRO CODPRO,
                                 KAR_QTDMOV * -1 QTDREF, 100 MOTREF,
                                 KAR_INDICE CODIGO, 
                                 KAR_CODIGO CODIGO, NULL CODIOF,
                                 'RETRABALHO' CODMAQ, KAR_CODTUR CODTUR
                            FROM olsa.F_KARDEX
                           WHERE SUBSTR(KAR_INDICE, 1, 3) IN ('DEV','ASG','SUC', 'REF', 'OFS','RCO','RFG')
                             AND KAR_TIPMOV = 'DM'
                        ),
                        (
                          SELECT DCI_ANOMES, DCI_CODPRO, SUM(DCI_VLRCUS) CUSFINAL
                            FROM olsa.F_DETCUSINT
                           WHERE SUBSTR(DCI_CODPRO, 1, 3) <> 'SUC'
                           GROUP BY DCI_ANOMES, DCI_CODPRO
                        )
                 WHERE DATREF BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
                   AND TBL_CODTAB(+) = MOTREF
                   AND PRO_CODPRO = CODPRO
                   AND DCI_CODPRO(+) = CODPRO
                   AND DCI_ANOMES(+) = TO_CHAR(ADD_MONTHS(DATREF, -1), 'YYYYMM')
                 GROUP BY DATREF, CODTUR, CODMAQ, CODPRO, PRO_DESCRI, PRO_UNIMED,
                          PRO_PRMEDI, NVL(PRO_COMP09, PRO_CODPRO),
                          MOTREF, TBL_DESCRI, CUSFINAL, SUBSTR(INDICE, 1, 3), CODIOF
               )
         WHERE VCODPRO = PRODUTO_FINAL  
           AND MAQ_CODIGO = CODMAQ
           AND CEL_CODCEL = MAQ_CELULA
      )
    `;
    const binds = { startDate: start, endDate: end };
    const result = await connection.execute(query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) {
    console.error('Erro na rota /api/refugo:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error('Erro ao fechar conexão:', err); }
    }
  }
});

app.get('/api/sucata', async (req, res) => {
  let connection;
  const start = req.query.start;
  const end = req.query.end;
  if (!start || !end) {
    return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios no formato YYYY-MM-DD' });
  }
  try {
    connection = await oracledb.getConnection(dbConfig);
    const query = `
      WITH REFUGO_BASE AS (
        SELECT RFG_DT_RFG AS DATREF, RFG_CODPRO AS CODPRO, RFG_QT_RFG AS QTDREF, RFG_CODREF AS MOTREF,
               'REF' || LPAD(TO_CHAR(RFG_CODIGO), 6, '0') AS INDICE, TO_CHAR(RFG_CODIGO) AS CODIGO,
               RFG_CODIOF AS CODIOF, ROF_CODMAQ AS CODMAQ, RFG_CODTUR AS CODTUR
          FROM OLSA.F_ROTOF
               JOIN OLSA.F_REFUGO ON ROF_CODIOF = RFG_CODIOF AND ROF_CODSEQ = RFG_CODSEQ
         WHERE RFG_DT_RFG BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
        UNION ALL
        SELECT OFS_DTLANC, OFS_CODPRO, OFS_QTDPRO, OFS_CODMOT,
               'OFS' || TO_CHAR(OFS_CODIGO), TO_CHAR(OFS_CODIGO),
               OFS_CODIOF, ROF_CODMAQ, OFS_CODTUR
          FROM OLSA.F_OFSUCATA
               LEFT JOIN OLSA.F_ROTOF ON ROF_CODIOF = OFS_CODIOF AND ROF_CODSEQ = OFS_CODSEQ
         WHERE OFS_DTLANC BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
        UNION ALL
        SELECT SUC_DATSUC, SUC_CODPRO, SUC_QTDPRO, SUC_MOTIVO,
               'SUC' || TO_CHAR(SUC_CODIGO), TO_CHAR(SUC_CODIGO),
               NULL, 'SUCATA', SUC_CODTUR
          FROM OLSA.F_SUCATA
         WHERE SUC_DATSUC BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
        UNION ALL
        SELECT KAR_DATMOV, KAR_CODPRO, KAR_QTDMOV * -1, 100,
               KAR_INDICE, TO_CHAR(KAR_CODIGO),
               NULL, 'RETRABALHO', KAR_CODTUR
          FROM OLSA.F_KARDEX
         WHERE SUBSTR(KAR_INDICE, 1, 3) IN ('DEV', 'ASG', 'SUC', 'REF', 'OFS', 'RCO', 'RFG')
           AND KAR_TIPMOV = 'DM'
           AND KAR_DATMOV BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
      )
      SELECT
        NVL(p.PRO_COMP09, r.CODPRO) AS "Prod.Final",
        v.VDESCRI AS "Desc.Prod.Final",
        v.VUNIMED AS "UN.F",
        v.PRT_NEGOCIO AS "Negocio",
        v.PRT_TIPOPRO AS "Tipo Prod.",
        v.PRT_PROJETO AS "Projeto",
        r.DATREF AS "Data",
        r.CODTUR AS "Tur.",
        r.CODMAQ AS "Maquina",
        r.CODPRO AS "Material",
        p.PRO_DESCRI AS "Desc. Material",
        p.PRO_UNIMED AS "Un.M.",
        r.CODIOF AS "O.F.",
        SUBSTR(r.INDICE, 1, 3) AS "IND",
        r.MOTREF AS "Ref.",
        t.TBL_DESCRI AS "Motivo Refugo",
        r.QTDREF AS "Qtde Ref.",
        r.QTDREF * NVL(c.CUSFINAL, p.PRO_PRMEDI) AS "Valor Ref.",
        cel.CEL_DESCRI AS "Celula"
      FROM REFUGO_BASE r
           JOIN OLSA.F_PRODS p ON p.PRO_CODPRO = r.CODPRO
           JOIN OLSA.ALJ_V_PROD_TOPICOS v ON v.VCODPRO = NVL(p.PRO_COMP09, r.CODPRO)
           LEFT JOIN OLSA.F_TABELAS t ON t.TBL_CODTAB = r.MOTREF
           LEFT JOIN OLSA.F_MAQUINA m ON m.MAQ_CODIGO = r.CODMAQ
           LEFT JOIN OLSA.F_CELULA cel ON cel.CEL_CODCEL = m.MAQ_CELULA
           LEFT JOIN (
              SELECT DCI_ANOMES, DCI_CODPRO, SUM(DCI_VLRCUS) AS CUSFINAL
                FROM OLSA.F_DETCUSINT
               WHERE SUBSTR(DCI_CODPRO, 1, 3) <> 'SUC'
               GROUP BY DCI_ANOMES, DCI_CODPRO
            ) c ON c.DCI_CODPRO = r.CODPRO AND c.DCI_ANOMES = TO_CHAR(ADD_MONTHS(r.DATREF, -1), 'YYYYMM')
    `;
    const binds = { startDate: start, endDate: end };
    const result = await connection.execute(query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) {
    console.error('Erro na rota /api/sucata:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error('Erro ao fechar conexão:', err); }
    }
  }
});

app.get('/api/scrap', async (req, res) => {
  let connection;
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios' });
  }
  const MAPA_SETOR = {
    Retrabalho: ['RETRABALHO'],
    Metalizacao: ["S.MT01", "S.MT02", "S.MT03", "S.MT04"],
    Pintura: ["S.HC01"],
    Injecao: [
      "S.I01H1K160", "S.I02H1K200", "S.I03H1K100", "S.I04H1K120", "S.I05H1K65", "S.I06H1K150", "S.I07H1K150", "S.I08H1K65", "S.I09H1K86", "S.I10H1K220",
      "S.I11H1K120", "S.I12H1K120", "S.I13H1K320", "S.I14H1K160", "S.I15H1K140", "S.I16H1K200", "S.I17H1K220", "S.I18H1K220", "S.I19H1K220", "S.I20H1K320",
      "S.I21H1K530", "S.I22H1K1300", "S.I23H3K1000", "S.I24H1K1300", "S.I25H3K1000", "S.I26H1K530", "S.I27H2K1000", "S.I28H1K320", "S.I29H1K1300", "S.I30H2K1700",
      "S.I31H2K1000", "S.I32H1K1000", "S.I33H2K1000", "S.I34H1K1300"
    ],
    MontagemLanternas: ["S.LA01ST", "S.LA02ST", "S.LA03GM", "S.LA04GM", "S.LA05GM", "S.LA06GM", "S.LA07RE", "S.LA08RE", "S.LA09VW", "S.LA010ST"],
    MontagemSmall: [
      "S.SM01VW", "S.SM02VW", "S.SM03VW", "S.SM04M", "S.SM05MT", "S.SM06TY", "S.SM07ST", "S.SM08ST", "S.SM09ST", "S.SM10ST", "S.SM11ST",
      "S.SM12NI", "S.SM13ST", "S.SM14ST", "S.SM15VW", "S.SM16MT", "S.SM17HO", "S.SM18VW", "S.SM19ST", "S.SM20GM", "S.SC21VW", "S.SC22VW"
    ]
  };
  const REVERSO_MAPA_SETOR = {};
  Object.entries(MAPA_SETOR).forEach(([setor, maquinas]) => maquinas.forEach(m => REVERSO_MAPA_SETOR[m.toUpperCase()] = setor));
  const MAPA_FF = { FF1: 'MontagemLanternas', FF2: 'MontagemSmall', FF3: 'Injecao', FF4: ['Metalizacao', 'Pintura'] };
  const REVERSO_MAPA_FF = {};
  Object.entries(MAPA_FF).forEach(([ff, setores]) => (Array.isArray(setores) ? setores : [setores]).forEach(s => REVERSO_MAPA_FF[s] = ff));
  try {
    connection = await oracledb.getConnection(dbConfig);
    const query = `
      WITH 
      RAW_MOVEMENTS AS (
          SELECT 
            RFG.RFG_DT_RFG AS DATREF, RFG.RFG_CODIOF AS CODIOF, RFG.RFG_CODPRO AS CODPRO, RFG.RFG_QT_RFG AS QTD,
            RFG.RFG_CODREF AS MOTREF, 'REF' AS INDICE, 'REF' AS TIPO_MOV, ROF.ROF_CODMAQ AS CODMAQ, RFG.RFG_CODTUR AS CODTUR
          FROM olsa.F_ROTOF ROF 
          JOIN olsa.F_REFUGO RFG ON ROF.ROF_CODIOF = RFG.RFG_CODIOF AND ROF.ROF_CODSEQ = RFG.RFG_CODSEQ 
          WHERE RFG.RFG_DT_RFG BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD') AND RFG.RFG_QT_RFG <> 0
          UNION ALL
          SELECT 
            OFS.OFS_DTLANC, OFS.OFS_CODIOF, OFS.OFS_CODPRO, OFS.OFS_QTDPRO,
            OFS.OFS_CODMOT, 'OFS' AS INDICE, 'OFS', ROF.ROF_CODMAQ, OFS.OFS_CODTUR
          FROM olsa.F_OFSUCATA OFS
          LEFT JOIN olsa.F_ROTOF ROF ON OFS.OFS_CODIOF = ROF.ROF_CODIOF AND OFS.OFS_CODSEQ = ROF.ROF_CODSEQ 
          WHERE OFS.OFS_DTLANC BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD') AND OFS.OFS_QTDPRO <> 0
          UNION ALL
          SELECT 
            SUC.SUC_DATSUC, TO_CHAR(SUC.SUC_CODIGO), SUC.SUC_CODPRO, SUC.SUC_QTDPRO,
            SUC.SUC_MOTIVO, 'SUC' AS INDICE, 'SUC', 'SUCATA', SUC.SUC_CODTUR
          FROM olsa.F_SUCATA SUC
          WHERE SUC.SUC_DATSUC BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD') AND SUC.SUC_QTDPRO <> 0
          UNION ALL
          SELECT 
            KAR.KAR_DATMOV, KAR.KAR_NUMDOC, KAR.KAR_CODPRO, KAR.KAR_QTDMOV * -1, 
            100, KAR.KAR_INDICE, 'DM', 'RETRABALHO', KAR.KAR_CODTUR
          FROM olsa.F_KARDEX KAR
          WHERE SUBSTR(KAR.KAR_INDICE, 1, 3) = 'DEV' 
            AND KAR.KAR_TIPMOV = 'DM' 
            AND KAR.KAR_DATMOV BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD') AND KAR.KAR_QTDMOV <> 0
      )
      SELECT 
          MOV.DATREF          AS "Data",
          NVL(P.PRO_COMP09, P.PRO_CODPRO) AS "Prod.Final",
          VTP.VDESCRI         AS "Desc.Prod.Final",
          MOV.CODIOF          AS "O.F.",
          CEL.CEL_DESCRI      AS "Celula",
          MOV.CODMAQ          AS "Cod. Maquina",
          MAQ.MAQ_DESCRI      AS "Maquina",
          MOV.CODPRO          AS "Material",
          P.PRO_DESCRI        AS "Desc. Material",
          VTP.VUNIMED         AS "UN.F",
          VTP.PRT_NEGOCIO     AS "Negocio",
          VTP.PRT_TIPOPRO     AS "Tipo Prod.",
          VTP.PRT_PROJETO     AS "Projeto",
          MOV.CODTUR          AS "Tur.",
          P.PRO_UNIMED        AS "Un.M.",
          MOV.INDICE          AS "IND",
          MOV.MOTREF          AS "Ref.",
          TBL.TBL_DESCRI      AS "Motivo Refugo",
          SUM(CASE WHEN MOV.TIPO_MOV IN ('REF', 'OFS') THEN MOV.QTD ELSE 0 END) AS "Qtd_SPR",
          SUM(CASE WHEN MOV.TIPO_MOV = 'SUC' THEN MOV.QTD ELSE 0 END) AS "Qtd_SCI",
          SUM(CASE WHEN MOV.TIPO_MOV = 'DM'  THEN MOV.QTD ELSE 0 END) AS "Qtd_DM",
          SUM(CASE WHEN MOV.TIPO_MOV IN ('REF', 'OFS') THEN MOV.QTD * NVL(C.CUSFINAL, P.PRO_PRMEDI) ELSE 0 END) AS "Val_SPR",
          SUM(CASE WHEN MOV.TIPO_MOV = 'SUC' THEN MOV.QTD * NVL(C.CUSFINAL, P.PRO_PRMEDI) ELSE 0 END) AS "Val_SCI",
          SUM(CASE WHEN MOV.TIPO_MOV = 'DM'  THEN MOV.QTD * NVL(C.CUSFINAL, P.PRO_PRMEDI) ELSE 0 END) AS "Val_DM",
          SUM(MOV.QTD) AS "Qtde_Total",
          SUM(MOV.QTD * NVL(C.CUSFINAL, P.PRO_PRMEDI)) AS "Valor_Total"
      FROM RAW_MOVEMENTS MOV
      JOIN olsa.F_PRODS P ON P.PRO_CODPRO = MOV.CODPRO
      LEFT JOIN (
          SELECT DCI_ANOMES, DCI_CODPRO, SUM(DCI_VLRCUS) AS CUSFINAL 
          FROM olsa.F_DETCUSINT 
          GROUP BY DCI_ANOMES, DCI_CODPRO
      ) C ON C.DCI_CODPRO = P.PRO_CODPRO AND C.DCI_ANOMES = TO_CHAR(ADD_MONTHS(MOV.DATREF, -1), 'YYYYMM')
      LEFT JOIN olsa.ALJ_V_PROD_TOPICOS VTP ON VTP.VCODPRO = NVL(P.PRO_COMP09, P.PRO_CODPRO)
      LEFT JOIN olsa.F_MAQUINA MAQ ON MAQ.MAQ_CODIGO = MOV.CODMAQ
      LEFT JOIN olsa.F_CELULA CEL ON CEL.CEL_CODCEL = MAQ.MAQ_CELULA
      LEFT JOIN olsa.F_TABELAS TBL ON TBL.TBL_CODTAB = MOV.MOTREF
      GROUP BY 
          MOV.DATREF, NVL(P.PRO_COMP09, P.PRO_CODPRO), VTP.VDESCRI, MOV.CODIOF, 
          CEL.CEL_DESCRI, MOV.CODMAQ, MAQ.MAQ_DESCRI, MOV.CODPRO, P.PRO_DESCRI,
          VTP.VUNIMED, VTP.PRT_NEGOCIO, VTP.PRT_TIPOPRO, VTP.PRT_PROJETO, 
          MOV.CODTUR, P.PRO_UNIMED, MOV.INDICE, MOV.MOTREF, TBL.TBL_DESCRI
      ORDER BY MOV.DATREF, MOV.CODIOF
    `;
    const binds = { startDate: start, endDate: end };
    const result = await connection.execute(query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const processedRows = result.rows.map(row => {
      if (row["Data"] instanceof Date) {
        row["Data"] = row["Data"].toISOString().slice(0, 10);
      }
      const setor = REVERSO_MAPA_SETOR[(row["Cod. Maquina"] || '').toUpperCase()] || "Outros";
      row["Setor"] = setor;
      row["FF"] = REVERSO_MAPA_FF[setor] || "Sem Cadastro";
      return row;
    });
    res.json(processedRows);
  } catch (err) {
    console.error('Erro na rota /api/scrap:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error('Erro ao fechar conexão:', err); }
    }
  }
});

app.get('/api/faturamento', async (req, res) => {
  let connection;
  const start = req.query.start;
  const end = req.query.end;
  if (!start || !end) {
    return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios no formato YYYY-MM-DD' });
  }
  try {
    connection = await oracledb.getConnection(dbConfig);
    const query = `
      SELECT * FROM (
        SELECT MOV_CODEMP, EMP_ERAZAO, MOV_NTFISC, MOV_DATMOV,
               SUM(MOV_VALTOT - MOV_VALICM - MOV_VALPIS - MOV_COFINS) AS VALLIQ,
               SUM(MOV_VALTOT - MOV_VALICM) AS VALMERC,
               SUM(MOV_VALICM) AS VALICM,
               SUM(MOV_VALIPI) AS VALIPI,
               SUM(MOV_VALTOT + MOV_VALIPI) AS VALTOT
        FROM olsa.F_CDEMP, olsa.F_MOVTO, olsa.F_PRODS, olsa.F_TIPMOV, olsa.F_TPPROD
        WHERE MOV_DATMOV >= TO_DATE(:startDate, 'YYYY-MM-DD')
          AND MOV_DATMOV <= TO_DATE(:endDate, 'YYYY-MM-DD')
          AND PRO_CODPRO = MOV_CODPRO
          AND TPP_CODIGO = PRO_TPPROD
          AND TPM_CODIGO = MOV_TIPMOV
          AND TPM_CUSMAT = 'F'
          AND TPM_ENTSAI = 'S'
          AND PRO_LOCEST IS NOT NULL
          AND TPP_TIPPRO IN ('A','M','D')
          AND EMP_CODEMP = MOV_CODEMP
        GROUP BY MOV_CODEMP, EMP_ERAZAO, MOV_NTFISC, MOV_DATMOV
      )
      ORDER BY MOV_DATMOV, MOV_NTFISC
    `;
    const binds = { startDate: start, endDate: end };
    const result = await connection.execute(query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) {
    console.error('Erro na rota /api/faturamento:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error('Erro ao fechar conexão:', err); }
    }
  }
});

app.get('/api/scrap/summary/monthly', async (req, res) => {
  let connection;
  const { year, ...filters } = req.query;
  if (!year) {
    return res.status(400).json({ error: 'Parâmetro year é obrigatório' });
  }
  const MAPA_SETOR = {
    Retrabalho: ['RETRABALHO'], Metalizacao: ["S.MT01", "S.MT02", "S.MT03", "S.MT04"],
    Pintura: ["S.HC01"], Injecao: ["S.I01H1K160", "S.I02H1K200", "S.I03H1K100", "S.I04H1K120", "S.I05H1K65", "S.I06H1K150", "S.I07H1K150", "S.I08H1K65", "S.I09H1K86", "S.I10H1K220", "S.I11H1K120", "S.I12H1K120", "S.I13H1K320", "S.I14H1K160", "S.I15H1K140", "S.I16H1K200", "S.I17H1K220", "S.I18H1K220", "S.I19H1K220", "S.I20H1K320", "S.I21H1K530", "S.I22H1K1300", "S.I23H3K1000", "S.I24H1K1300", "S.I25H3K1000", "S.I26H1K530", "S.I27H2K1000", "S.I28H1K320", "S.I29H1K1300", "S.I30H2K1700", "S.I31H2K1000", "S.I32H1K1000", "S.I33H2K1000", "S.I34H1K1300"],
    MontagemLanternas: ["S.LA01ST", "S.LA02ST", "S.LA03GM", "S.LA04GM", "S.LA05GM", "S.LA06GM", "S.LA07RE", "S.LA08RE", "S.LA09VW", "S.LA010ST"],
    MontagemSmall: ["S.SM01VW", "S.SM02VW", "S.SM03VW", "S.SM04M", "S.SM05MT", "S.SM06TY", "S.SM07ST", "S.SM08ST", "S.SM09ST", "S.SM10ST", "S.SM11ST", "S.SM12NI", "S.SM13ST", "S.SM14ST", "S.SM15VW", "S.SM16MT", "S.SM17HO", "S.SM18VW", "S.SM19ST", "S.SM20GM", "S.SC21VW", "S.SC22VW"]
  };
  const REVERSO_MAPA_SETOR = {};
  Object.entries(MAPA_SETOR).forEach(([setor, maquinas]) => maquinas.forEach(m => REVERSO_MAPA_SETOR[m.toUpperCase()] = setor));
  const MAPA_FF = { FF1: 'MontagemLanternas', FF2: 'MontagemSmall', FF3: 'Injecao', FF4: ['Metalizacao', 'Pintura'] };
  const REVERSO_MAPA_FF = {};
  Object.entries(MAPA_FF).forEach(([ff, setores]) => (Array.isArray(setores) ? setores : [setores]).forEach(s => REVERSO_MAPA_FF[s] = ff));
  try {
    connection = await oracledb.getConnection(dbConfig);
    let whereClauses = [];


    const binds = { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
    const addInClause = (field, values) => {
      const valueArray = Array.isArray(values) ? values : [values];
      if (valueArray.length === 0) return;
      const bindName = field.replace(/\W/g, '_').toLowerCase();
      const bindNames = valueArray.map((_, i) => `:${bindName}${i}`);
      whereClauses.push(`${field} IN (${bindNames.join(',')})`);
      valueArray.forEach((val, i) => { binds[`${bindName}${i}`] = val; });
    };
    if (filters.motivo) addInClause('TBL.TBL_DESCRI', filters.motivo);
    if (filters.material) addInClause('P.PRO_DESCRI', filters.material);
    if (filters.setor) {
      const setores = Array.isArray(filters.setor) ? filters.setor : [filters.setor];
      const maquinasDoSetor = Object.keys(REVERSO_MAPA_SETOR).filter(maq => setores.includes(REVERSO_MAPA_SETOR[maq]));
      if (maquinasDoSetor.length > 0) addInClause('MOV.CODMAQ', maquinasDoSetor);
    }
    if (filters.ff) {
      const ffs = Array.isArray(filters.ff) ? filters.ff : [filters.ff];
      const setoresDoFF = Object.keys(REVERSO_MAPA_FF).filter(setor => ffs.includes(REVERSO_MAPA_FF[setor]));
      const maquinasDoFF = Object.keys(REVERSO_MAPA_SETOR).filter(maq => setoresDoFF.includes(REVERSO_MAPA_SETOR[maq]));
      if (maquinasDoFF.length > 0) addInClause('MOV.CODMAQ', maquinasDoFF);
    }
    const whereString = whereClauses.length > 0 ? `AND ${whereClauses.join(' AND ')}` : '';
    const query = `
      WITH 
        RAW_MOVEMENTS AS (
            SELECT RFG.RFG_DT_RFG AS DATREF, RFG.RFG_CODPRO AS CODPRO, RFG.RFG_QT_RFG AS QTD, RFG.RFG_CODREF AS MOTREF, ROF.ROF_CODMAQ AS CODMAQ FROM olsa.F_ROTOF ROF JOIN olsa.F_REFUGO RFG ON ROF.ROF_CODIOF = RFG.RFG_CODIOF AND ROF.ROF_CODSEQ = RFG.RFG_CODSEQ
            UNION ALL
            SELECT OFS.OFS_DTLANC, OFS.OFS_CODPRO, OFS.OFS_QTDPRO, OFS.OFS_CODMOT, ROF.ROF_CODMAQ FROM olsa.F_OFSUCATA OFS LEFT JOIN olsa.F_ROTOF ROF ON OFS.OFS_CODIOF = ROF.ROF_CODIOF AND OFS.OFS_CODSEQ = ROF.ROF_CODSEQ
            UNION ALL
            SELECT SUC.SUC_DATSUC, SUC.SUC_CODPRO, SUC.SUC_QTDPRO, SUC.SUC_MOTIVO, 'SUCATA' FROM olsa.F_SUCATA SUC
            UNION ALL
            SELECT KAR.KAR_DATMOV, KAR.KAR_CODPRO, KAR.KAR_QTDMOV * -1, 100, 'RETRABALHO' FROM olsa.F_KARDEX KAR WHERE SUBSTR(KAR.KAR_INDICE, 1, 3) = 'DEV' AND KAR.KAR_TIPMOV = 'DM'
        )
      SELECT 
          TO_CHAR(MOV.DATREF, 'YYYY-MM') AS "mes",
          SUM(MOV.QTD * NVL(C.CUSFINAL, P.PRO_PRMEDI)) AS "Valor_Total",
          TBL.TBL_DESCRI AS "Motivo Refugo" 
      FROM RAW_MOVEMENTS MOV
      JOIN olsa.F_PRODS P ON P.PRO_CODPRO = MOV.CODPRO
      LEFT JOIN (SELECT DCI_ANOMES, DCI_CODPRO, SUM(DCI_VLRCUS) AS CUSFINAL FROM olsa.F_DETCUSINT GROUP BY DCI_ANOMES, DCI_CODPRO) C ON C.DCI_CODPRO = MOV.CODPRO AND C.DCI_ANOMES = TO_CHAR(ADD_MONTHS(MOV.DATREF, -1), 'YYYYMM')
      LEFT JOIN olsa.F_TABELAS TBL ON TBL.TBL_CODTAB = MOV.MOTREF
      LEFT JOIN olsa.F_MAQUINA MAQ ON MAQ.MAQ_CODIGO = MOV.CODMAQ
      WHERE MOV.DATREF BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
      ${whereString}
      GROUP BY TO_CHAR(MOV.DATREF, 'YYYY-MM'), TBL.TBL_DESCRI
      ORDER BY "mes"
    `;
    const result = await connection.execute(query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const finalSummary = result.rows.reduce((acc, row) => {
      const mes = row.mes;
      const valor = parseFloat(row.Valor_Total || 0);
      if (!acc[mes]) {
        acc[mes] = { "mes": mes, "Valor_Total": 0 };
      }
      acc[mes].Valor_Total += valor;
      return acc;
    }, {});
    res.json(Object.values(finalSummary));
  } catch (err) {
    console.error('Erro na rota /api/scrap/summary/monthly:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error('Erro ao fechar conexão mensal:', err); }
    }
  }
});


app.get('/api/movimentos', async (req, res) => {
  let connection;
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'Parâmetros "startDate" e "endDate" são obrigatórios no formato YYYY-MM-DD.' });
  }
  try {
    connection = await oracledb.getConnection(dbConfig);
    const result = await connection.execute(
      `
      SELECT M.*, N.*
      FROM OLSA.I_MOVIMEN M
      LEFT JOIN OLSA.I_MOVNAP N
        ON M.MOV_CODMOV = N.TNA_CODMOV AND M.MOV_CODPRO = N.TNA_CODPRO
        AND M.MOV_CODSEQ = N.TNA_CODSEQ AND M.MOV_TURNO = N.TNA_TURNO
      WHERE M.MOV_DATMOV BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
      `,
      { startDate, endDate },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro ao consultar o banco de dados:', err);
    res.status(500).json({ error: 'Erro ao consultar o banco de dados.' });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (closeErr) { console.error('Erro ao fechar a conexão:', closeErr); }
    }
  }
});

app.get('/api/estoque/saldo-por-lote', async (req, res) => {
  let connection;
  try {
    const dataAte = req.query.data_ate ? new Date(req.query.data_ate) : new Date();
    dataAte.setHours(23, 59, 59, 999);
    const bindParams = { data_ate: { val: dataAte, type: oracledb.DATE } };
    const query = `
        WITH SaldoPorLote AS (
          SELECT
            k.KAR_CODPRO, k.KAR_LOCEST, k.KAR_LOTMAT,
            SUM(CASE WHEN tpm.TPM_ENTSAI = 'E' THEN k.KAR_QTDMOV ELSE 0 END) AS QTD_ORIGINAL_LOTE,
            SUM(CASE WHEN tpm.TPM_ENTSAI = 'S' THEN k.KAR_QTDMOV ELSE 0 END) AS QTD_RETIRADA,
            SUM(CASE WHEN tpm.TPM_ENTSAI = 'E' THEN k.KAR_QTDMOV ELSE -k.KAR_QTDMOV END) AS SALDO_DO_LOTE
          FROM olsa.F_KARDEX k
            JOIN olsa.F_TIPMOV tpm ON k.KAR_TIPMOV = tpm.TPM_CODIGO
          WHERE k.KAR_DATMOV <= :data_ate AND k.KAR_LOTMAT IS NOT NULL AND k.KAR_LOTMAT <> 0
          GROUP BY k.KAR_CODPRO, k.KAR_LOCEST, k.KAR_LOTMAT
          HAVING SUM(CASE WHEN tpm.TPM_ENTSAI = 'E' THEN k.KAR_QTDMOV ELSE -k.KAR_QTDMOV END) > 0
        ), UltimaCompra AS (
          SELECT MOV_CODPRO, MAX(MOV_DATMOV) AS DATA_ULTIMA_COMPRA
          FROM olsa.F_MOVTO JOIN olsa.F_TIPMOV ON MOV_TIPMOV = TPM_CODIGO
          WHERE TPM_ENTSAI = 'E' AND TPM_CUSMAT = 'C' AND TPM_DESCRI NOT LIKE '%TRANS%'
          GROUP BY MOV_CODPRO
        ), CustoRecente AS (
          SELECT RGI_CODPRO, RGI_VCUSTO, ROW_NUMBER() OVER(PARTITION BY RGI_CODPRO ORDER BY RGI_ANOMES DESC) as rn
          FROM olsa.F_REGINV WHERE RGI_VCUSTO > 0
        )
        SELECT 
            spl.KAR_CODPRO AS PRODUTO, pro.PRO_DESCRI AS DESCRICAO, pro.PRO_GRPROD AS GRUPO,
            gru.GRU_DESCRI AS DESC_GRUPO, tpp.TPP_CODIGO || '-' || tpp.TPP_DESCRI AS TIPO_PRODUTO,
            spl.KAR_LOCEST AS LOCAL, spl.KAR_LOTMAT AS LOTE_MATERIAL, uc.DATA_ULTIMA_COMPRA,
            ROUND(spl.QTD_ORIGINAL_LOTE, 4) AS QTD_ORIGINAL_LOTE,
            ROUND(spl.QTD_RETIRADA, 4) AS QTD_RETIRADA, ROUND(spl.SALDO_DO_LOTE, 4) AS SALDO,
            NVL(cr.RGI_VCUSTO, 0) AS CUSTO_UNITARIO,
            ROUND(spl.SALDO_DO_LOTE * NVL(cr.RGI_VCUSTO, 0), 2) AS VALOR_TOTAL_ESTOQUE
        FROM SaldoPorLote spl
            JOIN olsa.F_PRODS pro ON spl.KAR_CODPRO = pro.PRO_CODPRO
            JOIN olsa.F_CADGRU gru ON pro.PRO_GRPROD = gru.GRU_CODIGO
            JOIN olsa.F_TPPROD tpp ON pro.PRO_TPPROD = tpp.TPP_CODIGO
            LEFT JOIN UltimaCompra uc ON spl.KAR_CODPRO = uc.MOV_CODPRO
            LEFT JOIN CustoRecente cr ON spl.KAR_CODPRO = cr.RGI_CODPRO AND cr.rn = 1
        WHERE pro.PRO_TPPROD NOT IN ('020','101','180','181','182','183','184','185','186','999')
        ORDER BY spl.KAR_CODPRO, spl.KAR_LOCEST, spl.KAR_LOTMAT
    `;
    connection = await oracledb.getConnection(dbConfig);
    const result = await connection.execute(query, bindParams, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) {
    console.error("Erro na rota /api/estoque/saldo-por-lote:", err);
    res.status(500).json({ error: 'Erro ao processar a solicitação de estoque.', details: err.message, code: err.code });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error("Erro ao fechar conexão:", err); }
    }
  }
});

app.get('/api/estoque/grafico-movimentacoes', async (req, res) => {
  let connection;
  try {
    const query = `
        SELECT 
            TRUNC(k.KAR_DATMOV) AS DIA_MOVIMENTO,
            SUM(
                CASE 
                    WHEN tpm.TPM_ENTSAI = 'E' THEN (k.KAR_QTDMOV * k.KAR_PREMED)
                    WHEN tpm.TPM_ENTSAI = 'S' THEN -(k.KAR_QTDMOV * k.KAR_PREMED)
                    ELSE 0 
                END
            ) AS VALOR_TOTAL_DIA
        FROM olsa.F_KARDEX k
            JOIN olsa.F_TIPMOV tpm ON k.KAR_TIPMOV = tpm.TPM_CODIGO
            JOIN olsa.F_PRODS pro ON k.KAR_CODPRO = pro.PRO_CODPRO
        WHERE 
            k.KAR_DATMOV IS NOT NULL
            AND k.KAR_PREMED >= 0
            AND pro.PRO_TPPROD NOT IN ('020','101','180','181','182','183','184','185','186','999')
        GROUP BY TRUNC(k.KAR_DATMOV)
        ORDER BY DIA_MOVIMENTO
    `;
    connection = await oracledb.getConnection(dbConfig);
    const result = await connection.execute(query, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) {
    console.error("Erro na rota /api/estoque/grafico-movimentacoes:", err);
    res.status(500).json({ error: 'Erro ao buscar dados agregados para os gráficos.', details: err.message });
  } finally {
    if (connection) {
      try { await connection.close(); } catch (err) { console.error("Erro ao fechar conexão:", err); }
    }
  }
});

// ==========================================
// ROTAS JARINU (SCHEMA: MAGNA_JARINU)
// ==========================================

app.get('/api/jarinu/refugo', async (req, res) => {
  let connection;
  const { start, end } = req.query;
  try {
    connection = await oracledb.getConnection(dbConfig);
    const query = `
      SELECT * FROM (
        SELECT   
          PRODUTO_FINAL     AS "Prod.Final",
          VTP.VDESCRI       AS "Desc.Prod.Final",
          VTP.VUNIMED       AS "UN.F",
          VTP.PRT_NEGOCIO   AS "Negocio",
          VTP.PRT_TIPOPRO   AS "Tipo Prod.",
          VTP.PRT_PROJETO   AS "Projeto",
          DATREF            AS "Data",
          CODTUR            AS "Tur.",
          CODMAQ            AS "Maquina",
          CODPRO            AS "Material",
          PRO_DESCRI        AS "Desc. Material",
          PRO_UNIMED        AS "Un.M.",
          CODIOF            AS "O.F.",
          IND               AS "IND",
          MOTREF            AS "Ref.",
          TBL_DESCRI        AS "Motivo Refugo",
          REFTOT            AS "Qtde Ref.",
          (REFTOT * NVL(CUSFINAL, PRMEDI)) AS "Valor Ref.",
          CEL.CEL_DESCRI    AS "Celula"
          FROM (
                 SELECT DATREF, CODTUR, CODMAQ, CODPRO, PRO_DESCRI, PRO_UNIMED, CODIOF, CUSFINAL,
                        PRO_PRMEDI PRMEDI, NVL(PRO_COMP09, PRO_CODPRO) PRODUTO_FINAL, SUBSTR(INDICE, 1, 3) IND,
                        MOTREF, TBL_DESCRI, SUM(QTDREF) REFTOT
                   FROM MAGNA_JARINU.F_TABELAS,
                        MAGNA_JARINU.F_PRODS,
                        (
                          SELECT RFG_DT_RFG DATREF, RFG_CODPRO CODPRO, RFG_QT_RFG QTDREF, RFG_CODREF MOTREF,
                                 'REF' || LPAD(TO_CHAR(RFG_CODIGO), 6, '0') INDICE,
                                 RFG_CODIGO CODIGO, RFG_CODIOF CODIOF, ROF_CODMAQ CODMAQ, RFG_CODTUR CODTUR
                            FROM MAGNA_JARINU.F_ROTOF, MAGNA_JARINU.F_REFUGO
                           WHERE ROF_CODIOF = RFG_CODIOF AND ROF_CODSEQ = RFG_CODSEQ
                          UNION ALL
                          SELECT OFS_DTLANC DATREF, OFS_CODPRO CODPRO, OFS_QTDPRO QTDREF, OFS_CODMOT MOTREF,
                                 'OFS' || TO_CHAR(OFS_CODIGO) INDICE, TO_CHAR(OFS_CODIGO) CODIGO, 
                                 OFS_CODIOF CODIOF, ROF_CODMAQ CODMAQ, OFS_CODTUR CODTUR
                            FROM MAGNA_JARINU.F_ROTOF, MAGNA_JARINU.F_OFSUCATA
                           WHERE ROF_CODIOF(+) = OFS_CODIOF AND ROF_CODSEQ(+) = OFS_CODSEQ
                          UNION ALL
                          SELECT SUC_DATSUC DATREF, SUC_CODPRO CODPRO, SUC_QTDPRO QTDREF, SUC_MOTIVO MOTREF,
                                 'SUC' || TO_CHAR(SUC_CODIGO) INDICE, TO_CHAR(SUC_CODIGO) CODIGO, 
                                 NULL CODIOF, 'SUCATA' CODMAQ, SUC_CODTUR CODTUR
                            FROM MAGNA_JARINU.F_SUCATA
                          UNION ALL
                          SELECT KAR_DATMOV DATREF, KAR_CODPRO CODPRO, KAR_QTDMOV * -1 QTDREF, 100 MOTREF,
                                 KAR_INDICE CODIGO, KAR_CODIGO CODIGO, NULL CODIOF,
                                 'RETRABALHO' CODMAQ, KAR_CODTUR CODTUR
                            FROM MAGNA_JARINU.F_KARDEX
                           WHERE SUBSTR(KAR_INDICE, 1, 3) IN ('DEV','ASG','SUC', 'REF', 'OFS','RCO','RFG')
                             AND KAR_TIPMOV = 'DM'
                        ),
                        (
                          SELECT DCI_ANOMES, DCI_CODPRO, SUM(DCI_VLRCUS) CUSFINAL
                            FROM MAGNA_JARINU.F_DETCUSINT
                           WHERE SUBSTR(DCI_CODPRO, 1, 3) <> 'SUC'
                           GROUP BY DCI_ANOMES, DCI_CODPRO
                        )
                 WHERE DATREF BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
                   AND TBL_CODTAB(+) = MOTREF
                   AND PRO_CODPRO = CODPRO
                   AND DCI_CODPRO(+) = CODPRO
                   AND DCI_ANOMES(+) = TO_CHAR(ADD_MONTHS(DATREF, -1), 'YYYYMM')
                 GROUP BY DATREF, CODTUR, CODMAQ, CODPRO, PRO_DESCRI, PRO_UNIMED,
                          PRO_PRMEDI, NVL(PRO_COMP09, PRO_CODPRO),
                          MOTREF, TBL_DESCRI, CUSFINAL, SUBSTR(INDICE, 1, 3), CODIOF
               ) DATA_BASE
          LEFT JOIN MAGNA_JARINU.ALJ_V_PROD_TOPICOS VTP ON VTP.VCODPRO = DATA_BASE.PRODUTO_FINAL
          LEFT JOIN MAGNA_JARINU.F_MAQUINA MAQ ON MAQ.MAQ_CODIGO = DATA_BASE.CODMAQ
          LEFT JOIN MAGNA_JARINU.F_CELULA CEL ON CEL.CEL_CODCEL = MAQ.MAQ_CELULA
      )
    `;
    const result = await connection.execute(query, { startDate: start, endDate: end }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
  finally { if (connection) await connection.close(); }
});

app.get('/api/jarinu/sucata', async (req, res) => {
  let connection;
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios' });
  try {
    connection = await oracledb.getConnection(dbConfig);
    const query = `
      WITH REFUGO_BASE AS (
        SELECT RFG_DT_RFG AS DATREF, RFG_CODPRO AS CODPRO, RFG_QT_RFG AS QTDREF, RFG_CODREF AS MOTREF,
               'REF' || LPAD(TO_CHAR(RFG_CODIGO), 6, '0') AS INDICE, TO_CHAR(RFG_CODIGO) AS CODIGO,
               RFG_CODIOF AS CODIOF, ROF_CODMAQ AS CODMAQ, RFG_CODTUR AS CODTUR
          FROM MAGNA_JARINU.F_ROTOF
               JOIN MAGNA_JARINU.F_REFUGO ON ROF_CODIOF = RFG_CODIOF AND ROF_CODSEQ = RFG_CODSEQ
         WHERE RFG_DT_RFG BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
        UNION ALL
        SELECT OFS_DTLANC, OFS_CODPRO, OFS_QTDPRO, OFS_CODMOT,
               'OFS' || TO_CHAR(OFS_CODIGO), TO_CHAR(OFS_CODIGO),
               OFS_CODIOF, ROF_CODMAQ, OFS_CODTUR
          FROM MAGNA_JARINU.F_OFSUCATA
               LEFT JOIN MAGNA_JARINU.F_ROTOF ON ROF_CODIOF = OFS_CODIOF AND ROF_CODSEQ = OFS_CODSEQ
         WHERE OFS_DTLANC BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
        UNION ALL
        SELECT SUC_DATSUC, SUC_CODPRO, SUC_QTDPRO, SUC_MOTIVO,
               'SUC' || TO_CHAR(SUC_CODIGO), TO_CHAR(SUC_CODIGO),
               NULL, 'SUCATA', SUC_CODTUR
          FROM MAGNA_JARINU.F_SUCATA
         WHERE SUC_DATSUC BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
        UNION ALL
        SELECT KAR_DATMOV, KAR_CODPRO, KAR_QTDMOV * -1, 100,
               KAR_INDICE, TO_CHAR(KAR_CODIGO),
               NULL, 'RETRABALHO', KAR_CODTUR
          FROM MAGNA_JARINU.F_KARDEX
         WHERE SUBSTR(KAR_INDICE, 1, 3) IN ('DEV', 'ASG', 'SUC', 'REF', 'OFS', 'RCO', 'RFG')
           AND KAR_TIPMOV = 'DM'
           AND KAR_DATMOV BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
      )
      SELECT
        NVL(p.PRO_COMP09, r.CODPRO) AS "Prod.Final", v.VDESCRI AS "Desc.Prod.Final", v.VUNIMED AS "UN.F",
        v.PRT_NEGOCIO AS "Negocio", v.PRT_TIPOPRO AS "Tipo Prod.", v.PRT_PROJETO AS "Projeto",
        r.DATREF AS "Data", r.CODTUR AS "Tur.", r.CODMAQ AS "Maquina", r.CODPRO AS "Material",
        p.PRO_DESCRI AS "Desc. Material", p.PRO_UNIMED AS "Un.M.", r.CODIOF AS "O.F.",
        SUBSTR(r.INDICE, 1, 3) AS "IND", r.MOTREF AS "Ref.", t.TBL_DESCRI AS "Motivo Refugo",
        r.QTDREF AS "Qtde Ref.", r.QTDREF * NVL(c.CUSFINAL, p.PRO_PRMEDI) AS "Valor Ref.",
        cel.CEL_DESCRI AS "Celula"
      FROM REFUGO_BASE r
           JOIN MAGNA_JARINU.F_PRODS p ON p.PRO_CODPRO = r.CODPRO
           JOIN MAGNA_JARINU.ALJ_V_PROD_TOPICOS v ON v.VCODPRO = NVL(p.PRO_COMP09, r.CODPRO)
           LEFT JOIN MAGNA_JARINU.F_TABELAS t ON t.TBL_CODTAB = r.MOTREF
           LEFT JOIN MAGNA_JARINU.F_MAQUINA m ON m.MAQ_CODIGO = r.CODMAQ
           LEFT JOIN MAGNA_JARINU.F_CELULA cel ON cel.CEL_CODCEL = m.MAQ_CELULA
           LEFT JOIN (
              SELECT DCI_ANOMES, DCI_CODPRO, SUM(DCI_VLRCUS) AS CUSFINAL
                FROM MAGNA_JARINU.F_DETCUSINT
               WHERE SUBSTR(DCI_CODPRO, 1, 3) <> 'SUC'
               GROUP BY DCI_ANOMES, DCI_CODPRO
            ) c ON c.DCI_CODPRO = r.CODPRO AND c.DCI_ANOMES = TO_CHAR(ADD_MONTHS(r.DATREF, -1), 'YYYYMM')
    `;
    const result = await connection.execute(query, { startDate: start, endDate: end }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

app.get('/api/jarinu/scrap', async (req, res) => {
  let connection;
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios' });

  try {
    connection = await oracledb.getConnection(dbConfig);
    const query = `
      WITH 
      -- 1. DADOS DE PRODUTOS (Puxando apenas campos VARCHAR2 para evitar erro de LONG)
      V_TOPICOS AS (
          SELECT 
            P.PRO_CODPRO AS VCODPRO,
            P.PRO_DESCRI AS VDESCRI,
            P.PRO_UNIMED AS VUNIMED,
            P.PRO_PRMEDI AS VCUSTO,
            P.PRO_COMP09 AS VPROD_PAI,
            P.PRO_GRPROD AS VGRUPO -- Usando o código do grupo como alternativa ao "Negócio"
          FROM MAGNA_JARINU.F_PRODS P
      ),

      -- 2. COLETA DE MOVIMENTOS (Apenas tabelas confirmadas no log)
      RAW_MOVEMENTS AS (
          -- Refugo
          SELECT RFG_DT_RFG AS DATREF, RFG_CODIOF AS CODIOF, RFG_CODPRO AS CODPRO, RFG_QT_RFG AS QTD,
                 RFG_CODREF AS MOTREF, 'REF' AS INDICE, RFG_CODTUR AS CODTUR
          FROM MAGNA_JARINU.F_REFUGO
          WHERE RFG_DT_RFG BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
          
          UNION ALL
          -- Sucata de OF
          SELECT OFS_DTLANC, OFS_CODIOF, OFS_CODPRO, OFS_QTDPRO,
                 OFS_CODMOT, 'OFS' AS INDICE, OFS_CODTUR
          FROM MAGNA_JARINU.F_OFSUCATA
          WHERE OFS_DTLANC BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
          
          UNION ALL
          -- Sucata Direta
          SELECT SUC_DATSUC, TO_CHAR(SUC_CODIGO), SUC_CODPRO, SUC_QTDPRO,
                 SUC_MOTIVO, 'SUC' AS INDICE, SUC_CODTUR
          FROM MAGNA_JARINU.F_SUCATA
          WHERE SUC_DATSUC BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
          
          UNION ALL
          -- Devoluções via Kardex
          SELECT KAR_DATMOV, KAR_NUMDOC, KAR_CODPRO, KAR_QTDMOV * -1, 
                 100, 'DEV', KAR_CODTUR
          FROM MAGNA_JARINU.F_KARDEX
          WHERE KAR_TIPMOV = 'DM' 
            AND KAR_DATMOV BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
            AND (KAR_INDICE LIKE 'DEV%' OR KAR_INDICE LIKE 'REF%')
      )

      -- 3. RESULTADO FINAL (Agrupado por campos estáveis)
      SELECT 
          MOV.DATREF          AS "Data",
          NVL(VTP.VPROD_PAI, MOV.CODPRO) AS "Prod.Final",
          VTP.VDESCRI         AS "Desc.Prod.Final",
          MOV.CODIOF          AS "O.F.",
          'JARINU'            AS "Celula",
          'MAQ-' || MOV.MOTREF AS "Cod. Maquina",
          'MAQUINA JARINU'    AS "Maquina",
          MOV.CODPRO          AS "Material",
          VTP.VDESCRI         AS "Desc. Material",
          VTP.VUNIMED         AS "UN.F",
          NVL(VTP.VGRUPO, 'JARINU') AS "Negocio",
          'PRODUCAO'          AS "Tipo Prod.",
          'PROJETO-JAR'       AS "Projeto",
          MOV.CODTUR          AS "Tur.",
          VTP.VUNIMED         AS "Un.M.",
          MOV.INDICE          AS "IND",
          MOV.MOTREF          AS "Ref.",
          'MOTIVO ' || MOV.MOTREF AS "Motivo Refugo",
          SUM(MOV.QTD)        AS "Qtde_Total",
          SUM(MOV.QTD * NVL(VTP.VCUSTO, 0)) AS "Valor_Total"
      FROM RAW_MOVEMENTS MOV
      LEFT JOIN V_TOPICOS VTP ON VTP.VCODPRO = MOV.CODPRO
      GROUP BY 
          MOV.DATREF, NVL(VTP.VPROD_PAI, MOV.CODPRO), VTP.VDESCRI, MOV.CODIOF, 
          MOV.CODPRO, VTP.VUNIMED, VTP.VGRUPO, MOV.CODTUR, MOV.INDICE, MOV.MOTREF, VTP.VCUSTO
      ORDER BY MOV.DATREF, MOV.CODIOF
    `;
    const binds = { startDate: start, endDate: end };
    const result = await connection.execute(query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) {
    console.error('Erro em Jarinu Scrap:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

app.get('/api/jarinu/faturamento', async (req, res) => {
  let connection;
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'Parâmetros start e end são obrigatórios' });
  try {
    connection = await oracledb.getConnection(dbConfig);
    const query = `
      SELECT * FROM (
        SELECT MOV_CODEMP, EMP_ERAZAO, MOV_NTFISC, MOV_DATMOV,
               SUM(MOV_VALTOT - MOV_VALICM - MOV_VALPIS - MOV_COFINS) AS VALLIQ,
               SUM(MOV_VALTOT - MOV_VALICM) AS VALMERC, SUM(MOV_VALICM) AS VALICM,
               SUM(MOV_VALIPI) AS VALIPI, SUM(MOV_VALTOT + MOV_VALIPI) AS VALTOT
        FROM MAGNA_JARINU.F_CDEMP, MAGNA_JARINU.F_MOVTO, MAGNA_JARINU.F_PRODS, 
             MAGNA_JARINU.F_TIPMOV, MAGNA_JARINU.F_TPPROD
        WHERE MOV_DATMOV >= TO_DATE(:startDate, 'YYYY-MM-DD') AND MOV_DATMOV <= TO_DATE(:endDate, 'YYYY-MM-DD')
          AND PRO_CODPRO = MOV_CODPRO AND TPP_CODIGO = PRO_TPPROD AND TPM_CODIGO = MOV_TIPMOV
          AND TPM_CUSMAT = 'F' AND TPM_ENTSAI = 'S' AND PRO_LOCEST IS NOT NULL
          AND TPP_TIPPRO IN ('A','M','D') AND EMP_CODEMP = MOV_CODEMP
        GROUP BY MOV_CODEMP, EMP_ERAZAO, MOV_NTFISC, MOV_DATMOV
      )
      ORDER BY MOV_DATMOV, MOV_NTFISC
    `;
    const result = await connection.execute(query, { startDate: start, endDate: end }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

app.get('/api/jarinu/scrap/summary/monthly', async (req, res) => {
  let connection;
  const { year } = req.query;
  if (!year) return res.status(400).json({ error: 'Parâmetro year é obrigatório' });
  
  try {
    connection = await oracledb.getConnection(dbConfig);
    const query = `
      WITH 
      -- 1. COLETA DE MOVIMENTOS SIMPLIFICADA (Igual ao que funcionou no diário)
      RAW_MOVEMENTS AS (
          SELECT RFG_DT_RFG AS DATREF, RFG_CODPRO AS CODPRO, RFG_QT_RFG AS QTD
          FROM MAGNA_JARINU.F_REFUGO
          WHERE RFG_DT_RFG BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
          
          UNION ALL
          SELECT OFS_DTLANC, OFS_CODPRO, OFS_QTDPRO
          FROM MAGNA_JARINU.F_OFSUCATA
          WHERE OFS_DTLANC BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
          
          UNION ALL
          SELECT SUC_DATSUC, SUC_CODPRO, SUC_QTDPRO
          FROM MAGNA_JARINU.F_SUCATA
          WHERE SUC_DATSUC BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
          
          UNION ALL
          SELECT KAR_DATMOV, KAR_CODPRO, KAR_QTDMOV * -1
          FROM MAGNA_JARINU.F_KARDEX
          WHERE KAR_TIPMOV = 'DM' 
            AND KAR_DATMOV BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')
            AND (KAR_INDICE LIKE 'DEV%' OR KAR_INDICE LIKE 'REF%')
      )
      -- 2. AGRUPAMENTO MENSAL USANDO CUSTO DIRETO DA F_PRODS
      SELECT 
          TO_CHAR(MOV.DATREF, 'YYYY-MM') AS "mes", 
          SUM(MOV.QTD * NVL(P.PRO_PRMEDI, 0)) AS "Valor_Total"
      FROM RAW_MOVEMENTS MOV
      LEFT JOIN MAGNA_JARINU.F_PRODS P ON P.PRO_CODPRO = MOV.CODPRO
      GROUP BY TO_CHAR(MOV.DATREF, 'YYYY-MM')
      ORDER BY "mes"
    `;
    const binds = { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
    const result = await connection.execute(query, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) {
    console.error('Erro no Sumário Mensal Jarinu:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});


app.get('/api/jarinu/movimentos', async (req, res) => {
  let connection;
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ error: 'Datas são obrigatórias' });
  try {
    connection = await oracledb.getConnection(dbConfig);
    const result = await connection.execute(
      `SELECT M.*, N.* FROM MAGNA_JARINU.I_MOVIMEN M LEFT JOIN MAGNA_JARINU.I_MOVNAP N 
       ON M.MOV_CODMOV = N.TNA_CODMOV AND M.MOV_CODPRO = N.TNA_CODPRO AND M.MOV_CODSEQ = N.TNA_CODSEQ 
       WHERE M.MOV_DATMOV BETWEEN TO_DATE(:startDate, 'YYYY-MM-DD') AND TO_DATE(:endDate, 'YYYY-MM-DD')`,
      { startDate, endDate }, { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

app.get('/api/jarinu/estoque/saldo-por-lote', async (req, res) => {
  let connection;
  try {
    const dataAte = req.query.data_ate ? new Date(req.query.data_ate) : new Date();
    dataAte.setHours(23, 59, 59, 999);
    const query = `
        WITH SaldoPorLote AS (
          SELECT k.KAR_CODPRO, k.KAR_LOCEST, k.KAR_LOTMAT, SUM(CASE WHEN tpm.TPM_ENTSAI = 'E' THEN k.KAR_QTDMOV ELSE -k.KAR_QTDMOV END) AS SALDO_DO_LOTE
          FROM MAGNA_JARINU.F_KARDEX k JOIN MAGNA_JARINU.F_TIPMOV tpm ON k.KAR_TIPMOV = tpm.TPM_CODIGO
          WHERE k.KAR_DATMOV <= :data_ate AND k.KAR_LOTMAT IS NOT NULL AND k.KAR_LOTMAT <> 0
          GROUP BY k.KAR_CODPRO, k.KAR_LOCEST, k.KAR_LOTMAT HAVING SUM(CASE WHEN tpm.TPM_ENTSAI = 'E' THEN k.KAR_QTDMOV ELSE -k.KAR_QTDMOV END) > 0
        )
        SELECT spl.KAR_CODPRO AS PRODUTO, pro.PRO_DESCRI AS DESCRICAO, spl.KAR_LOCEST AS LOCAL, spl.SALDO_DO_LOTE AS SALDO
        FROM SaldoPorLote spl JOIN MAGNA_JARINU.F_PRODS pro ON spl.KAR_CODPRO = pro.PRO_CODPRO
        ORDER BY spl.KAR_CODPRO
    `;
    connection = await oracledb.getConnection(dbConfig);
    const result = await connection.execute(query, { data_ate: dataAte }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (connection) await connection.close();
  }
});

app.get('/api/sync-prod', async (req, res) => {
    let connection;
    const { start, end } = req.query;
    console.log(`Iniciando busca de produtividade: ${start} até ${end}`);

    try {
        connection = await oracledb.getConnection(dbConfig);
        const query = `
            SELECT 
                KAR_CODPRO AS PRODUTO,
                KAR_DATMOV AS DATA,
                KAR_QTDMOV AS QUANTIDADE,
                MAQ_CODIGO AS MAQUINA
            FROM 
                OLSA.F_MAQUINA maq,
                OLSA.F_ROTVER rotver,
                OLSA.F_OF cof,
                OLSA.F_PRODS prods,
                OLSA.F_KARDEX kardex
            WHERE 
                KAR_DATMOV BETWEEN TO_DATE(:sd, 'YYYY-MM-DD') AND TO_DATE(:ed, 'YYYY-MM-DD') -- NOMES ALTERADOS
                AND KAR_TIPMOV = 'EAC'
                AND PRO_CODPRO = KAR_CODPRO
                AND COF_CODIOF = KAR_NUMDOC
                AND VER_CODCNP = COF_CODINP
                AND VER_ROTEIR = COF_ROTEIR
                AND MAQ_CODIGO = VER_CODMAQ`;

        // Importante: as chaves do objeto abaixo devem bater com os nomes na query (:sd e :ed)
        const result = await connection.execute(query, { sd: start, ed: end }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        
        await fs.ensureDir(path.join(__dirname, 'data'));
        await fs.writeJson(path.join(__dirname, 'data', 'produtividade.json'), result.rows, { spaces: 2 });
        
        console.log("Produtividade salva com sucesso!");
        res.json({ message: "Produtividade sincronizada" });
    } catch (err) {
        console.error("ERRO NO BANCO (PROD):", err);
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) await connection.close();
    }
});

app.get('/api/sync-scrap', async (req, res) => {
    let connection;
    const { start, end } = req.query;
    console.log(`Iniciando sincronização de refugo: ${start} até ${end}`);

    // Mapeamento de setores (Necessário para o dashboard)
    const MAPA_SETOR = {
        Retrabalho: ['RETRABALHO'],
        Metalizacao: ["S.MT01", "S.MT02", "S.MT03", "S.MT04"],
        Pintura: ["S.HC01"],
        Injecao: ["S.I01H1K160", "S.I02H1K200", "S.I03H1K100", "S.I04H1K120", "S.I05H1K65", "S.I06H1K150", "S.I07H1K150", "S.I08H1K65", "S.I09H1K86", "S.I10H1K220", "S.I11H1K120", "S.I12H1K120", "S.I13H1K320", "S.I14H1K160", "S.I15H1K140", "S.I16H1K200", "S.I17H1K220", "S.I18H1K220", "S.I19H1K220", "S.I20H1K320", "S.I21H1K530", "S.I22H1K1300", "S.I23H3K1000", "S.I24H1K1300", "S.I25H3K1000", "S.I26H1K530", "S.I27H2K1000", "S.I28H1K320", "S.I29H1K1300", "S.I30H2K1700", "S.I31H2K1000", "S.I32H1K1000", "S.I33H2K1000", "S.I34H1K1300"],
        MontagemLanternas: ["S.LA01ST", "S.LA02ST", "S.LA03GM", "S.LA04GM", "S.LA05GM", "S.LA06GM", "S.LA07RE", "S.LA08RE", "S.LA09VW", "S.LA010ST"],
        MontagemSmall: ["S.SM01VW", "S.SM02VW", "S.SM03VW", "S.SM04M", "S.SM05MT", "S.SM06TY", "S.SM07ST", "S.SM08ST", "S.SM09ST", "S.SM10ST", "S.SM11ST", "S.SM12NI", "S.SM13ST", "S.SM14ST", "S.SM15VW", "S.SM16MT", "S.SM17HO", "S.SM18VW", "S.SM19ST", "S.SM20GM", "S.SC21VW", "S.SC22VW"]
    };
    const REVERSO_MAPA_SETOR = {};
    Object.entries(MAPA_SETOR).forEach(([setor, maquinas]) => maquinas.forEach(m => REVERSO_MAPA_SETOR[m.toUpperCase()] = setor));

    try {
        connection = await oracledb.getConnection(dbConfig);
        const query = `
            WITH RAW_MOVEMENTS AS (
                SELECT RFG.RFG_DT_RFG AS DATREF, RFG.RFG_QT_RFG AS QTD, ROF.ROF_CODMAQ AS CODMAQ, RFG.RFG_CODREF AS MOTREF 
                FROM olsa.F_ROTOF ROF 
                JOIN olsa.F_REFUGO RFG ON ROF.ROF_CODIOF = RFG.RFG_CODIOF AND ROF.ROF_CODSEQ = RFG.RFG_CODSEQ 
                WHERE RFG.RFG_DT_RFG BETWEEN TO_DATE(:sd, 'YYYY-MM-DD') AND TO_DATE(:ed, 'YYYY-MM-DD')
                UNION ALL
                SELECT OFS.OFS_DTLANC, OFS.OFS_QTDPRO, ROF.ROF_CODMAQ, OFS.OFS_CODMOT 
                FROM olsa.F_OFSUCATA OFS 
                LEFT JOIN olsa.F_ROTOF ROF ON OFS.OFS_CODIOF = ROF.ROF_CODIOF AND OFS.OFS_CODSEQ = ROF.ROF_CODSEQ 
                WHERE OFS.OFS_DTLANC BETWEEN TO_DATE(:sd, 'YYYY-MM-DD') AND TO_DATE(:ed, 'YYYY-MM-DD')
            )
            SELECT DATREF AS "Data", CODMAQ AS "Cod_Maquina", MOTREF AS "Ref", SUM(QTD) AS "Qtde_Total"
            FROM RAW_MOVEMENTS 
            GROUP BY DATREF, CODMAQ, MOTREF`;

        const result = await connection.execute(query, { sd: start, ed: end }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        
        // Processa os setores antes de salvar
        const processed = result.rows.map(row => ({
            ...row,
            Setor: REVERSO_MAPA_SETOR[(row.Cod_Maquina || '').toUpperCase()] || "Outros"
        }));

        // Salva o arquivo JSON
        await fs.ensureDir(path.join(__dirname, 'data'));
        await fs.writeJson(path.join(__dirname, 'data', 'refugo.json'), processed, { spaces: 2 });
        
        console.log("Refugo sincronizado e salvo com sucesso!");
        res.json({ message: "Refugo sincronizado" });
    } catch (err) {
        console.error("ERRO NO BANCO (REFUGO):", err);
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) await connection.close();
    }
});

// ==========================================
// SERVINDO ARQUIVOS E INICIALIZAÇÃO
// ==========================================

const projectRoot = path.join(__dirname, '..');
const staticFilesRoot = path.join(projectRoot, 'integrações_Debx');

app.use(express.static(staticFilesRoot));

app.get('/', (req, res) => {
  res.sendFile(path.join(staticFilesRoot, 'html', 'relatorio_R_F.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 API rodando em http://10.109.135.158:${PORT}`);
  console.log(`--------------------------------------------------`);
  console.log(`🏭 PLANTAS ATIVAS: OLSA e MAGNA_JARINU`);
  console.log(`--------------------------------------------------`);
  
  console.log(`📍 ROTAS OLSA:`);
  console.log(`   📄/api/sync-scrap`);
  console.log(`   📄/api/sync-prod`);
  console.log(`   📄 /api/refugo`);
  console.log(`   📄 /api/sucata`);
  console.log(`   📄 /api/scrap`);
  console.log(`   📄 /api/scrap/summary/monthly`);
  console.log(`   📄 /api/faturamento`);
  console.log(`   📄 /api/merge`);
  console.log(`   📄 /api/movimentos`);
  console.log(`   📄 /api/estoque/saldo-por-lote`);
  console.log(`   📄 /api/estoque/grafico-movimentacoes`);
  
  console.log(`\n📍 ROTAS JARINU:`);
  console.log(`   📄 /api/jarinu/refugo`);
  console.log(`   📄 /api/jarinu/sucata`);
  console.log(`   📄 /api/jarinu/scrap`);
  console.log(`   📄 /api/jarinu/scrap/summary/monthly`);
  console.log(`   📄 /api/jarinu/faturamento`);
  console.log(`   📄 /api/jarinu/merge`);
  console.log(`   📄 /api/jarinu/movimentos`);
  console.log(`   📄 /api/jarinu/estoque/saldo-por-lote`);
  console.log(`--------------------------------------------------`);
});