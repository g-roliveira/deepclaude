# Surgical Refactor — skill local do projeto

Implementação reutilizável para remoções de funcionalidades/providers, com
discovery, baseline, remoção por AST, verificação, CI e relatório de evidências.
A instalação da skill não removeu providers por conta própria. Em tarefas
posteriores autorizadas, foram removidos o suporte nativo Windows e os providers
além de DeepSeek e Anthropic. A policy está em `enforce` para ambas as remoções.
Veja [o relatório dos providers](provider-removal.md).

## Descoberta e escolhas

- Stack: JavaScript ESM, Node HTTP/streams sem dependências de runtime, testes
  nativos `node:test`, launcher Bash, sem framework/build/typecheck.
- O inventário inicial não encontrou ast-grep, Knip, Semgrep, dependency-cruiser,
  jscodeshift ou Stryker no PATH/npm global. `/usr/bin/sg` não é ast-grep.
- Não havia MCP Semgrep exposto ou configurado. Nenhum servidor MCP foi instalado.
- Python padrão: 3.14; Python 3.12 já disponível e usado somente no venv local.
- Ferramentas JS instaladas em `.agents/skills/surgical-refactor/tooling/node_modules`;
  Semgrep em `tooling/.venv`. Nenhuma instalação global de ferramenta ou skill.
- `package.json` raiz é privado, declara ESM e comandos de desenvolvimento;
  não adiciona dependências de runtime. Locks npm/Python ficam na área de tooling.
- Branch de trabalho: `feat/surgical-refactor-skill`. As alterações já existentes
  do proxy/documentação foram preservadas sem reset, stash ou commit automático.

## Descoberta pelos dois agentes

Fonte única: [.agents/skills/surgical-refactor/SKILL.md](../.agents/skills/surgical-refactor/SKILL.md).
Claude Code recebe a mesma pasta por `.claude/skills/surgical-refactor`, um link
relativo local para a fonte canônica. Nenhum arquivo em `~/.claude/skills` ou
`~/.codex/skills` foi alterado. Pode ser necessário abrir uma nova sessão para
que o agente atualize a lista de skills.

Claude Code:

```text
/surgical-refactor Remova todos os providers LLM, exceto DeepSeek, elimine apenas o código órfão comprovado e valide as regressões.
```

Codex:

```text
Use $surgical-refactor para remover todos os providers LLM, exceto DeepSeek, preservar os componentes compartilhados e validar as regressões.
```

Esses são exemplos para uma tarefa futura. Nomes de protocolo `ANTHROPIC_*` e o
bridge remoto não são removidos por simples correspondência textual.

## Arquivos entregues

| Área | Conteúdo |
| --- | --- |
| `.agents/skills/surgical-refactor/SKILL.md` | Workflow obrigatório das seis fases e regras de segurança |
| `references/` | Protocolo detalhado e adaptação das ferramentas |
| `scripts/bootstrap.mjs` | Instalação isolada com lockfiles e reutilização de Semgrep existente |
| `scripts/refactor.mjs` | Inventory, baseline, analyze, guard, verify, mutation e report |
| `config/` | ast-grep, Semgrep, Knip, dependency-cruiser e Stryker |
| `examples/` | Policy DeepSeek-only e codemod conservador para imports |
| `tests/` | Testes da própria skill, incluindo Knip real em projeto temporário |
| `.surgical-refactor/` | Configuração ativa, contratos e baseline revisável |
| `.github/workflows/surgical-refactor.yml` | CI usando checks locais, policy, análise estática e mutation gate |
| `proxy/upstream-path.test.js` | Caracterização adicional do roteamento de paths/queries |

## Uso e evidências

```bash
npm run refactor:setup
npm run refactor:inventory -- --target deepseek
npm run refactor:analyze
npm run refactor:selftest
npm run refactor:verify
npm run refactor:mutation
node .agents/skills/surgical-refactor/scripts/refactor.mjs report
```

Para outra remoção, revise contratos/config antes de executar:

```bash
npm run refactor:baseline -- --branch refactor/nome-da-remocao
```

Como já existe um baseline revisado, uma nova captura exige inspeção e a opção
explícita `--accept-baseline`. Não use essa opção no CI nem para absorver findings
introduzidos por uma remoção. O scanner falha em erros de parser/configuração ou
escopo JS/TS vazio; não baixa ferramentas automaticamente durante verificação.

Os artefatos de execução ficam em `.surgical-refactor/artifacts` (ignorado pelo
Git). `inventory.json` fornece imports/reexports/exports e gaps de imports
computados; `graph.mmd` e o JSON do dependency-cruiser fornecem o grafo de módulos.
O helper não classifica ownership nem calcula um call graph interprocedural.

## Baseline e validação da instalação original da skill

Os números e checks desta seção registram o estado anterior à remoção de suporte
nativo Windows. Para a verificação atual, consulte [os providers](provider-removal.md)
e [a remoção Windows](windows-removal.md).

- Antes: 52 regressões existentes aprovadas, sem falhas preexistentes observadas.
- Depois: 53 regressões do proxy (uma caracterização nova) e 13 testes da skill.
- Análises do escopo do proxy: Knip, dependency-cruiser, ast-grep e Semgrep sem
  findings; isso não certifica código fora de sourceRoots/configurationFiles.
- Sintaxe do proxy/launcher Node, Bash e PowerShell verificada.
- Cobertura nativa do código de produção `model-proxy.js`: 86,79% das linhas,
  84,57% das ramificações e 82,56% das funções. Não inclui inflação pelos testes
  e não mede equivalência semântica. Log em `artifacts/verify/coverage.stdout.log`.
- `SKILL.md` validado pelo validador do skill-creator.
- Mutation testing executado no range de `buildUpstreamPath`, em sandbox,
  usando o command runner embutido do StrykerJS.

### Mutation testing

O teste anterior de paths detectou **43,75%** no range selecionado (13 killed,
1 timeout, 18 survived em 32 mutantes). Isso revelou lacunas em queries ausentes,
barras finais e sobreposição de path, sem demonstrar um defeito no código original.

Após acrescentar caracterizações de comportamento, o mesmo range obteve
**96,88%**: **29 killed, 2 timeout, 1 survived**, sem erros ou NoCoverage.
Os timeouts vieram de mutantes que transformam o loop em um laço sem fim.
O sobrevivente troca `Math.min` por `Math.max` no limite do loop: os prefixos
extras não mudam o path resultante porque substring é limitado ao tamanho do
pathname. Ele é possivelmente equivalente para a saída, mas pode fazer mais
iterações; não foi excluído para inflar o score.

O gate de CI exige 90% **nesse range**, não no proxy inteiro. CoverageAnalysis
fica off porque o runner command não oferece análise por teste. Cobertura de
linha, score de mutação e equivalência semântica são medidas diferentes.

## Guardas de remoção

Atualmente `policy.mode=enforce` impede a reintrodução do launcher nativo removido,
de caminhos exclusivos de plataforma e dos providers aposentados. Os nomes destes
podem aparecer em testes negativos e relatórios históricos; a proibição textual
tem escopo nos três arquivos de implementação, além dos testes de registros/CLI.
Para outra remoção
real, configurar `enforce`, `removedFeature`, módulos/símbolos/paths proibidos e
referências de configuração nos caminhos reais. Imports dinâmicos literais,
reexports e pacotes declarados são verificados; imports computados requerem
revisão e testes de registro. Policy enforce vazia é rejeitada.

O CI compara findings estáveis com o baseline, preserva exports/entry points
declarados e executa os checks obrigatórios. Falhas obrigatórias continuam
bloqueando, mesmo se fossem preexistentes. O workflow não regenera baseline e
não executa testes reais contra produção. Ele foi criado e seus comandos foram
executados localmente; uma execução hospedada no GitHub ainda depende de commit/push.

## Riscos residuais

- Ausência de referência estática não prova código morto; plugins/config/shell
  e APIs públicas externas exigem revisão humana.
- O exemplo de codemod recusa side effects e bindings referenciados; ele não
  remove automaticamente adapters/factories nem faz pruning em massa.
- Não há build/type checking/E2E estabelecidos neste projeto. Isso é registrado
  como não aplicável/não disponível, não como testes aprovados.
- Os testes do proxy usam upstream simulado; serviços reais e regressões de
  terceiros não foram certificados nesta entrega.
- Os testes de policy exercitam guardas em fixtures; a policy ativa também proíbe
  referências reais aos providers removidos nos entry points de produção.
