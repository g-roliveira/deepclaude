# Ferramentas e configuração local

## Descoberta antes de instalar

Verifique PATH, manifests, lockfiles e dependências locais antes de instalar.
Confirme versões e identificação real dos executáveis: `/usr/bin/sg` do Linux
pode ser o utilitário de grupos, não ast-grep. Não instale ferramentas JS em
projeto sem JS/TS. Em repositórios mistos limite sourceRoots por linguagem.

Verifique integrações MCP já disponibilizadas e nomes dos servidores nas
configurações, sem imprimir variáveis, headers ou credenciais. Nesta instalação
não havia MCP Semgrep, então adotamos CLI local; nenhum servidor novo foi criado.
Semgrep instalado globalmente pode ser reutilizado pelo bootstrap. Para reproduzir
exatamente o CI prefira a versão travada no venv local e confira a versão reutilizada.

## Perfil deste repositório

| Ferramenta | Versão fixada | Função |
| --- | --- | --- |
| ast-grep | 0.51.0 | Padrões e review estrutural por AST |
| Knip | 6.44.0 | Arquivos/exports/dependências não alcançados |
| Semgrep CE | 1.183.0 | Regras locais e arquitetura, sem métricas |
| dependency-cruiser | 18.7.0 | Grafo, ciclos, resolução e barreira produção/testes |
| jscodeshift | 17.4.0 | Inventário AST e codemod conservador |
| StrykerJS | 10.1.1 | Mutação focada, runner command embutido no core |

Runtime continua sem dependências. `package.json` raiz só declara ESM e comandos
de desenvolvimento. Pacotes JS ficam em `tooling/node_modules`, com package-lock;
Semgrep fica em `tooling/.venv` Python 3.12, com requirements travados e hashes.
O Python padrão da máquina é 3.14: usamos o 3.12 já instalado, sem alterar o Python
global. Node 22.12+ é necessário para este conjunto de ferramentas; não é uma
declaração nova sobre os requisitos de runtime do proxy.

```bash
npm run refactor:setup
npm run refactor:selftest
npm run refactor:analyze
npm run refactor:verify
npm run refactor:mutation
```

`setup` usa npm ci quando o lock existe; não baixa ferramentas durante analyze
ou verify. O uv deve estar disponível antes de criar/sincronizar o venv. Não usa
npx que instala versões latest silenciosamente. As versões foram verificadas nos
registries oficiais. O command runner já vem no core do Stryker: não instale um
pacote inexistente `@stryker-mutator/command-runner`.

## Adaptação para outro projeto

Copie a pasta da skill e crie configuração local equivalente a
`.surgical-refactor/config.json`. Revise sourceRoots, configurationFiles, entryPoints,
publicExports, checks e contracts. Ajuste `config/knip.json` e as regras do
dependency-cruiser para os caminhos verdadeiros. Em TS, use os parsers/tsconfig e
ferramentas nativas já presentes; não suponha que a configuração JS seja suficiente.

`config/sgconfig.yml` resolve ruleDirs em relação à própria configuração.
`config/semgrep.yml` usa somente regras locais e métricas desligadas. O scanner
trata erros de regra/parsing como falhas, mesmo se o CLI terminar com zero.
Todas as análises devem ter escopo não vazio revisado. Lint de estilo é opcional
quando o projeto não o possui; syntax e regras arquiteturais não o substituem.

Os helpers escrevem artefatos em `.surgical-refactor/artifacts` (ignorado pelo Git),
nunca deletam fontes e não aplicam codemods automaticamente. Commands em config
são argv arrays sem shell evaluation. Logs removem segredos presentes em variáveis
de ambiente conhecidas, mas isso não detecta qualquer segredo arbitrário em fontes;
revise artefatos antes de publicá-los.

## Fontes

- [ast-grep project config](https://ast-grep.github.io/guide/project/project-config.html)
- [Knip configuration](https://knip.dev/overview/configuration)
- [dependency-cruiser](https://github.com/sverweij/dependency-cruiser)
- [jscodeshift](https://github.com/facebook/jscodeshift)
- [Semgrep local rules](https://docs.semgrep.dev/running-rules)
- [StrykerJS configuration](https://stryker-mutator.io/docs/stryker-js/configuration/)
