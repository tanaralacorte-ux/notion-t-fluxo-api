import "dotenv/config"
import http from "node:http"

import { Client } from "@notionhq/client"

const notion = new Client({
  auth: process.env.NOTION_API_KEY
})

const PORT = 3000

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(data, null, 2))
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""

    req.on("data", chunk => {
      body += chunk.toString()
    })

    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {}
        resolve(parsed)
      } catch {
        reject(new Error("JSON inválido no corpo da requisição"))
      }
    })

    req.on("error", () => {
      reject(new Error("Erro ao ler o corpo da requisição"))
    })
  })
}

function adicionarDias(data, dias) {
  const novaData = new Date(data)
  novaData.setDate(novaData.getDate() + Math.ceil(dias) - 1)
  return novaData
}

function montarPropertiesNotion(tarefa, projetoNotionId) {
  return {
    Nome: {
      title: [
        {
          text: {
            content: tarefa.nome
          }
        }
      ]
    },
    Fase: {
      select: { name: tarefa.fase }
    },
    Tipo: {
      select: { name: tarefa.tipo }
    },
    Status: {
      status: { name: tarefa.status }
    },
    Dependências: {
      rich_text: tarefa.dependencias
        ? [
            {
              text: {
                content: tarefa.dependencias
              }
            }
          ]
        : []
    },
    Início: {
      date: {
        start: tarefa.inicio
      }
    },
    Fim: {
      date: {
        start: tarefa.fim
      }
    },
    Duração: {
      number: tarefa.duracao
    },
    Crítica: {
      checkbox: tarefa.critica
    },
    Prioridade: {
      select: { name: tarefa.prioridade }
    },
    Energia: {
      select: { name: tarefa.energia }
    },
    "Impacto Financeiro": {
      select: { name: tarefa.impactoFinanceiro }
    },
    "Custo Estimado": {
      number: tarefa.custoEstimado
    },
    Projetos: {
      relation: [
        {
          id: projetoNotionId
        }
      ]
    }
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)

    if (url.pathname === "/" && req.method === "GET") {
      return sendJson(res, 200, {
        ok: true,
        mensagem: "Servidor v2 rodando"
      })
    }

    if (url.pathname === "/executar-projeto" && req.method === "POST") {
      const body = await parseRequestBody(req)

      console.log("Payload recebido:", body)

      if (!body.projeto || !body.tarefas) {
  return sendJson(res, 400, {
    sucesso: false,
    erro: "Payload inválido: precisa conter 'projeto' e 'tarefas'"
  })
}
if (!Array.isArray(body.tarefas)) {
  return sendJson(res, 400, {
    sucesso: false,
    erro: "Payload inválido: 'tarefas' precisa ser uma lista"
  })
}

const TIPOS_VALIDOS = ["estrategica", "operacional", "tecnica"]

const mapaFases = {
  planejamento: "Planejamento",
  programacao: "Programacao",
  execucao: "Execucao",
  controle: "Controle",
  execuo: "Execucao"
}

// 👉 AQUI entra a validação da data
if (!body.projeto || !body.projeto.dataInicioProjeto) {
  return sendJson(res, 400, {
    sucesso: false,
    erro: "Payload inválido: projeto precisa ter 'dataInicioProjeto'"
  })
}

const dataInicioProjeto = new Date(body.projeto.dataInicioProjeto)

if (isNaN(dataInicioProjeto.getTime())) {
  return sendJson(res, 400, {
    sucesso: false,
    erro: "Payload inválido: 'dataInicioProjeto' inválida"
  })
}

for (const tarefa of body.tarefas) {

  // nome
  if (!tarefa.nome || typeof tarefa.nome !== "string") {
    return sendJson(res, 400, {
      sucesso: false,
      erro: "Payload inválido: cada tarefa precisa ter 'nome'"
    })
  }

  // fase
  if (!tarefa.fase || typeof tarefa.fase !== "string") {
    return sendJson(res, 400, {
      sucesso: false,
      erro: "Payload inválido: cada tarefa precisa ter 'fase'"
    })
  }

  const faseNormalizada = tarefa.fase
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .toLowerCase()

  tarefa.fase = mapaFases[faseNormalizada] || tarefa.fase

  // tipo
  if (!tarefa.tipo || !TIPOS_VALIDOS.includes(tarefa.tipo)) {
    return sendJson(res, 400, {
      sucesso: false,
      erro: "Payload inválido: 'tipo' deve ser estrategica, operacional ou tecnica"
    })
  }

  // tempo
  if (!tarefa.tempo || typeof tarefa.tempo !== "object") {
    return sendJson(res, 400, {
      sucesso: false,
      erro: "Payload inválido: cada tarefa precisa ter 'tempo'"
    })
  }

  const { otimista, provavel, pessimista } = tarefa.tempo

  if (
    typeof otimista !== "number" ||
    typeof provavel !== "number" ||
    typeof pessimista !== "number"
  ) {
    return sendJson(res, 400, {
      sucesso: false,
      erro: "Payload inválido: tempos devem ser números"
    })
  }

  if (otimista > provavel || provavel > pessimista) {
    return sendJson(res, 400, {
      sucesso: false,
      erro: "Payload inválido: ordem dos tempos deve ser otimista <= provavel <= pessimista"
    })
  }

  const pert = (otimista + 4 * provavel + pessimista) / 6
  tarefa.tempoCalculado = pert

}

const tarefasPorFase = {}

const tarefasPorNome = Object.fromEntries(
  body.tarefas.map(t => [t.nome, t])
)

const nomesDasTarefas = Object.keys(tarefasPorNome)

const ordemDasTarefas = []

const tarefasResolvidas = new Set()

const duracaoAcumulada = {}
const datasTarefas = {}

while (ordemDasTarefas.length < body.tarefas.length) {

  let progresso = false

  for (const tarefa of body.tarefas) {
    if (tarefasResolvidas.has(tarefa.nome)) {
    continue
    }

   // 🔥 GARANTE QUE EXISTE ARRAY
    const dependencias = Array.isArray(tarefa.dependencias)
    ? tarefa.dependencias
    : []

    const podeExecutar = dependencias.every(dep =>
    tarefasResolvidas.has(dep)
    )

    if (podeExecutar) {

   let maiorTempoDependencias = 0

   for (const dep of dependencias) {
     const tempoDep = duracaoAcumulada[dep] || 0
     if (tempoDep > maiorTempoDependencias) {
      maiorTempoDependencias = tempoDep
    }
   }

   duracaoAcumulada[tarefa.nome] =
    maiorTempoDependencias + tarefa.tempoCalculado

    let dataInicioTarefa = new Date(dataInicioProjeto)

    if (dependencias.length > 0) {
      let maiorFim = new Date(dataInicioProjeto)

      for (const dep of dependencias) {
        const fimDep = datasTarefas[dep]?.fim
        if (fimDep && fimDep > maiorFim) {
        maiorFim = fimDep
      }
    }

    dataInicioTarefa = new Date(maiorFim)
    dataInicioTarefa.setDate(dataInicioTarefa.getDate() + 1)
  }

    const dataFimTarefa = adicionarDias(dataInicioTarefa, tarefa.tempoCalculado)

    datasTarefas[tarefa.nome] = {
      inicio: dataInicioTarefa,
      fim: dataFimTarefa
    }

   ordemDasTarefas.push(tarefa.nome)
   tarefasResolvidas.add(tarefa.nome)
   progresso = true
   }
  }

  if (!progresso) {
    return sendJson(res, 400, {
      sucesso: false,
      erro: "Dependências inválidas ou ciclo detectado"
    })
  }
}

for (const tarefa of body.tarefas) {

  if (!tarefasPorFase[tarefa.fase]) {
    tarefasPorFase[tarefa.fase] = []
  }

  if (!Array.isArray(tarefa.dependencias)) {
    return sendJson(res, 400, {
      sucesso: false,
      erro: "Payload inválido: 'dependencias' precisa ser uma lista"
    })
  }

  for (const dependencia of tarefa.dependencias) {
    if (!nomesDasTarefas.includes(dependencia)) {
      return sendJson(res, 400, {
        sucesso: false,
        erro: `Dependência inválida: '${dependencia}' não existe entre as tarefas`
      })
    }
  }

  tarefasPorFase[tarefa.fase].push(tarefa)
}

const tempoTotalProjeto = Math.max(...Object.values(duracaoAcumulada))
const caminhoCritico = []
let tarefaCriticaAtual = null

for (let i = ordemDasTarefas.length - 1; i >= 0; i--) {
  const nomeTarefa = ordemDasTarefas[i]
  const tarefa = tarefasPorNome[nomeTarefa]
  const tempoAcumulado = duracaoAcumulada[nomeTarefa]

  if (tempoAcumulado === tempoTotalProjeto && !tarefaCriticaAtual) {
   caminhoCritico.push(nomeTarefa)
   tarefaCriticaAtual = tarefa
   continue
  }

  if (
   tarefaCriticaAtual &&
   tarefaCriticaAtual.dependencias.includes(nomeTarefa)
   ) {
   caminhoCritico.push(nomeTarefa)
   tarefaCriticaAtual = tarefa
  }
}

caminhoCritico.reverse()

for (const tarefa of body.tarefas) {
  tarefa.cronograma = {
    inicio: datasTarefas[tarefa.nome].inicio.toISOString().split("T")[0],
    fim: datasTarefas[tarefa.nome].fim.toISOString().split("T")[0]
  }
}

const projetoCriado = await notion.pages.create({
  parent: {
    database_id: process.env.NOTION_DATABASE_PROJETOS
  },
  properties: {
    Nome: {
      title: [
        {
          text: {
            content: body.projeto.nome || "Projeto sem nome"
          }
        }
      ]
    },
    Objetivo: {
      rich_text: body.projeto.objetivo
        ? [
            {
              text: {
                content: body.projeto.objetivo
              }
            }
          ]
        : []
    },
    DataInicioProjeto: {
      date: {
        start: body.projeto.dataInicioProjeto
      }
    },
  }
})

const projetoNotionId = projetoCriado.id

const tarefasFormatadas = body.tarefas.map((t, index) => ({
  nome: t.nome,
  fase: t.fase,
  tipo: t.tipo,
  status: "Não iniciada",
  dependencias: Array.isArray(t.dependencias) ? t.dependencias.join(", ") : "",
  inicio: t.cronograma.inicio,
  fim: t.cronograma.fim,
  duracao: Number(t.tempoCalculado.toFixed(2)),
  critica: caminhoCritico.includes(t.nome),
  prioridade: t.prioridade || "Média",
  energia: t.energia || "Média",
  impactoFinanceiro: t.impactoFinanceiro || "Médio",
  custoEstimado: typeof t?.custo?.estimado === "number" ? t.custo.estimado : 0,
  ordem: index + 1
}))

for (const tarefa of tarefasFormatadas) {
  console.log(JSON.stringify(montarPropertiesNotion(tarefa, projetoNotionId), null, 2))
  await notion.pages.create({
    parent: {
      database_id: process.env.NOTION_DATABASE_TAREFAS
    },
    properties: montarPropertiesNotion(tarefa, projetoNotionId)  
  })
}

return sendJson(res, 200, {
  sucesso: true,
  mensagem: "Payload válido, estruturado e ordenado",
  tempoTotalProjeto: tempoTotalProjeto,
  caminhoCritico: caminhoCritico,
  ordem: ordemDasTarefas,
  tarefas: tarefasFormatadas,
  fases: tarefasPorFase
})
    }

    return sendJson(res, 404, {
      sucesso: false,
      erro: "Rota não encontrada"
    })
  } catch (error) {
    console.error("Erro no servidor:", error)

    return sendJson(res, 500, {
      sucesso: false,
      erro: error.message || "Erro interno do servidor"
    })
  }
})

server.listen(PORT, () => {
  console.log(`Servidor v2 rodando em http://localhost:${PORT}`)
})
