const express = require('express');
const oracledb = require('oracledb');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const app = express();
const PORT = 3300;

app.use(cors());

const dbConfig = {
    user: 'consultadebx',
    password: 'olsadeb2025',
    connectString: '10.109.132.163:1521/ORCL.MAGNA.GLOBAL'
};

// Mapeamento de Setores
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

// Função para gerar as semanas
function obterIntervalosSemanais(anos) {
    let intervalos = [];
    anos.forEach(ano => {
        let dataInicio = new Date(ano, 0, 1);
        while (dataInicio.getFullYear() === ano) {
            let dataFim = new Date(dataInicio);
            dataFim.setDate(dataInicio.getDate() + 6);
            if (dataFim.getFullYear() !== ano) dataFim = new Date(ano, 11, 31);
            intervalos.push({
                start: dataInicio.toISOString().split('T')[0],
                end: dataFim.toISOString().split('T')[0]
            });
            dataInicio.setDate(dataInicio.getDate() + 7);
        }
    });
    return intervalos;
}

// ROTA SYNC PRODUTIVIDADE FRACIONADA
app.get('/api/sync-prod', async (req, res) => {
    let connection;
    let todosRegistros = [];
    const semanas = obterIntervalosSemanais([2025, 2026]);
    try {
        connection = await oracledb.getConnection(dbConfig);
        const query = `
            SELECT KAR_CODPRO AS PRODUTO, KAR_DATMOV AS DATA, KAR_QTDMOV AS QUANTIDADE, MAQ_CODIGO AS MAQUINA
            FROM OLSA.F_MAQUINA, OLSA.F_ROTVER, OLSA.F_OF, OLSA.F_PRODS, OLSA.F_KARDEX
            WHERE KAR_DATMOV BETWEEN TO_DATE(:sd, 'YYYY-MM-DD') AND TO_DATE(:ed, 'YYYY-MM-DD')
            AND KAR_TIPMOV = 'EAC' AND PRO_CODPRO = KAR_CODPRO AND COF_CODIOF = KAR_NUMDOC 
            AND VER_CODCNP = COF_CODINP AND VER_ROTEIR = COF_ROTEIR AND MAQ_CODIGO = VER_CODMAQ`;

        for (const sem of semanas) {
            console.log(`📅 Buscando Produtividade: ${sem.start} ate ${sem.end}`);
            const result = await connection.execute(query, { sd: sem.start, ed: sem.end }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
            todosRegistros = todosRegistros.concat(result.rows);
        }

        const dados2025 = todosRegistros.filter(i => new Date(i.DATA).getFullYear() === 2025);
        const dados2026 = todosRegistros.filter(i => new Date(i.DATA).getFullYear() === 2026);

        await fs.ensureDir(path.join(__dirname, 'data'));
        await fs.writeJson(path.join(__dirname, 'data', 'produtividade_2025.json'), dados2025, { spaces: 0 });
        await fs.writeJson(path.join(__dirname, 'data', 'produtividade_2026.json'), dados2026, { spaces: 0 });

        console.log("✅ Produtividade fracionada salva com sucesso!");
        res.json({ success: true, count25: dados2025.length, count26: dados2026.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { if (connection) await connection.close(); }
});

// ROTA SYNC REFUGO FRACIONADO
app.get('/api/sync-scrap', async (req, res) => {
    let connection;
    let todosRegistros = [];
    const semanas = obterIntervalosSemanais([2025, 2026]);
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
            FROM RAW_MOVEMENTS GROUP BY DATREF, CODMAQ, MOTREF`;

        for (const sem of semanas) {
            console.log(`📅 Buscando Refugo: ${sem.start} ate ${sem.end}`);
            const result = await connection.execute(query, { sd: sem.start, ed: sem.end }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
            const processed = result.rows.map(row => ({
                ...row,
                Setor: REVERSO_MAPA_SETOR[(row.Cod_Maquina || '').toUpperCase()] || "Outros"
            }));
            todosRegistros = todosRegistros.concat(processed);
        }

        const ref2025 = todosRegistros.filter(i => new Date(i.Data).getFullYear() === 2025);
        const ref2026 = todosRegistros.filter(i => new Date(i.Data).getFullYear() === 2026);

        await fs.writeJson(path.join(__dirname, 'data', 'refugo_2025.json'), ref2025, { spaces: 0 });
        await fs.writeJson(path.join(__dirname, 'data', 'refugo_2026.json'), ref2026, { spaces: 0 });

        console.log("✅ Refugo fracionado salvo com sucesso!");
        res.json({ success: true, count25: ref2025.length, count26: ref2026.length });
    } catch (err) { res.status(500).json({ error: err.message }); }
    finally { if (connection) await connection.close(); }
});

// Servir arquivos estáticos
const staticFiles = path.join(__dirname, '..', 'integrações_Debx');
app.use(express.static(staticFiles));
app.get('/', (req, res) => { res.sendFile(path.join(staticFiles, 'html', 'relatorio_R_F.html')); });

app.listen(PORT, () => {
    console.log(`🚀 API rodando em http://localhost:${PORT}`);
    console.log(`🏭 Sincronização configurada para 2025 e 2026 fracionada.`);
});