# Protocolo de remoção

## Discovery e plano

Registre alvo, comportamento que pode desaparecer, consumidores e contratos que
devem permanecer. Use matriz por símbolo/arquivo:

| Unidade | Consumidores diretos/indiretos | Config/dinâmica | Classe | Ação |
| --- | --- | --- | --- | --- |
| Provider solicitado | Factory/CLI/tests | Registro/env | Exclusivo? | Remover só após confirmar |
| HTTP/SSE normalizer | Todos os providers | Endpoint Messages | Compartilhado | Preservar |
| Bridge remoto | Launcher remoto | Protocolo Anthropic | Compartilhado/incerto | Preservar ou esclarecer mudança de escopo |

Não conclua exclusividade pelo nome. `ANTHROPIC_BASE_URL` é um contrato do Claude
Code, não uma dependência do provider Anthropic. Entry points shell, callbacks,
plugins carregados por glob, package exports, reflection e imports computados
precisam de evidência além de imports estáticos.

Use `inventory --target <termo>` para localizar referências sem imprimir linhas
de conteúdo. `analyze` gera `inventory.json`, saída detalhada do dependency-cruiser
e `graph.mmd`. Caminhos transversais de chamada e exclusividade exigem revisão
do agente; o helper não implementa um grafo interprocedural completo.

Apresente plano e riscos antes de editar. Se a remoção já foi autorizada e não
expandir escopo, prossiga sem pedir confirmação repetida. Se eliminar algo exige
desativar outro comportamento prometido, esclareça esse contrato antes de removê-lo.

## Baseline

- Branch própria, git status registrado e worktree sujo preservado. Nada de
  reset, checkout de arquivos, stash automático ou commit de alterações alheias.
- Testes antes da alteração. Falhas preexistentes devem ter logs e comandos.
- Caracterizações precisam testar comportamento observável, não espelhar o AST.
- Contratos incluem APIs públicas usadas externamente mesmo sem imports internos.
- `baseline` registra hashes e exports do escopo, checks, findings e HEAD. Não
  certifica um commit limpo se o worktree já estava sujo; mencione isso no relatório.
- Qualquer check obrigatório ainda falhando impede `verify`, mesmo que a falha
  seja preexistente. Identifique separadamente o que já falhava sem mascará-lo.

## Remoção

Faça pequenos patches com `apply_patch` ou codemods revisados. Para cada unidade:
consumidores → registro/factory → implementação exclusiva → imports/dependências
→ documentação/config. Preserve componentes compartilhados enquanto tiverem uso.
Depois de cada mudança estrutural, reveja AST e diff; rode o teste de contrato
mais próximo. Não use Knip --fix/--allow-remove-files em massa.

O codemod `examples/remove-unused-import.cjs` exige um módulo exato, recusa
side-effect imports e bindings ainda referenciados. Ele é deliberadamente
conservador: revise falsos positivos e não o generalize para remover factories
ou expressões arbitrárias. Use o binário local jscodeshift com `--dry --print`
antes de aplicar em arquivos do projeto.

## Verificação e CI

Adapte checks à stack: compilação/types quando existirem; syntax/lint nativos;
unit/integration/contract/E2E quando disponíveis. Não invente E2E ou type checking
para uma stack que não os tenha. Falta de ferramenta, parser failure, zero arquivos
analisados e comando não executado não são resultados limpos.

Use a diferença entre findings normalizados de antes/depois. Números de linha
não identificam uma dívida antiga, mas novas funções órfãs devem ser detectadas.
Arquivos exportados só para tests podem ser candidatos a internalização, não a
remoção automática. Confira a modalidade de produção do Knip separadamente se
precisar distinguir test-only de runtime.

`policy.mode=enforce` exige alvo e proibições não vazias. Para configurações
dinâmicas, configure `forbiddenText` nos caminhos reais, ou adicione um teste que
instancie o registry. Imports computados não resolvidos continuam sendo lacuna.
Use exceções pequenas, documentadas e revisadas; não permita um diretório de
produção inteiro apenas para fazer o gate passar.

Mutações rodam numa sandbox descartável. Selecione caminhos críticos restantes
e use um teste que possa falhar neles. O runner command tem coverageAnalysis off:
não promete distinguir cobertura por teste e não deve gerar uma conclusão global.
Analise mutantes sobreviventes/timeout; classifique equivalentes com evidência,
sem desabilitá-los artificialmente para inflar score.

O CI chama os mesmos comandos locais e nunca usa `--accept-baseline`, `--fix`,
testes reais de API, tokens de produção nem serviços destrutivos.

## Relatório final

Inclua: inventário removido; grafo afetado; arquivos novos/alterados/removidos;
mudanças preexistentes; contratos preservados; testes antes/depois; cobertura de
produção (sem inflar com testes); mutation range, score, killed/survived/timeout;
checks não executados e riscos. O Markdown do comando report é um ponto de partida:
complete a classificação de ownership e os contratos específicos manualmente.
