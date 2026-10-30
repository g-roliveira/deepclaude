# Identificação de código morto e resíduos

> Registro histórico anterior à remoção de suporte Windows. Os achados relativos
> ao launcher PowerShell foram resolvidos pela remoção completa desse launcher,
> não pela implementação das correções sugeridas. Consulte `windows-removal.md`.

Data: 2026-10-29. Etapa: discovery/identificação com `surgical-refactor`.
Nenhum código, provider, arquivo de imagem ou log foi removido. As mudanças
preexistentes no worktree foram preservadas. Somente este relatório foi criado.

## Evidências executadas

- `refactor.mjs analyze`: Knip, dependency-cruiser, ast-grep e Semgrep sem findings
  ou falhas de ferramenta no escopo configurado em `proxy/`.
- AST adicional com Babel: bindings/imports locais não referenciados no proxy,
  launcher Node e scripts da skill. Nenhum candidato funcional confirmado; o
  único parâmetro não lido no proxy é `_enc`, parte da assinatura do Transform.
- Revisão dos consumidores externos de campos da classe, funções shell,
  configurações, exports públicos e entradas de CLI.
- `refactor.mjs verify`: 53 testes do proxy e 13 testes da skill aprovados;
  sintaxe Node/Bash/PowerShell e cobertura nativa executadas.
- Cobertura de `model-proxy.js`: 86,79% linhas, 84,57% ramificações, 82,56% funções.
- Mutation testing não foi reexecutado nesta identificação: nenhum caminho de
  produção foi alterado. O resultado anterior não certifica uma remoção futura.

Grafo: `.surgical-refactor/artifacts/analyze/graph.mmd` e `graph.stdout.log`.
Verificação: `.surgical-refactor/artifacts/verify/verification.json`.

**Conclusão:** não apareceu um conjunto de funções/arquivos JS comprovadamente
inúteis para deletar em massa. Existem redundâncias pequenas, resíduos documentais
e ativos candidatos. Falta de findings não prova ausência de código morto.

## Redundâncias confirmadas — candidatas a um primeiro corte

| Item | Local | Evidência | Classificação |
| --- | --- | --- | --- |
| Segundo `delete parsed.context_management` | `proxy/model-proxy.js:445` | A linha imediatamente anterior chama `prepareBackendOptions`, que já remove o campo na linha 452. O objeto vem do JSON e a operação já ocorreu. | Redundância de baixo risco; não é uma função órfã. |
| Segundo cálculo de `$ScriptDir` | `deepclaude.ps1:353` | A mesma variável foi definida na linha 38; não há redefinição intermediária no script. | Atribuição repetida, candidata de baixo risco. |
| Normalização antecipada `op → openrouter` | `proxy/start-proxy.js:15` | `startModelProxy` já normaliza os aliases antes de selecionar backend/model override. A variável só alimenta essa chamada. | Compatibilidade duplicada; centralização pode simplificar sem remover o modo legado. |
| Segundo operando de `fallbackUrl` | `proxy/start-proxy.js:43` | O loop standalone sempre cria `backends.deepseek` com URL fixa e não vazia de BACKEND_DEFS, mesmo sem chave. | Fallback não alcançado sob as invariantes atuais; manter defesa também é uma opção válida. |

Uma limpeza posterior deve comparar os contratos e testar os modos standalone e
legado antes de remover as compatibilidades. Não remover a entrada CLI junto com
uma normalização redundante.

## Duplicação que exige refatoração, não eliminação simples

- `launch_claude` e `launch_remote` repetem criação do proxy, espera pela porta e
  limpeza de temporário em Bash. PowerShell repete um fluxo semelhante. Os dois
  fluxos estão ativos e têm autenticação diferente; não são código morto.
- A requisição visual passa por `prepareBackendOptions` no preparo de visão e
  novamente na normalização final de model calls. É duplicação idempotente no
  fluxo atual, mas os ramos não visuais dependem da normalização final.
- `containsImageBlock`, `stripImagesFromMessages` e `imageBlocksIn` percorrem
  estruturas semelhantes. Têm retornos e efeitos distintos; todos possuem uso.

## Resíduos documentais — prioridade prática alta

| Arquivo | Problema observado |
| --- | --- |
| `AGENTS.md:7-25` | Descreve o produto/execução como Codex, embora os scripts executem `claude`; também descreve um modo direto sem proxy que não corresponde ao launcher atual. |
| `AGENTS.md:52-54` | Afirma não existirem testes, package.json ou tooling, contradizendo a árvore atual. Não é ausência de testes, é documentação antiga. |
| `README.md:11-18,192,220,233-235` | Mantém trechos/tabelas antigos de V4 Pro e preços que divergem do backend Flash padrão e da seção nova. Não se deve fazer substituição global porque OpenRouter/Fireworks continuam com IDs próprios. |
| `proxy/README.md:9-12,29` | Apresenta apenas remote-control e roteamento antigo; exemplo usa V4 Pro. Não descreve Files e rejeição explícita de protocolos separados. |
| `deepclaude.sh:195-206` / `deepclaude.ps1:180-192` | A saída `--cost` ainda exibe a tabela antiga, diferente da tabela atual de estimativa no proxy. É código ativo com dados desatualizados, não código morto. |

Os números de preço acima não foram reconsultados na API nesta identificação;
a inconsistência apontada é entre os próprios arquivos locais. Atualização
financeira deve verificar a fonte oficial antes de alterar valores.

## Arquivos e dados locais

- `screenshots/terminal for terminal embed2.PNG`: 33.582 bytes.
- `screenshots/terminal for vscode embed2.PNG`: 9.924 bytes.

Esses dois arquivos não aparecem nas referências internas revisadas; são
candidatos a ativos documentais órfãos (43.506 bytes no total), não comprovadamente
inúteis para consumidores externos. A imagem `remote-control-deepseek.png` é usada
pelo README e deve ser preservada.

O diretório `.deepclaude` ocupa aproximadamente 12 MiB e guarda logs solicitados
para diagnóstico. Não classificá-lo como lixo sem definir uma política de retenção.
Os artefatos de análise ocupavam menos de 1 MiB na medição desta etapa.

`tooling/node_modules` ocupa aproximadamente 215 MiB e o venv Semgrep, 344 MiB.
São ferramentas de desenvolvimento ativamente usadas nesta análise, ignoradas
pelo Git e reconstruíveis pelos locks. Não são dependências órfãs do runtime.

## Falsos positivos descartados

- `_respBytes`, `_sawInputUsage` e `_sawOutputUsage` pareciam write-only numa
  análise restrita a `this.*`, mas são lidos como `norm.*` pelo logger SSE nas
  linhas 1311-1313. Excluir esses campos quebraria a telemetria.
- `_enc` não é usado pelo corpo, mas mantém a posição do callback em
  `_transform(chunk, _enc, cb)`. Remover o parâmetro do meio sem ajustar a
  assinatura quebraria o Transform.
- `getInFlightCount` é consumido por testes de graceful shutdown e faz parte
  do objeto público retornado. Ausência de consumidor em outro módulo de
  produção não prova inutilidade.
- O mock de títulos está desligado por padrão, porém é ativável por opção/env.
  Pode ser aposentado por decisão de produto, mas não é inalcançável.
- Os providers OpenRouter/MiniMax/Fireworks/Anthropic continuam conectados aos
  launchers e ao live switch. Não são código morto por o padrão ser DeepSeek.
- A skill, os exemplos e as configurações de análise são artefatos de
  desenvolvimento; não precisam participar da execução do proxy para serem úteis.

## Problemas funcionais vistos durante a revisão

Não são candidatos a simplesmente apagar código:

1. **Fallthrough no Bash em modo Anthropic:** `launch_claude` chama `claude` na
   linha 286 e continua em `resolve_backend` na 289 ao encerrar; `launch_remote`
   tem o mesmo padrão nas linhas 340/343. Falta uma saída explícita do ramo.
   A revisão do fluxo é estática; não abri uma sessão real para reproduzi-lo.
2. **Escopo do log no PowerShell:** `$SessionLog` é inicializado no script, mas
   a função `Initialize-SessionLog` atribui uma variável local na linha 76. O
   caller usa `$SessionLog` em RedirectStandardError. Uma reprodução mínima em
   PowerShell confirmou que a atribuição local deixa o valor externo nulo. O
   launcher completo não foi executado com credenciais reais.

Esses achados mostram limites dos testes atuais: análise sintática e testes do
proxy não cobrem todos os fluxos de execução dos launchers.

## Ordem recomendada

1. Corrigir os dois problemas de launcher com testes de CLI isolados.
2. Remover redundâncias comprovadas e sincronizar a documentação com o código.
3. Decidir sobre os dois screenshots e sobre aposentadoria do mock legado.
4. Só depois considerar extração do bootstrap compartilhado dos launchers.

Esta etapa identifica e prioriza. Nenhum guard de funcionalidade removida foi
armado; a policy permanece em `observe`, pois nada foi removido.
