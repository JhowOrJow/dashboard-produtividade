let prodGlobal = [], refugoGlobal = [];
let chartProd, chartRef, chartCompProd, chartCompRefQtd, chartCompRefPct, chartConsolidated;
let viewStateRef = 'setor';

const mesesLabels = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

document.addEventListener('DOMContentLoaded', async () => {
    // Inicialização do ECharts com Tema Dark
    try {
        chartProd = echarts.init(document.getElementById('chartProd'), 'dark');
        chartRef = echarts.init(document.getElementById('chartRef'), 'dark');
        chartCompProd = echarts.init(document.getElementById('chartCompProd'), 'dark');
        chartCompRefQtd = echarts.init(document.getElementById('chartCompRefQtd'), 'dark');
        chartCompRefPct = echarts.init(document.getElementById('chartCompRefPct'), 'dark');
        chartConsolidated = echarts.init(document.getElementById('chartCompConsolidado'), 'dark');
    } catch (e) { console.error("Erro na inicialização dos gráficos:", e); }

    await carregarDadosDivididos();

    document.getElementById('btnFiltrar').onclick = filtrarEProcessar;
    document.getElementById('btnVoltarRef').onclick = () => { 
        viewStateRef = 'setor'; 
        filtrarEProcessar(); 
    };

    chartRef.on('click', (p) => {
        if(viewStateRef === 'setor') {
            viewStateRef = 'maquina';
            filtrarEProcessar(p.name);
        }
    });

    window.onresize = () => {
        const instances = [chartProd, chartRef, chartCompProd, chartCompRefQtd, chartCompRefPct, chartConsolidated];
        instances.forEach(i => { if(i) i.resize(); });
    };
});

async function carregarDadosDivididos() {
    try {
        // Carregamento paralelo dos 4 arquivos para máxima performance
        const [p25, p26, r25, r26] = await Promise.all([
            fetch('./data/produtividade_2025.json').then(r => r.json()),
            fetch('./data/produtividade_2026.json').then(r => r.json()),
            fetch('./data/refugo_2025.json').then(r => r.json()),
            fetch('./data/refugo_2026.json').then(r => r.json())
        ]);
        
        prodGlobal = [...p25, ...p26];
        refugoGlobal = [...r25, ...r26];
        
        popularSeletorSetores();
        filtrarEProcessar();
    } catch (e) {
        console.error("Erro ao ler arquivos fracionados. Verifique se os nomes estão corretos.", e);
    }
}

function popularSeletorSetores() {
    const setores = [...new Set(refugoGlobal.map(i => i.Setor))].sort();
    const select = document.getElementById('filterSetor');
    setores.forEach(s => { if(s) select.add(new Option(s, s)); });
}

function switchTab(nome) {
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + nome).classList.add('active');
    document.getElementById('btnTab' + (nome === 'geral' ? 'Geral' : 'Mensal')).classList.add('active');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
}

function filtrarEProcessar(drillName = null) {
    const start = document.getElementById('dateStart').value;
    const end = document.getElementById('dateEnd').value;
    const sector = document.getElementById('filterSetor').value;

    const fnFilter = (list, key) => list.filter(i => {
        const d = i[key].split('T')[0];
        return (!start || d >= start) && (!end || d <= end);
    });

    const pF = fnFilter(prodGlobal, 'DATA');
    let rF = fnFilter(refugoGlobal, 'Data');
    if(sector !== 'todos') rF = rF.filter(i => i.Setor === sector);

    renderKPIs(pF, rF);
    renderAbaGeral(pF, rF, drillName);
    renderAbaComparativa(sector);
}

function renderKPIs(p, r) {
    const sumP = p.reduce((a, b) => a + (b.QUANTIDADE || 0), 0);
    const sumR = r.reduce((a, b) => a + (b.Qtde_Total || 0), 0);
    const yield = sumP > 0 ? (100 - (sumR / sumP * 100)).toFixed(1) : 100;

    document.getElementById('totalProduzido').innerText = sumP.toLocaleString('pt-BR');
    document.getElementById('totalRefugo').innerText = sumR.toLocaleString('pt-BR');
    document.getElementById('percentualQualidade').innerText = yield + "%";
}

function renderAbaGeral(p, r, dName) {
    const maqMap = {};
    p.forEach(i => maqMap[i.MAQUINA] = (maqMap[i.MAQUINA] || 0) + i.QUANTIDADE);
    chartProd.setOption({
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: Object.keys(maqMap), axisLabel: { rotate: 45 } },
        yAxis: { type: 'value' },
        series: [{ name: 'Peças', type: 'bar', data: Object.values(maqMap), itemStyle: { color: '#10b981' }, label: { show: true, position: 'top' } }]
    });

    let refData = {}, title = "Refugo por Setor";
    const btn = document.getElementById('btnVoltarRef');
    if (viewStateRef === 'setor') {
        r.forEach(i => refData[i.Setor] = (refData[i.Setor] || 0) + i.Qtde_Total);
        btn.style.display = 'none';
    } else {
        r.filter(i => i.Setor === dName).forEach(i => refData[i.Cod_Maquina] = (refData[i.Cod_Maquina] || 0) + i.Qtde_Total);
        title = "Setor: " + dName;
        btn.style.display = 'block';
    }
    document.getElementById('titleRef').innerText = title;
    chartRef.setOption({
        tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
        series: [{ type: 'pie', radius: ['40%','70%'], data: Object.entries(refData).map(([name, value]) => ({ name, value })), label: { show: true } }]
    }, true);
}

function renderAbaComparativa(sectorFilter) {
    const p25 = new Array(12).fill(0), p26 = new Array(12).fill(0);
    const r25 = new Array(12).fill(0), r26 = new Array(12).fill(0);

    prodGlobal.forEach(i => {
        const d = new Date(i.DATA);
        if(d.getFullYear() === 2025) p25[d.getMonth()] += i.QUANTIDADE;
        if(d.getFullYear() === 2026) p26[d.getMonth()] += i.QUANTIDADE;
    });

    let rBase = refugoGlobal;
    if(sectorFilter !== 'todos') rBase = rBase.filter(i => i.Setor === sectorFilter);
    rBase.forEach(i => {
        const d = new Date(i.Data);
        if(d.getFullYear() === 2025) r25[d.getMonth()] += i.Qtde_Total;
        if(d.getFullYear() === 2026) r26[d.getMonth()] += i.Qtde_Total;
    });

    const pct25 = p25.map((p, i) => p > 0 ? (r25[i]/p*100).toFixed(2) : 0);
    const pct26 = p26.map((p, i) => p > 0 ? (r26[i]/p*100).toFixed(2) : 0);

    const barOpt = (d25, d26, c1, c2) => ({
        tooltip: { trigger: 'axis' }, legend: { bottom: 0 },
        xAxis: { type: 'category', data: mesesLabels }, yAxis: { type: 'value' },
        series: [
            { name: '2025', type: 'bar', data: d25, itemStyle: { color: c1 }, label: { show: true, position: 'top', rotate: 90 } },
            { name: '2026', type: 'bar', data: d26, itemStyle: { color: c2 }, label: { show: true, position: 'top', rotate: 90 } }
        ]
    });

    chartCompProd.setOption(barOpt(p25, p26, '#38bdf8', '#818cf8'));
    chartCompRefQtd.setOption(barOpt(r25, r26, '#fb7185', '#ef4444'));

    chartCompRefPct.setOption({
        tooltip: { trigger: 'axis' }, legend: { bottom: 0 },
        xAxis: { type: 'category', data: mesesLabels }, yAxis: { type: 'value', axisLabel: { formatter: '{value}%' } },
        series: [
            { name: '2025', type: 'line', data: pct25, smooth: true, itemStyle: { color: '#facc15' }, label: { show: true, formatter: '{c}%' } },
            { name: '2026', type: 'line', data: pct26, smooth: true, itemStyle: { color: '#fb923c' }, label: { show: true, formatter: '{c}%' } }
        ]
    });

    chartConsolidated.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
        legend: { bottom: 0 },
        xAxis: { type: 'category', data: mesesLabels },
        yAxis: [{ type: 'value', name: 'Qtd' }, { type: 'value', name: '%', position: 'right', max: 10, axisLabel: { formatter: '{value}%' } }],
        series: [
            { name: 'Prod 25', type: 'bar', data: p25, itemStyle: { color: 'rgba(56, 189, 248, 0.4)' } },
            { name: 'Prod 26', type: 'bar', data: p26, itemStyle: { color: 'rgba(129, 140, 248, 0.4)' } },
            { name: 'Ref 25', type: 'bar', data: r25, itemStyle: { color: 'rgba(251, 113, 133, 0.8)' } },
            { name: 'Ref 26', type: 'bar', data: r26, itemStyle: { color: 'rgba(239, 68, 68, 0.8)' } },
            { name: '% 25', type: 'line', yAxisIndex: 1, data: pct25, itemStyle: { color: '#facc15' } },
            { name: '% 26', type: 'line', yAxisIndex: 1, data: pct26, itemStyle: { color: '#fb923c' } }
        ]
    });
}