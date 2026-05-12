const API_URL = "http://localhost:3300"; // Usado apenas para o botão Sync
let dadosProducaoOriginal = [];
let dadosRefugoOriginal = [];
let chartProd, chartRef;

// 1. Ao carregar a página, lê os arquivos JSON
document.addEventListener('DOMContentLoaded', async () => {
    await carregarDadosLocais();
    
    document.getElementById('btnFiltrar').addEventListener('click', processarDashboard);
    document.getElementById('btnSync').addEventListener('click', sincronizarComBanco);
});

async function carregarDadosLocais() {
    try {
        const [resProd, resRef] = await Promise.all([
            fetch('./data/produtividade.json'),
            fetch('./data/refugo.json')
        ]);

        dadosProducaoOriginal = await resProd.json();
        dadosRefugoOriginal = await resRef.json();

        popularFiltroSetor();
        processarDashboard(); // Renderiza inicial
    } catch (error) {
        console.error("Erro ao carregar JSONs:", error);
    }
}

function popularFiltroSetor() {
    const setores = [...new Set(dadosRefugoOriginal.map(i => i.Setor))];
    const select = document.getElementById('filterSetor');
    setores.forEach(setor => {
        const opt = document.createElement('option');
        opt.value = setor;
        opt.textContent = setor;
        select.appendChild(opt);
    });
}

function processarDashboard() {
    const start = document.getElementById('dateStart').value;
    const end = document.getElementById('dateEnd').value;
    const setorSel = document.getElementById('filterSetor').value;

    // Filtrar Produção
    let prodFiltrada = dadosProducaoOriginal.filter(item => {
        const dataItem = item.DATA.split('T')[0];
        const bateData = (!start || dataItem >= start) && (!end || dataItem <= end);
        return bateData;
    });

    // Filtrar Refugo
    let refFiltrado = dadosRefugoOriginal.filter(item => {
        const dataItem = item.Data.split('T')[0];
        const bateData = (!start || dataItem >= start) && (!end || dataItem <= end);
        const bateSetor = setorSel === 'todos' || item.Setor === setorSel;
        return bateData && bateSetor;
    });

    renderizarCards(prodFiltrada, refFiltrado);
    renderizarGraficos(prodFiltrada, refFiltrado);
}

function renderizarCards(prod, ref) {
    const totalP = prod.reduce((sum, item) => sum + item.QUANTIDADE, 0);
    const totalR = ref.reduce((sum, item) => sum + item.Qtde_Total, 0);
    const perc = totalP > 0 ? ((totalR / totalP) * 100).toFixed(2) : 0;

    document.getElementById('totalProduzido').innerText = totalP.toLocaleString();
    document.getElementById('totalRefugo').innerText = totalR.toLocaleString();
    document.getElementById('percentualRefugo').innerText = perc + "%";
}

function renderizarGraficos(prod, ref) {
    // Agrupar Prod por Máquina
    const maqMap = {};
    prod.forEach(i => maqMap[i.MAQUINA] = (maqMap[i.MAQUINA] || 0) + i.QUANTIDADE);

    // Agrupar Ref por Setor
    const setorMap = {};
    ref.forEach(i => setorMap[i.Setor] = (setorMap[i.Setor] || 0) + i.Qtde_Total);

    if (chartProd) chartProd.destroy();
    if (chartRef) chartRef.destroy();

    const ctxP = document.getElementById('chartProdutividade').getContext('2d');
    chartProd = new Chart(ctxP, {
        type: 'bar',
        data: {
            labels: Object.keys(maqMap),
            datasets: [{ label: 'Qtd Produzida', data: Object.values(maqMap), backgroundColor: '#4caf50' }]
        },
        options: { responsive: true, scales: { y: { beginAtZero: true } } }
    });

    const ctxR = document.getElementById('chartRefugo').getContext('2d');
    chartRef = new Chart(ctxR, {
        type: 'pie',
        data: {
            labels: Object.keys(setorMap),
            datasets: [{ data: Object.values(setorMap), backgroundColor: ['#f44336', '#ff9800', '#2196f3', '#9c27b0'] }]
        }
    });
}

// Essa função só funcionará se o Node estiver rodando localmente
async function sincronizarComBanco() {
    const start = document.getElementById('dateStart').value;
    const end = document.getElementById('dateEnd').value;
    if (!start || !end) return alert("Selecione as datas para sincronizar!");

    try {
        await fetch(`${API_URL}/api/sync-prod?start=${start}&end=${end}`);
        await fetch(`${API_URL}/api/sync-scrap?start=${start}&end=${end}`);
        alert("Arquivos JSON atualizados com sucesso!");
        location.reload();
    } catch (e) { alert("Erro: O servidor Node.js não está respondendo."); }
}