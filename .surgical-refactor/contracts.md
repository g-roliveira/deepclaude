# Contratos preservados nesta implementação

Remoções autorizadas: launcher nativo Windows e seus caminhos exclusivos de tooling;
providers OpenRouter, MiniMax e Fireworks, incluindo aliases, preços, credenciais,
overrides de modelo e workarounds exclusivos. Somente DeepSeek e Anthropic permanecem.

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

- CLI aceita `ds`/`deepseek` e `anthropic`; seletores removidos falham antes de
  iniciar processos ou fazer chamadas. `--model` depois de `--` é argumento nativo
  do Claude Code, sem override de provider no proxy.
- Registro de backends só aceita `deepseek`; Anthropic é passthrough nativo.
  Modos iniciais não suportados e switches desconhecidos falham sem mudar estado.
- DeepSeek recebe somente sua chave em `x-api-key`; bridge e Anthropic preservam
  a autenticação recebida. Reasoning DeepSeek continua intacto; thinking estrangeiro
  é removido ao alternar para Anthropic. Blocos redacted válidos não são descartados.
- Launcher Anthropic retorna após o processo filho, sem iniciar proxy; modos
  normal/remoto DeepSeek mantêm logs, limpeza e compactação em 786432 tokens.

Antes de uma remoção real, substituir/complementar este inventário pelos contratos
da funcionalidade alvo: CLI flags, env vars, endpoints, imports públicos, erros,
eventos e integrações por configuração. Registrar o que pode mudar e o que não pode.
