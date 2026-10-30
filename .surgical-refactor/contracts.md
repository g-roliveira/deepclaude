# Contratos preservados nesta implementação

Remoção autorizada: launcher nativo Windows e seus caminhos exclusivos de tooling.
Todos os providers existentes continuam disponíveis; o proxy Node não é removido.

- Bash é o único launcher suportado. O arquivo `deepclaude.ps1` e novos scripts
  nativos Windows não podem ser reintroduzidos; isso é verificado no CI.
- `proxy/start-proxy.js` também é chamado pelos scripts shell; não é código morto.
- A exportação `startModelProxy` é um contrato público mesmo sem um consumidor
  estático de produção dentro do repositório.
- Routing, autenticação, SSE, native vision, Files, contexto, custos, histórico
  e resultados de tools mantêm as regressões em `proxy/*.test.js`.
- Runtime permanece sem dependências de terceiros. Ferramentas de desenvolvimento
  ficam em `.agents/skills/surgical-refactor/tooling`, com locks locais.
- Não alterar credenciais, sessões, diretórios de projetos Claude ou proxy ativo.

Antes de uma remoção real, substituir/complementar este inventário pelos contratos
da funcionalidade alvo: CLI flags, env vars, endpoints, imports públicos, erros,
eventos e integrações por configuração. Registrar o que pode mudar e o que não pode.
