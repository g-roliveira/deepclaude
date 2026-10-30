---
name: surgical-refactor
description: Remova funcionalidades, providers, adapters e dependências com análise de impacto por AST/grafo, baseline, regressões e guardas de CI. Use para remoções cirúrgicas; não remova código apenas por ausência de referências estáticas.
---

# Surgical Refactor

Preserve o comportamento suportado ao remover somente a funcionalidade solicitada.
Uma instrução de exemplo não autoriza removê-la do projeto atual. Descubra a stack
antes de instalar ferramentas. Não use resultados estáticos como prova de código
morto ou equivalência semântica.

Leia [o protocolo](references/workflow.md) ao executar uma remoção e
[as ferramentas](references/tooling.md) ao configurar ou adaptar a automação.
A configuração e os comandos abaixo são o perfil JS/TS deste projeto; em outras
linguagens use ferramentas nativas compatíveis e registre o que não se aplica.

## Fase 1 — Discovery

1. Inspecione instruções locais, git status, linguagem/framework, manifests,
   build, pontos de entrada, testes e integrações existentes. Verifique o MCP
   Semgrep antes de instalar um CLI ou servidor redundante. Não imprima segredos.
2. Construa o mapa AST/dependências e busque referências em configuração,
   launchers, imports dinâmicos, factories, registries e contratos externos.
   Computed imports e reflexão são lacunas, não ausência de dependência.
3. Classifique cada símbolo/arquivo como exclusivo, compartilhado ou incerto.
   Mostre plano, invariantes, riscos e destino dos consumidores antes de editar.

```bash
node .agents/skills/surgical-refactor/scripts/refactor.mjs inventory --target openrouter
node .agents/skills/surgical-refactor/scripts/refactor.mjs analyze
```

Os helpers não classificam propriedade exclusiva automaticamente. O inventário
AST lista imports, reexports, exports e dependências dinâmicas; o grafo de módulos
não substitui um call graph de símbolos nem análise semântica de shell/config.

## Fase 2 — Baseline

1. Crie uma branch de trabalho sem resetar/stashar alterações do usuário. Preserve
   o worktree sujo e registre mudanças preexistentes. Use worktree isolado quando
   precisar de referência limpa sem descartar mudanças.
2. Execute testes e ferramentas existentes. Registre falhas preexistentes com
   logs/status; falhas não viram sucesso por estarem no baseline.
3. Escreva caracterizações de contratos importantes ainda descobertos. Registre
   CLI/env, endpoints, exports, erros, SSE, persistência e invariantes preservados.
4. Capture baseline revisável. Nunca o regenere automaticamente no CI.

```bash
node .agents/skills/surgical-refactor/scripts/refactor.mjs baseline --branch refactor/deepseek-only
```

Se a branch já foi criada, omita `--branch`. `.surgical-refactor/contracts.md` e
`config.json` precisam representar os contratos reais. `publicExports` e
`entryPoints` são verificados. Revisar baseline existente exige
`--accept-baseline`; não use essa opção para absorver uma regressão.

## Fase 3 — Surgical Removal

1. Remova consumidores exclusivos antes de imports/adapters/factories/configs e
   dependências exclusivas. Preserve componentes compartilhados e contratos
   externos. Não faça limpeza estética ou renomeações fora do alvo.
2. Revise cada alteração estrutural por AST, diff e caracterizações. Codemods
   começam em dry-run. Use ast-grep e jscodeshift para JS/TS; não os aplique a
   shell scripts. Veja o exemplo conservador em `examples/remove-unused-import.cjs`.
3. Considere morto somente após cruzar grafo, entry points, imports dinâmicos,
   registros de config, contratos externos e comportamento. Knip é um sinal.
4. Remova pacotes apenas após revisar seus consumidores, scripts, lockfiles,
   side effects e peers. Não edite lockfile à mão para fingir a remoção.

No exemplo "remova todos os providers LLM, exceto DeepSeek", transporte no
protocolo Anthropic, env `ANTHROPIC_*` e bridge de remote-control podem ser
compartilhados: seu nome não prova que são um provider LLM a eliminar. Classifique
essas dependências antes de prometer que pode remover todo código Anthropic.

## Fase 4 — Verification

Execute build/type checking/lint nativos, análise estática, testes unitários,
integração, contrato e E2E existentes conforme aplicável. Registre explicitamente
o que foi executado, falhou, não existe ou não foi executado. Sem testes em produção.

```bash
node .agents/skills/surgical-refactor/scripts/refactor.mjs verify
node .agents/skills/surgical-refactor/scripts/refactor.mjs mutation
```

Mutation deve usar caminhos críticos sobreviventes e a suíte real, em sandbox.
Revise o range e comando de teste antes de executar. O perfil inicial muta somente
`buildUpstreamPath`; não extrapole o resultado para o proxy inteiro. Sobreviventes,
NoCoverage e timeout exigem análise. O perfil do projeto exige score de 90% no
range configurado; adapte o gate após medir o baseline. Não exclua mutantes só para
aumentar score. Passar compilação não prova equivalência semântica.

## Fase 5 — Regression Guard

Depois da remoção real, arme `policy.mode=enforce` com `removedFeature` e
proibições concretas em `.surgical-refactor/config.json`. Cubra imports estáticos,
dinâmicos literais, reexports, símbolos, pacotes e registros textuais em arquivos
especificados. `examples/deepseek-only-policy.json` é um exemplo, não uma análise
do projeto. Ajuste os nomes reais; não copie proibições inexistentes sem revisão.

CI deve executar verify (testes + AST/Semgrep/grafo + novos findings Knip +
referências proibidas) e mutation configurado. Um baseline não perdoa falhas de
execução/parsing. Exceções precisam de escopo e motivo explícitos. Código dinâmico
não resolvido exige revisão e testes de configuração; o helper não prova ausência.

`observe` significa **nenhuma remoção certificada**. Não anuncie a guarda de uma
funcionalidade como ativa enquanto a policy estiver nesse modo.

## Fase 6 — Relatório

```bash
node .agents/skills/surgical-refactor/scripts/refactor.mjs report
```

Entregue inventário removido, grafo afetado, arquivos alterados (diferenciando
mudanças preexistentes), contratos preservados, testes antes/depois, cobertura
crítica, mutation score/statuses, riscos e lacunas. O helper gera evidências, mas
o relatório humano deve explicar propriedade exclusiva/compartilhada e riscos.

Nunca declare "100% compatível" ou "sem regressões" com base somente em uma
suíte local, uma cobertura alta ou um comando que não analisou nenhum arquivo.
