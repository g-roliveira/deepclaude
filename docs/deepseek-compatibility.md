# Auditoria de compatibilidade DeepSeek

> Esta auditoria registra o estado anterior à remoção de suporte Windows. A
> implementação atual mantém somente o launcher Bash e os testes do proxy;
> referências históricas à paridade de launchers não são instruções atuais.

Data: 2026-10-29. Modelo de produção: `deepseek-flash`
(V4.1-Flash-1017 na documentação consultada).

## Resultado e alcance

O fluxo principal deste projeto é **Claude Code → Anthropic Messages → DeepSeek**.
O proxy não é um gateway universal para todos os protocolos da DeepSeek.
Compatibilidade do encaminhamento não equivale a validar a qualidade de uma
resposta do modelo ou o funcionamento dos serviços externos.

Foram executados **52 testes locais**: 35 em `proxy/model-proxy.test.js` e 17 em
`proxy/deepseek-compat.test.js`. Os testes HTTP usam servidores simulados e chaves
fictícias. A nova suíte bloqueia destinos externos. Nenhuma inferência real,
busca real ou operação real de upload/delete foi executada nesta auditoria.
Os launchers passaram na análise sintática de Bash e PowerShell. A configuração
de compactação também tem uma regressão estática de paridade entre ambos.

Coverage do **proxy de produção** (`model-proxy.js`), sem inflar o resultado com
os arquivos de teste: **86,79% das linhas**, **84,57% das ramificações** e
**82,56% das funções**. Resultado: 52 aprovados, zero falhas e zero testes
ignorados. Isso não significa 86,79% das capacidades da API certificadas.

## Matriz dos 12 guias

| Guia oficial | Situação no DeepClaude | Regressões e limites |
| --- | --- | --- |
| [Vision](https://api-docs.deepseek.com/guides/vision/) | Encaminhamento Anthropic para Flash implementado. Base64, URL e `source.type=file` cobertos. | PNG real dentro de `tool_result`, assinatura JPEG/PNG/GIF/WebP, MIME/Base64 inválidos, URL inválida/longa, `file_id` inválido, mais de 600 imagens, imagem inline acima de 32 MiB, beta sem duplicação e limite Messages de 48 MiB. Dimensões, decodificação completa, downloads e total de bytes dos arquivos remotos ficam a cargo da DeepSeek. |
| [Thinking](https://api-docs.deepseek.com/guides/thinking_mode/) | Controles preservados no backend direto. Adaptive vira enabled; orçamento ignorado é removido. | Enabled/disabled e todas as equivalências documentadas de effort. Histórico, assinatura e deltas de thinking preservados. `medium` e `xhigh` resultam em `high`, não em níveis próprios. |
| [Multi-round](https://api-docs.deepseek.com/guides/multi_round_chat/) | Histórico textual e de ferramentas preservado, enviado em cada chamada. | Ciclo HTTP de duas rodadas, prefixo estável de sistema/ferramentas/metadata e IDs preservados. Limitação deliberada: imagens históricas são substituídas por placeholders; comparações futuras exigem reenviar as imagens. |
| [Chat Prefix Completion](https://api-docs.deepseek.com/guides/chat_prefix_completion/) | API OpenAI beta separada; sem adaptação no Messages. | Caminho beta retorna 501 local. Usar a API diretamente com assistant prefix e `prefix=true`. Não é habilitado pela configuração do Claude Code. |
| [FIM Completion](https://api-docs.deepseek.com/guides/fim_completion/) | API Completions beta separada; sem adaptação no Messages. | Caminhos Completions retornam 501 local. Prefixo/sufixo e limite de 4K pertencem à API externa. Não implementamos autocomplete FIM no Claude Code. |
| [JSON mode](https://api-docs.deepseek.com/guides/json_mode/) | JSON estrito por `response_format` pertence ao Chat Completions; não está habilitado por este proxy. | Texto JSON em uma resposta Messages é preservado, sem garantia de JSON mode. A compatibilidade Anthropic aceita somente effort em `output_config`; não traduzimos format/schema. Não confundir tool calling com garantia de schema estrito. |
| [Tool calls](https://api-docs.deepseek.com/guides/tool_calls/) | Tool use/resultado suportados no fluxo Anthropic. Execução continua sendo do Claude Code. | Duas rodadas com thinking assinado, IDs/inputs/resultados preservados, quatro variantes de tool_choice, resultados paralelos, JSON incremental em SSE. O filtro legado remove `pattern`/`patternProperties` para compatibilidade: essas restrições não são garantidas. Strict beta não foi habilitado. |
| [Files API](https://api-docs.deepseek.com/guides/files_api/) | Upload/lista/metadata/delete Anthropic agora seguem para o backend DeepSeek quando ele está selecionado. | Métodos, query de paginação, multipart intacto, chave do backend substituindo a chave do cliente e beta deduplicado. Teto local de 65 MiB para o corpo multipart, permitindo arquivo de 64 MiB com envelope limitado; arquivo, quota e expiração validados pelo upstream. Referências usam `file-api-...`; não aceita IDs da conta Anthropic. Imagens apenas, sem interpretação de PDFs/documentos. Sem upload automático ou gestão de expiração pelo proxy. |
| [Search & Fetch](https://api-docs.deepseek.com/guides/search/) | WebSearch nativo em Messages é encaminhado quando exposto pelo Claude Code. APIs JSON independentes não estão integradas. | Definições e resultados de ferramentas do servidor preservados em JSON e SSE. `/v1/tools/search` e `/v1/tools/fetch` retornam 501 local, instruindo usar a API diretamente. O WebFetch do Claude Code não foi substituído pela API Fetch. Busca, extração e seleção de ferramenta pelo modelo não foram testadas ao vivo. |
| [KV cache](https://api-docs.deepseek.com/guides/kv_cache/) | Cache automático é do servidor, sem flag local para ligá-lo. | Prefixos textuais estáveis e contadores de cache em JSON/SSE preservados; custo de cache contabilizado; uso final/fragmentado em SSE testado. `cache_control` Anthropic é ignorado pela DeepSeek. Taxa de hit não é garantida; imagens históricas substituídas podem alterar o prefixo e o aproveitamento. |
| [Responses API](https://api-docs.deepseek.com/guides/responses_api/) | Outro protocolo; sem adaptador. | `/responses` e `/v1/responses` retornam 501 local e nunca seguem para Anthropic por engano. Não aplicamos eventos `response.*` ao normalizador `message_*`. A documentação consultada limita WebSearch Responses ao Pro e informa que é ignorado no Flash. Isso é diferente da integração WebSearch em Messages. |
| [Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/) | Protocolo principal implementado, dentro do subconjunto suportado pela DeepSeek. | Remapeamento, caminho/query, troca de autenticação, campos suportados, JSON/SSE, tool results, cache, erros e retry-after cobertos. Streaming inclui UTF-8 entre pacotes, CRLF, usage ausente e correção de content-length. Document, search_result e outras variantes explicitamente não suportadas pela DeepSeek não ganham suporte via proxy. |

## Falhas corrigidas nesta auditoria

- Files API seguia o fallback da Anthropic, embora imagens por `file_id` fossem
  encaminhadas à DeepSeek. Agora as operações de arquivos acompanham o backend
  DeepSeek ativo, com sua autenticação e namespace, preservando o multipart.
- O mock de títulos interceptava pedidos de resumo, respostas curtas e pedidos
  contendo a palavra title. Ele está **desativado por padrão**. O modo legado
  pode ser reativado explicitamente com `DEEPCLAUDE_MOCK_TITLE_GEN=1`, mas usa uma
  heurística que não garante distinguir títulos de tarefas normais.
- A validação visual não rejeitava file_id ausente, URLs acima de 8192 caracteres,
  mais de 600 imagens ou imagens inline acima de 32 MiB. O header Files beta era
  duplicado e valores de MIME/Base64 validados não eram normalizados no envio.
- O decodificador SSE podia corromper caracteres UTF-8 divididos entre pacotes.
  Agora mantém o estado do decodificador e aceita separadores CRLF.
- O normalizador podia conservar content-length antigo em um SSE modificado e
  perder contadores quando o uso chegava em atualizações parciais. Ambos têm
  testes de regressão.
- Count tokens devolvia zero e HTTP 200 para JSON inválido. Agora devolve erro
  400 e aplica limite de corpo. Ainda é estimativa, não um tokenizer oficial.
- APIs fora do contrato Messages podiam cair no fallback da Anthropic. Os
  caminhos conhecidos de Chat/Completions/Responses/Search/Fetch agora recebem
  501 explícito em modos não-Anthropic. As demais rotas de controle continuam
  com o comportamento anterior.

## Contexto, custos e ressalvas operacionais

`CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432` segue a recomendação oficial de
[integração Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/).
Isso oferece margem, mas não recupera automaticamente uma sessão já acima do
limite nem garante ausência de overflow depois de grandes resultados de tools.
A estimativa local usa bytes UTF-8 de sistema, ferramentas e mensagens; não
corresponde ao tokenizador DeepSeek. Base64 e arquivos externos também não têm
contagem visual exata nesse cálculo.

O custo Flash exibido usa tarifas de pico e cache informado pelo provedor.
Não simula feriados chineses nem descontos fora do pico e **não inclui taxas
Search/Fetch**. As [tarifas oficiais](https://api-docs.deepseek.com/quick_start/pricing/)
e a cobrança real da conta prevalecem. Chaves, uploads de arquivos, obtenção de
imagens por URL e cobrança dos serviços continuam dependendo da conta/API.

## Como repetir

```bash
rtk test node --test proxy/model-proxy.test.js proxy/deepseek-compat.test.js
rtk proxy node --experimental-test-coverage --test proxy/model-proxy.test.js proxy/deepseek-compat.test.js
rtk proxy node --check proxy/model-proxy.js
rtk proxy bash -n deepclaude.sh
```

O relatório de coverage mede execução do código Node, não porcentagem de
compatibilidade com os serviços da DeepSeek. Os caminhos externos desabilitados
são testados pela rejeição explícita, não pela implementação desses protocolos.

Para uma homologação real ainda faltam inferência textual/visual, tool loop,
WebSearch, upload de imagem por conta real e observação de cache no provedor.
Esses testes podem gerar cobranças e criar arquivos remotos. A sessão ativa e
seu proxy não foram reiniciados pela auditoria; alterações só entram em uma
nova execução do DeepClaude.
