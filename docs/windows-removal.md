# Remoção do suporte nativo Windows

Escopo autorizado: remover a implementação própria de Windows, preservando o
launcher Bash/Linux, o proxy Node e todos os providers. Branch:
`refactor/remove-windows`. Nenhuma credencial, sessão ou instalação global foi alterada.

## Inventário e impacto

| Unidade | Classificação | Resultado |
| --- | --- | --- |
| `deepclaude.ps1` | Launcher exclusivo da plataforma removida | Arquivo removido integralmente, incluindo logging, lifecycle, providers, benchmark, controle remoto e configuração de ambiente em PowerShell |
| Teste de paridade em `proxy/deepseek-compat.test.js` | Contrato antigo com consumidor removido | Mantida a regressão de headroom do Bash, incluindo limite padrão e override |
| Config/contratos da skill | Registro do entry point e check de sintaxe removidos | Nenhum check ativo chama pwsh ou depende do launcher removido |
| `bootstrap.mjs`, `refactor.mjs` | Branches específicas de executáveis | Removidas escolhas win32, `.cmd` e venv `Scripts/*.exe`; mantidos caminhos POSIX |
| Exemplo de policy da skill | Referência a arquivo inexistente após o corte | Caminhos exclusivos removidos do exemplo |
| README, AGENTS e CLAUDE | Instruções de instalação, arquitetura e paridade | Atualizados para launcher Bash; retirada a instalação PowerShell |
| Proxy Node, providers, Bash, API Anthropic e bridge remoto | Componentes compartilhados | Preservados sem alteração funcional nesta remoção |

O grafo de módulos JS foi reanalisado sem novas violações. A aresta de entrada
`deepclaude.ps1 → proxy/start-proxy.js` foi eliminada; a aresta
`deepclaude.sh → proxy/start-proxy.js → proxy/model-proxy.js` permanece. As arestas
de launcher são revisadas manualmente, pois o dependency-cruiser só cobre JS/TS.

## Arquivos alterados

- Removido: `deepclaude.ps1`.
- Alterados: `proxy/deepseek-compat.test.js`, `.surgical-refactor/config.json`,
  `.surgical-refactor/contracts.md`, `README.md`, `AGENTS.md`, `CLAUDE.md`,
  `docs/surgical-refactor.md`, `docs/deepseek-compatibility.md`,
  `docs/dead-code-audit.md`.
- Alterados na skill: `scripts/bootstrap.mjs`, `scripts/refactor.mjs`,
  `examples/deepseek-only-policy.json`, `SKILL.md`.
- Adicionados: `proxy/platform-contract.test.js` e este relatório.
- Mudanças anteriores no proxy, Bash, testes e documentação já estavam no
  worktree; não foram descartadas nem commitadas por esta operação.

## Baseline e resultados

Antes: 53 testes do proxy + 13 da skill, todos aprovados. Sintaxe dos dois
launchers verificada antes do corte. Evidência preservada em
`.surgical-refactor/artifacts/before-remove-windows/verification.json`.

Depois: **56 testes do proxy + 13 da skill = 69 testes aprovados**. Os três novos
testes verificam ausência de launchers nativos removidos no código próprio,
ausência de caminhos/checks exclusivos e funcionamento do help Bash sem iniciar
uma sessão. Nenhum teste suportado do proxy foi eliminado; o teste de paridade
foi adaptado ao contrato Bash que permanece suportado.

- Knip, dependency-cruiser, ast-grep e Semgrep: sem novos findings ou erros.
- Sintaxe dos scripts Node da skill, launcher Node, proxy e Bash: aprovada.
- Cobertura do proxy de produção: 86,79% das linhas, 84,57% das ramificações e
  82,56% das funções. Não mede compatibilidade de plataforma por si só.
- StrykerJS reexecutado no range de `buildUpstreamPath`: **96,88%**, com
  29 killed, 2 timeout, 1 survived, zero erros e zero NoCoverage. Os timeouts
  detectam mutantes que deixam o loop sem término; o sobrevivente Math.min→Math.max
  permanece possivelmente equivalente para o path retornado. Não foi excluído.

## Regression guard e CI

A policy agora está em **enforce** para a funcionalidade removida. O arquivo
principal removido está proibido e os caminhos de tooling/CI são verificados.
O teste de plataforma percorre o código próprio, sem atravessar symlinks nem
diretórios de dependências, e rejeita scripts/binários nativos de Windows.

O workflow existente executa esses novos testes através de `refactor:verify`,
além das análises e do mutation gate de 90% no range configurado. Não requer
PowerShell. A execução hospedada no GitHub depende de commit/push; os comandos
foram executados localmente.

## Recuperação e referências restantes

Como o launcher tinha alterações não commitadas, uma cópia exata anterior ao
corte foi preservada em:

`.surgical-refactor/artifacts/before-remove-windows/deepclaude.ps1.backup`

Essa cópia é evidência ignorada pelo Git, não um entry point ativo. O baseline e
relatórios históricos mantêm referências ao estado anterior para comparação;
não são instruções de instalação nem checks executados. Não foi refeito o
baseline para esconder a remoção ou absorver findings novos.

Os lockfiles de ferramentas de terceiros foram preservados integralmente.
Metadados opcionais de outras plataformas nesses locks não são implementação
própria e não justificam corromper a reprodutibilidade das ferramentas.

## Limitações

Não foi executada uma sessão real do Claude Code nem teste de API em produção.
A sessão/proxy ativo não foi reiniciado. O Node compartilhado continua usando
APIs portáveis, mas o projeto não entrega nem testa um launcher nativo Windows.
Os problemas anteriores identificados no launcher Bash estão fora deste corte.
