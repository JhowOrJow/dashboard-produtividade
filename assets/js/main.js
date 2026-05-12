let rawProd = [], rawRef = [];
let chartProd, chartRef;
let viewProd = 'maquina', viewRef = 'setor'; // Estados do Drilldown

document.addEventListener('DOMContentLoaded', async () => {
    chartProd = echarts.init(document.getElementById('chartProd'), 'dark');
    chartRef = echarts.init(document.getElementById('chartRef'), 'dark');

    await carregarDados();
    
    document.getElementById('btnFiltrar').onclick = processar;
    document.getElementById('btnVoltarProd').onclick = () => { viewProd = 'maquina'; processar(); };
    document.getElementById('btnVoltarRef').onclick = () => { viewRef = 'setor'; processar(); };

    // Eventos de clique para DRILLDOWN
    chartRef.on('click', (params) => {
        if(viewRef === 'setor') {
            viewRef = 'maquina_no_setor';
            processar(params.name); // Passa o setor clicado
        }
    });

    window.onresize = () => { chartProd.resize(); chartRef.resize(); };
});

async function carregarDados() {
    try {
        const [p, r] = await Promise.all([
            fetch('./data/produtividade.json').then(res => res.json()),
            fetch('./data/refugo.json').then(res => res.json())
        ]);
        rawProd = p; rawRef = r;
        popularSetores();
        processar();
    } catch (e) { console.error("Erro ao carregar arquivos:", e); }
}

function popularSetores() {
    const setores = [...new Set(rawRef.map(i => i.Setor))];
    const select = document.getElementById('filterSetor');
    setores.forEach(s => select.add(new Option(s, s)));
}

function processar(drilldownName = null) {
    const start = document.getElementById('dateStart').value;
    const end = document.getElementById('dateEnd').value;
    const setorSel = document.getElementById('filterSetor').value;

    const filtrar = (data, dateKey) => data.filter(i => {
        const d = i[dateKey].split('T')[0];
        return (!start || d >= start) && (!end || d <= end);
    });

    const pFiltrado = filtrar(rawProd, 'DATA');
    let rFiltrado = filtrar(rawRef, 'Data');

    if(setorSel !== 'todos') rFiltrado = rFiltrado.filter(i => i.Setor === setorSel);

    renderCards(pFiltrado, rFiltrado);
    renderChartProd(pFiltrado);
    renderChartRef(rFiltrado, drilldownName);
}

function renderCards(p, r) {
    const totP = p.reduce((a, b) => a + b.QUANTIDADE, 0);
    const totR = r.reduce((a, b) => a + b.Qtde_Total, 0);
    const qual = totP > 0 ? (100 - (totR / totP * 100)).toFixed(1) : 100;

    document.getElementById('totalProduzido').innerText = totP.toLocaleString();
    document.getElementById('totalRefugo').innerText = totR.toLocaleString();
    document.getElementById('percentualQualidade').innerText = qual + "%";
}

function renderChartProd(data) {
    const group = {};
    data.forEach(i => group[i.MAQUINA] = (group[i.MAQUINA] || 0) + i.QUANTIDADE);
    
    const options = {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: Object.keys(group), axisLabel: { rotate: 45 } },
        yAxis: { type: 'value' },
        series: [{ data: Object.values(group), type: 'bar', itemStyle: { color: '#10b981' }, showBackground: true, backgroundStyle: { color: 'rgba(180, 180, 180, 0.1)' } }]
    };
    chartProd.setOption(options);
}

function renderChartRef(data, drillName) {
    let group = {}, title = "Refugo por Setor", label = "Setores";
    const btn = document.getElementById('btnVoltarRef');

    if (viewRef === 'setor') {
        data.forEach(i => group[i.Setor] = (group[i.Setor] || 0) + i.Qtde_Total);
        btn.style.display = 'none';
    } else {
        // DRILLDOWN: Mostra máquinas apenas do setor clicado
        const filtered = data.filter(i => i.Setor === drillName);
        filtered.forEach(i => group[i.Cod_Maquina] = (group[i.Cod_Maquina] || 0) + i.Qtde_Total);
        title = `Máquinas em: ${drillName}`;
        btn.style.display = 'block';
    }

    document.getElementById('titleRef').innerText = title;

    const chartData = Object.entries(group).map(([name, value]) => ({ name, value }));

    const options = {
        backgroundColor: 'transparent',
        tooltip: { trigger: 'item' },
        series: [{
            type: 'pie',
            radius: ['40%', '70%'],
            avoidLabelOverlap: false,
            itemStyle: { borderRadius: 10, borderColor: '#0f172a', borderWidth: 2 },
            label: { show: true, color: '#fff' },
            data: chartData
        }]
    };
    chartRef.setOption(options, true);
}