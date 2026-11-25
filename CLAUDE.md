# CLAUDE.md — nfe-api (serviço da família NF-e / NFC-e)

## ⚠️ Base de conhecimento central: D:\Gestao2027\Infra-IA

Antes de qualquer tarefa neste projeto, consulte `D:\Gestao2027\Infra-IA\INDICE_CENTRAL.md` e
**`Infra-IA/nfe-api/INDEX.md`** (START HERE). Decisões vigentes: D-F1…D-F220 em
`Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §7 (plano §12) — **D-F105: a NF-e PODE produzir a voz S, desde que dê a saída dela na
mesma entrega (consulta pela NOSSA chave; o P sai pela consulta do recibo — D-NE33); a cerca da D-F102 é só da NFS-e. D-F108: a lista de
escrita de cada família vai no DESCRITOR da família (`VoiceFamily<K>`) e o escritor comum do núcleo é genérico nela — nota de implantação
no `prompt_onda_nfe_sefaz.md` §12.8** — e D-E1…D-E25 + **D-NE1…D-NE168** em `Infra-IA/prompts/prompt_onda_nfe_sefaz.md` (§11.7, §12.7,
§12.9, §13.10, §14, **§15.8 = Rodada 15, as regras da NE-2**).
O núcleo `fiscal-api` entra AQUI só pelo **pacote versionado** `vendor/fiscal-api-X.Y.Z.tgz` (D-F221…D-F225, 2026-11-05 —
`prompt_apis_fiscais_isoladas.md` §23): sem `paths`/`moduleNameMapper` para a pasta irmã (cerca `src/__tests__/fiscal-api-package-fence.test.ts`
— vendor = lock = instalado); mexeu no núcleo? gere o pacote (no núcleo: `node scripts/pack-release.mjs vX.Y.Z <saída>`), troque o arquivo em
`vendor/` e rode `npm install`.
**Núcleo em uso: 5.2.0** (DEPLOY.E1.P12 — o mesmo tgz da nfse-api, D-F237, "com modificação": o `FsFiscalStorage.save` é de GRAVAÇÃO ÚNICA — bytes iguais devolvem o caminho, bytes diferentes lançam `FiscalFileConflictError` (`.code` `FISCAL_FILE_CONFLICT`), então o `-nfe.xml` em conflito é 409 antes do envio (a transação desfaz, nada vai ao fisco) e o `-procNFe.xml` em conflito é `incident: file-conflict`, nunca engolido nem sobrescrito; `ctx.storage.warm?.()` no boot, depois das migrations, sem try/catch; `reconfirmNotRegistered` decide pela peça `notRegisteredProven` (RF-NFE-72) com a idade mínima de 10 minutos (D-NE291) e a tentativa com o fato gravado SOLTA a nota para nova transmissão por ato do usuário, com o mesmo número e `cNF` novo (D-NE292); prova em `src/__tests__/deploy-e1-p12.test.ts`); em 5.1.0 ficou (DEPLOY.E1.P11 — o mesmo tgz da nfse-api, D-F237; só acrescenta ao 5.0.0: a migration 008 `tb_fiscal_number_sequence` e as peças `nextInvoiceNumber`, `lockNumberSequence`, `openNumberSequence` e `assertNumberSequenceDomainsEnforced`; o boot chama a sonda, depois da dos códigos fiscais e antes da do CSRT; **gerar número e abrir sequência são da NFE.E6.P1**, só a sonda é chamada (no boot); as três peças de número não são chamadas em lugar nenhum — cerca `deploy-e1-p11.test.ts`); em 5.0.0 ficaram: (DEPLOY.E1.P9 — janela da NE-6, o mesmo tgz da nfse-api — D-F237: a família NF-e ENTROU no catálogo `VOICE_READINGS` e em `fiscal-api/reading` — D-NE158; `assertFamilyViewsReadable` sem lista padrão — o boot daqui segue passando só `[MERCHANDISE_VOICE_READING]`, NUNCA o catálogo inteiro — D-NE76; migration 007 do núcleo = `vw_establishment_issuer`, a habilitação por modelo que o ERP lê ao cunhar — D-NE170, com as faixas retiradas — D-NE161; o emitter passa a contar as NF-e vivas — `PUT`/`DELETE` da habilitação do 55 e o `DELETE` do A1 leem a view de tentativas; o boot confere também a `vw_establishment_issuer` (`assertIssuerViewReadable`); prova em `src/__tests__/deploy-e1-p9.test.ts` (cerca do boot por AST). O 4.1.0 veio no DEPLOY.E1.P8 — peças da NE-4, o mesmo tgz da nfse-api — D-F237: escritor de XML D-NE214, fórmula do vNF D-NE215 em `fiscal-api/merchandise-total`, responsável técnico pelo `.env` D-NE217/D-NE229 — `FISCAL_TECH_RESPONSIBLE_*` conferidas no `contextFromEnv`, e a configuração fiscal por UF da migration 006 do núcleo D-NE221/D-NE223 — o boot sonda os CHECKs e RECUSA sem o CSRT exigido para cada modelo × ambiente com habilitação viva (presença no instante do boot — NÃO substitui a conferência por nota pela UF do emitente, D-NE218, que é do builder; habilitação 55/P nova exige antes o CSRT de P); o CSRT de H entra pelo `scripts/fiscal-credential.mjs` do núcleo, só pelo Valdo — D-NE226; prova em `src/__tests__/deploy-e1-p8.test.ts`. O 4.0.0 veio no DEPLOY.E1.P7 — teto de 2 MB no transporte = ambíguo `envelope-ilegivel` e `verifyXml` pelo elemento, D-NE193/D-NE194, por acompanhamento da nfse-api f6682a3 — D-F237; superfície fixada em `src/__tests__/deploy-e1-p7.test.ts`; a 3.0.0 — token sem `role`, admin só do perfil vivo, D-AU3/D-AU19 — veio no ACESSO.E1.P1; o 2.0.0 no DEPLOY.E1.P5): XML no layout D-F241 pelo `src/nfe/fiscal-file.ts`
(55 = `nfe`, 65 = `nfce`), raiz por `fiscalStorageRootFromEnv`, CORS com o ambiente (D-F236).
**Health com prova da chave-mestra** (DEPLOY.E1.P6, D-NE189 — gêmea da nfse-api b3f192e): `src/key-proof.ts` abre UM A1 guardado por versão
(`verifyStoredKeys` do núcleo) no boot ANTES do `listen` e a cada `KEY_PROOF_INTERVAL_MINUTES = 5` (D-F243/D-F245/D-F250/D-F251); o
`/v1/health` só lê o sinal `masterKey` sim/não (D-F244); falha = `masterKey=false` + `KEY_PROOF_FAILED|DEGRADED|NOT_RUN` no log.
**Sessão viva e perfil vivo** (ACESSO.E1.P1, D-AU3/D-AU19, molde nfse-api): o [check] do `productAuth` é `access.liveIdentity` (a
`setes_central.vw_user_link` pelo institution, usuário e schema do token + o `iat` — D-EA7): revogada = 401 `SESSION_REVOKED`, banco fora = 503
`SESSION_UNAVAILABLE`; `isAdmin` lê o perfil VIVO (o `role` do token é ignorado); o boot confere a view (`assertSessionViewReadable`) antes do `listen`.
Prova: `src/__tests__/acesso-e1-p1-sessao-viva.test.ts` (lê o vetor da auth-api em `AUTH_API_DIR` e o GRANT em `NFSE_API_DIR/ops/grants.sql`).
**GRANT da janela da NE-6** (DEPLOY.E1.P10, PM-9): o `ops/grants.sql` §2 concede ao `setes_api` SÓ o SELECT das três views publicadas —
`vw_invoice_merchandise_transmission`, `vw_invoice_number_void` e `vw_establishment_issuer` (esta é do núcleo, mas a linha fica aqui: quem a lê é
o leitor da NF-e); cerca `src/__tests__/deploy-e1-p10.test.ts` (os comandos vivos do arquivo são exatamente os três; linha nova = decisão). O
script é rodado por um administrador na implantação, depois das migrations e antes de reiniciar o setes-api com o núcleo 5.0.0.
**Fonte de fatos da mercadoria e a peça do nItem** (NFE.E5.P2, NE-4 — ficha no Vault: `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e5-p2-fonte-de-fatos-mercadoria.md`):
`src/facts/merchandise-facts.ts` é o ÚNICO arquivo que conhece as tabelas do ERP (cerca D-F10 em `app.test.ts`, ampliada a produto, mercadoria,
estoque, financeiro, transportadora, CFOP, medida e forma de pagamento). Só SELECT; escopo pelo `InvoiceRef` (o terminal nunca é literal). Cadastro
lido AO VIVO e cálculo por item REGISTRADO pelo faturamento (D-NE248); do `ICMSTot` só o vNF (D-NE178); cProd = `tb_merchandise.id` (D-NE269); natOp =
`setes_central.tb_cfop.concise` do item de nItem 1 (D-NE268); unidade vendida/tributável pelos níveis da D-PR16. Devolve FATOS CRUS: nulo onde o
cadastro não tem e decimal como TEXTO EXATO (`CAST … AS CHAR` — o pool entrega ponto flutuante); recusa só o que impede a leitura fiel: nota inexistente (404); e, com 422, nota sem ramo, sem item de mercadoria, item sem produto no cadastro, id de item repetido entre `kind`, item sem cálculo de ICMS, e emitente ou destinatário sem entidade. ⚠️ Conhecimento negativo (provado no banco do dev): `tb_order_item_tax_rule` NUNCA num JOIN pelo
`kind` com `tb_order_item` (colações diferentes → "Illegal mix of collations"; é lida à parte); PIS/COFINS podem não estar registrados (o faturamento
só grava quando o motor calcula) — saem nulos e a ponte/builder (NFE.E5.P3) recusa o item sem CST de PIS/COFINS (não é regra da camada 1); tabela nova de `setes_central` lida aqui = linha nova de
GRANT no `nfse-api/ops/grants.sql` (cerca `acesso-e1-p1-sessao-viva.test.ts`) — no dev a conta é `'fiscal_api'@'%'` (GRANT a `@localhost` cria conta sem
senha e derruba o login). `src/nfe/item-numbering.ts` (`numberItems`, `nItemOf`, `NFE_MAX_ITEMS`) é a ÚNICA peça que atribui nItem (D-NE103/D-NE220 —
ordem do id do item; o serviço da conjugada fica fora; o teto de 990 é conferido pela camada 1 (R7), mas a R12 de 500 KB cai antes de 990 itens); cerca em `item-numbering.test.ts`. Leitura real, só SELECT:
`npm run explain:leituras -- <institution> <notaId>` (2º argumento novo).
**Builder da NF-e 4.00** (NFE.E5.P3, NE-4 — ficha no Vault: `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e5-p3-builder-nfe.md`). Peças PURAS em `src/nfe/`:
`access-key.ts` (`buildAccessKey` por partes + cDV pelo `mod11Ascii48` do núcleo, CNPJ numérico e alfanumérico; confere o cNF — o cNF e o número são
RECEBIDOS, nunca sorteados aqui — D-NE7/D-NE257); `formats.ts` (decimal EXATO em BigInt → tipos do leiaute; `TDec_1302Opc` zero = elemento omitido; `nfeText`
= D-NE28: mantém acento, colapsa espaços e RECUSA o que o `isXsdTString` do núcleo não aceita — nunca corta); `totals.ts` (`ICMSTot` = soma dos itens em
centavos; o vNF do ERP conferido contra `fiscal-api/merchandise-total`, tolerância zero → 422 `FISCAL_TOTALS_MOTOR_DEFECT`); `homologation.ts` (D-NE216);
`simples-text.ts` (D-NE271/D-NE274: só a frase FIXA do art. 59 § 4º da CGSN 140, pelo CRT e pela data, até 31/12/2026 — a frase do CRÉDITO de ICMS é do ERP web e chega pronta na observação da nota; escrevê-la aqui a duplicaria); `tech-responsible.ts`
(`infRespTec` + `hashCsrt`; o VALOR do CSRT nunca em XML, log, erro ou teste — o único em teste é o exemplo público da NT 2018.005); `nfe-builder.ts`
(`buildNfeXml(input, chave)` → `NFe` SEM assinatura + o `Id` para o `signXml`; cUF, cNF, série, número, tpEmis e cDV saem DA CHAVE; recusa = 422
`FISCAL_DOCUMENT_INVALID` com a lista INTEIRA de campos, nunca XML incompleto); `return-reference.ts` (devolução × procNFe da origem, pelo `parseXml` do
núcleo — D-NE103); `nfe-input.ts` (a PONTE pura fatos do P2 → entrada do builder: finNFe/tpNF/idDest pelo elo da devolução e pelo CFOP, valores do item pela
fórmula do faturamento, unidade tributável pelo fator, pagamento e `cobr` das parcelas — D-NE272); `errors.ts` (códigos). **Perfil do 1º release**: modelo
55, emissão normal, venda (finNFe 1, saída) e devolução de venda PRÓPRIA (finNFe 4, nota de ENTRADA do mesmo emitente, referência POR ITEM, tPag 90, sem
cobrança), Simples (CSOSN 101, 102, 103, 300, 400), PIS/COFINS CST 04 a 09 e os do grupo `Outr` que o XSD enumera (49 a 56, 60 a 67, 70 a 75, 98, 99); o resto = recusa `fora-do-primeiro-release`. ⚠️ Conhecimento negativo:
o `TNFe` EXIGE a `Signature` — só a NF-e assinada passa no `validateMessage('NFe', …)` (raiz `nfe_v4.00.xsd` do PL_010f; a `enviNFe` é da NFE.E6.P1); as
rej. da devolução por item são a 1193 e a 1194 (esta só na devolução de SAÍDA), não a 1039/1048; o builder exige o CST de PIS/COFINS e NÃO assume o 07
(o faturamento do ERP web ainda não o registra no Simples); fora de `item-numbering.ts` ninguém escreve `nItem: valor` — o `det` usa `nItemAttribute`.
**IBS/CBS no builder** (NFE.E5.P4, D-NE277, PM-12 — ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e5-p4-ibscbs-2026.md`): em 2026 a NF-e do Simples (CRT 1) sai SEM o grupo `IBSCBS`, sem total de IBS/CBS e sem `vNFTot` (a rej. 1115 vale só para CRT 3; escrever CST + cClassTrib sem o `gIBSCBS` é a rej. 1022 quando o CST exige o grupo — NT 2025.002 v1.53 L2743-2801). De 01/01/2027 em diante (`IBSCBS_SIMPLES_FROM`) o `buildNfeXml` RECUSA toda nota (venda e devolução) com `ide.dhEmi … fora-do-primeiro-release`: o Simples passa a declarar `cAtivSN`, `gTribSN` e os totais (NT 2026.005), que não estão em XSD nenhum do acervo — a trava sai com o NFE.E5.P6. Prova: `nfe-ibscbs-2026.test.ts`.
**Camada 1 da pré-validação** (NFE.E5.P5, D-NE43/D-NE253 — ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e5-p5-camada1.md`): `src/nfe/layer1.ts` é
um SEGUNDO olhar, independente do builder, sobre o XML candidato (pré-assinatura): `validateCandidate(xml, ctx)` devolve TODAS as violações (regra, RF,
rejeição ou `null` quando é escolha nossa, campo só com nome de elemento — nunca valor nem hash) e `assertLayer1` lança o 422 (`FISCAL_DOCUMENT_INVALID`;
a R9 sozinha = `FISCAL_TOTALS_MOTOR_DEFECT`). PURA: o relógio, as UFs, o ambiente, o vNF do ERP e `csrtRequired` entram pelo `Layer1Context`; nada do builder
é importado (cerca no teste). 14 regras em `LAYER1_RULES` (R1 chave, R2 `dhEmi`, R3 UF/ambiente/município, R4 emissão normal + modelo 55 + CRT 1, R5 texto de
homologação e CNPJ do destinatário, R6 responsável técnico, R7 `nItem`, R8 `ICMSTot` por campo com a rejeição de cada um, R9 vNF, R10 XSD, R11 formato do
texto, R12 tamanho, R13 pagamento, R14 devolução e chave referenciada). O tamanho é conferido ANTES de ler. Quem compõe a transmissão (NFE.E6.P1) monta o
contexto e chama `assertLayer1` antes de assinar e de abrir tentativa; os limites aceitos (indTot, PISST, CPF, NFref em venda, ISSQN, emitente trocado) estão
na ficha §9 e na árvore. Teste: `src/__tests__/nfe-layer1.test.ts` (a cerca do catálogo confere as regras que de fato acenderam).
**Transmitir, consultar e reconferir** (NFE.E6.P1, D-NE282/D-NE283/D-NE284 — ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e6-p1-transmitir-consultar-reconferir.md`): `src/nfe/dh-emi.ts` (o `dhEmi` =
data do `dt_emission` + hora de parede do `created_at` UTC na zona do estabelecimento — nunca o relógio); `src/nfe/compose.ts` (os fatos do ERP só por `src/facts`; na devolução cada item é
conferido contra o `-procNFe.xml` ARQUIVADO da origem antes de qualquer tentativa); `src/nfe/attempt.ts` (o ÚNICO escritor da tabela das tentativas e o ÚNICO que chama `nextInvoiceNumber`:
INSERT com `cNF` por `crypto`, write-once de `receipt`/`protocol`/`dh_recbto`, a barreira de nova tentativa e a política do número — R e F reaproveitam número e série, em voo/autorizada/
denegada/cancelada barram; em voo com o 217 PROVADO — o fato — solta, mesmo número, D-NE292); `src/nfe/transmission.ts` (`transmitInvoice`: habilitação travada antes de qualquer leitura comum → número → chave → CSRT por nota depois do lock →
camada 1 → assinatura → XSD → `digVal` → INSERT + `-nfe.xml` write-once; o fisco FORA de transação; a voz A/D/R/P/F com o `kind` literal; `assertFamilyInCatalog` é a T3); `src/nfe/reconcile.ts`
(`refreshInvoice` pela chave ou recibo com cota por intervalo mínimo e `digVal`; `reconfirmNotRegistered` pela peça `notRegisteredProven` do núcleo, depois dos 10 minutos de idade da D-NE291; o A/D que o fisco devolver depois para a tentativa com o fato é incidente); `src/nfe/cancellation.ts` (NFE.E6.P2.T1: `cancelInvoice` — K/C/N pelas peças do núcleo `reserveCancelRequest`/`recordKindOnce`/`releaseCancelRequest`; só voz A vigente; trava de 480 h da autorização e aviso do prazo da UF em `src/authority/cancel-deadlines.ts`; o evento 110111 é gravado ANTES do envio e REAPROVEITADO num 2º pedido; C só com 135/155; o nProt vive no `-evt110111-1-proc.xml`); `src/nfe/void-range.ts` (T2: `voidRange` — habilitação → A1 → `lockNumberSequence` [o ÚNICO que a chama]; só até o último número gerado; recusa número de que alguma tentativa é dona; a linha nasce PENDENTE e a resposta a preenche UMA vez — o ÚNICO UPDATE de `tb_invoice_number_void`, cerca `void-range-append-only.test.ts`; 102/563 retiram, 256/241 são história; `<Id43>-inut.xml`); `src/nfe/refresh-all.ts` (T3: o rodízio, teto de idade = prazo da UF + 24 h, não reenvia inutilização pendente) e `src/nfe/breaker.ts` (o disjuntor do 656, em memória, por CNPJ × ambiente × serviço: 20 rejeições iguais/h em evento e inutilização, 30 na autorização, 656 devolvido = 1 h); `src/nfe/proc-evento.ts` (procEventoNFe e ProcInutNFe, nomes da D-NE50); o K/N é reconciliado pela consulta (`reconcile.ts`: C se o fisco cancelou, N depois da carência de 10 min). As rotas HTTP e a `fiscalView` são da NFE.E6.P4 (S1/S2); `src/nfe/not-registered.ts` (o ÚNICO escritor de `nfe_not_registered_at`, migration 002); `src/authority/cstat-voice.ts` (cStat → voz; 204/539/205/206/218/635 só
consultam a chave, nunca R). Rotas `GET /v1/nfe/invoices/{id}`, `POST …/transmit`, `…/refresh`, `…/reconfirm` (`src/modules/invoices`), guardas TRANSMITIR/CONSULTAR por ramo. Testes com fisco
simulado e banco em memória (`__tests__/nfe-memdb.ts`); o motor real é `nfe-attempt-db.test.ts` (só com `NFE_ADV_E6P1_DB=1`, banco descartável — não rodado). Nenhum envio real à SEFAZ.
**DANFE A4 retrato** (NFE.E6.P3, D-NE51/D-NE52/D-NE100/D-NE157/D-NE228 — ficha `projetos/nfe-api/SUBJECT/NFE_SEFAZ/ficha-nfe-e6-p3-danfe.md`): pasta `src/nfe/danfe/` — `danfe.ts` `renderDanfe({ procNfeXml, voice, creationDate? }) → Promise<Buffer>` (o PDF), `danfe-marks.ts` `danfeMarksOf(voz, tpAmb)`, `danfe-read.ts` (`nfeProc` pelo `parseXml` estrito; só o que o XML traz), `danfe-layout.ts` (medidas e tabela de trechos — papel, corpo, piso e alinhamento) e `danfe-format.ts`. Leiaute = modelo vertical da NT 2026.010 (o Anexo II vale no que a NT não muda). Contrato: o `procNfeXml` é o `nfeProc` ARQUIVADO da nota autorizada; a `voice` é o `kind` da última voz da tentativa — A, K e N saem sem carimbo, C leva CANCELADA, R, P, F, D, S e ausente = 422 no campo `voice`; as marcas ("SEM VALOR FISCAL" em marca d'água quando o `tpAmb` do XML é 2) saem da voz e do XML, ninguém as passa por fora; recusa = 422 `FISCAL_DOCUMENT_INVALID` (campo `procNfeXml` ou `voice`), nunca PDF parcial. Pura: sem banco, sem `.env`, sem rede; síncrona (990 itens < 20 s: quem chama decide se usa worker). TODO texto passa por `emit` (a ÚNICA chamada de `writeText`, corpo e opções completos — D-NE157); o valor do XML nunca encolhe nem é abreviado (quebra em linhas). ⚠️ Cerca: `src/__tests__/pdf-family-fence.ts` é CÓPIA da do núcleo (936f88b) com o alcance da D-NE228 e `danfe-family-fence.test.ts` varre `src/nfe/danfe/**` inteira (qualquer extensão) e exige que nada fora dela (e fora de `__tests__`) importe `fiscal-api/pdf` ou `pdfkit`: nada de `doc.text`, `doc.font`, medidas cruas, `addPage`, `addContent`, anotações ou `doc.page.write`. Fora do 1º release (S-1 a S-9 da ficha): logo (sem porta de imagem no núcleo — D-NE241), canhoto, QR Code, paisagem, bloco IBS/CBS (XML com o grupo = 422), IPI do item, DANFE de nota não autorizada. A `voice-kind-fence` só passa com a pasta do repositório chamada `nfe-api` (numa worktree de outro nome ela acusa o caminho, sem ser defeito). Teste: `danfe*.test.ts`, `pdf-text*.ts` (leitor de texto do PDF, só de teste).
Ao concluir tarefa que gere conhecimento novo, siga `Infra-IA/skills-genericas/atualizar-infra-ia.md`.

## Estado (2026-10-20) — NE-2 EXECUTADA em worktree (`D:\Gestao2027\ne2\{fiscal-api,nfe-api}`, branch `ne2`) — `prompt_onda_nfe_sefaz.md` §15.9

**A pasta tem código desde a NE-2 (D-NE1 — a D-F20 está suspensa para as ondas NE-0…NE-3).** O que existe:
- **Esqueleto no molde da nfse-api** (E1): `src/{app,server,context,health,cors-origins}.ts`, `src/migrations/index.ts` (núcleo → `nfe-api`),
  `src/modules/emitter` (o emitter do NÚCLEO montado para o ramo `merchandise` — D-NE9; **só o 55** — D-NE2/D-NE166; a habilitação guarda só o
  AMBIENTE, a série é do ERP — D-F21/D-NE11; SEM cerca da virada — D-NE10), `ops/grants.sql`, `scripts/{migrate,mint-dev-token,explain-leituras,
  prove-001-descartavel}.ts`; OpenAPI servido em `/docs` e `/v1/openapi.yaml`. **Servido na NE-2 (D-NE166): `GET /v1/health` + as 5 operações
  do emitente**; as outras 12 operações do contrato levam `x-onda: NE-3 | NE-5` — a cerca rota × contrato (`src/__tests__/app.test.ts`) exige
  servidas = contrato − marcadas (sem stub 501). Porta **3003**.
- **Migration 001 da família** (E2 — `src/migrations/sql/001_nfe_baseline.sql`, namespace `nfe-api`, ADITIVA): `tb_invoice_merchandise_transmission`
  (tentativa — chave NOSSA desde a reserva, D-NE7; registro = PROTOCOLO, D-NE56), `tb_invoice_merchandise_transmission_event` (voz A/R/D/P/C/K/F/N —
  sem S, D-NE107; C só 110111 — D-NE106), `tb_invoice_number_void` (inutilização — colunas GERADAS do Id; **D-NE163: UNIQUE da faixa RETIRADA por
  (institution, model, serie, environment, number_from, number_to, withdrawn) + UNIQUE da prova (environment, withdrawn_void_id)**) e as views
  `vw_invoice_merchandise_transmission` (projeção comum + só `dh_emission` — D-NE160) e `vw_invoice_number_void` (sem `authority_recorded` —
  D-NE161). Sem view de vozes (D-NE160). 15 CHECKs BINÁRIOS conferidos no boot pelo NOME. **Provada em banco descartável `fiscal_api_adv_ne2`**
  (`npm run prove:001`): runner idempotente, sondas, geradas + UNIQUE, registro pelo protocolo, EXPLAIN por chave, 3 colações, re-execução.
- **Família** (E3 — `src/nfe/voice-family.ts`): `MERCHANDISE_VOICE_WRITE_KINDS` (= o CHECK de `kind` — teste compara), `MERCHANDISE_VOICE_FAMILY`
  (`defineVoiceFamily` — o ÚNICO lugar; cerca por AST `src/__tests__/voice-kind-fence.ts` — D-NE167), sondas `assertMerchandiseVoiceDomainsEnforced` +
  `assertNumberVoidDomainsEnforced` (`src/nfe/number-void.ts`, com `voidId` por partes).
- **No núcleo** (E4 — `fiscal-api/src/voice/families/merchandise.ts`, `src/numbering/withdrawn-ranges.ts`): leitura publicada
  `MERCHANDISE_VOICE_READING` **no catálogo `VOICE_READINGS` e em `fiscal-api/reading` desde o núcleo 5.0.0** (D-NE158 — janela da NE-6, antes da 1ª
  tentativa possível; o boot daqui confere a PRÓPRIA view: `assertFamilyViewsReadable(pool, db, [MERCHANDISE_VOICE_READING])`);
  `humanEffectCancel = () => false` (D-NE159 — conhecimento negativo); leitor das faixas retiradas escopado por institution × modelo × série ×
  AMBIENTE (D-NE161/D-NE163), exposto em `fiscal-api/reading` desde o núcleo 5.0.0 (NE-6).

**Gates da NE-2 (§15.9.6)**: socrático **0,76 ✅** · adversarial **0,78 ✅** (nenhum HIGH/CRITICAL); MEDIUM viraram Q-NE170 (eixo AMBIENTE da cunhagem no ERP),
Q-NE171 (`deleted` × `withdrawn` na faixa) e Q-NE172 (`sql_mode` não estrito — transversal); corrigidos na sessão: cerca rota × contrato lendo o app REAL,
cerca por AST sem `eval`/`Function`/nome montado/`erp` sombreado, sonda do boot das duas UNIQUE da faixa (`assertNumberVoidUniqueKeys`), mapa das faixas
estrito, eco do modelo cortado, leitor das faixas pelo índice. Q-NE169 (UNIQUE da prova sem institution) aberta — rec. manter.

**Scripts**: `npm run dev` (porta 3003; `.env` a partir do `.env.example` — o MESMO usuário `fiscal_api` e a MESMA `FISCAL_MASTER_KEYS` da
nfse-api) · `npm test` (52 arquivos de teste, 51 rodam / 975 testes, 969 passam — 2026-11-25, com o DANFE; a `voice-kind-fence` só passa na pasta `nfe-api`) · `npm run typecheck` · `npm run db:migrate` (aplica núcleo 001–008 + nfe-api 001 — na publicação, no `fiscal_api`
do dev; D-NE168) · `npm run prove:001` (SÓ em `FISCAL_DB_NAME=fiscal_api_adv*` — recusa o real) · `npm run explain:leituras` · `npm run token:dev`.
⚠️ A nfe-api **não fica no ar** (D-NE168 — sobe só para o passeio); nenhuma rota de NF-e é servida antes da NE-3/NE-5.

**Fora da NE-2, registrado (§15.9)**: autorizadores (`src/authority/authorizers.ts`, constante DATADA — D-NE162, NE-3); teto de 2 MB do corpo do
fisco no `httpsRequest` comum (D-NE164 — ENTREGUE no núcleo 4.0.0, DEPLOY.E1.P7: acima de 2 MB = ambíguo `envelope-ilegivel`; o envelope SOAP — NFE.E4.P2.T1 — só o trata); prova no MySQL 8 do `fiscal_api` inteiro (D-NE165, pré-condição da F3).

**Anterior**: NE-0 FECHADA 2026-10-15 (acervo oficial em `Infra-IA/nfe-api/integracoes/nfe-sefaz/`, 65 conferências, OpenAPI design-first);
NE-1a (núcleo genérico por família) e NE-1b (`fiscal-api/pdf`) publicadas; Rodadas 1–15 decididas (D-NE1…D-NE168).

## O que este projeto É (D-F12/D-F17)

Serviço da família NF-e/NFC-e — porta **3003**, contrato `/v1`, instância Node própria (D-F9), compondo o núcleo `D:\Gestao2027\fiscal-api`
(mesmo banco `fiscal_api`, mesmo A1 — D-N31, mesma habilitação por modelo — D-E1, mesma política da voz — D-E6). Acrescenta (nas ondas
seguintes): adaptador SEFAZ (SOAP 1.2, autorizadores por UF — NE-3), builder NF-e 4.00 (+ IBS/CBS — NE-4), chave 44, inutilização de faixa,
DANFE (NE-5), fonte de fatos do ramo de mercadoria. **Série e número do 55/65 são do ERP** (cunhados no faturamento — D-F21). Não escreve DADO
no ERP (a lista da D-F31 só admite a trava da nota — D-F27 — e a trava do contador da institution na reserva da inutilização — D-NE110); não
aplica efeito; não calcula imposto (D-F10/D-F11/D-F15). O builder de autorização em PRODUÇÃO continua esperando o 1º cliente de mercadoria
(D-E20) e o IBS/CBS (D-F22).

## Regras inegociáveis (herdadas da nfse-api + as da família)

1. Toda leitura do ERP vive na fonte de fatos — nenhum `tb_invoice`/`tb_order`/`tb_entity*` fora dela (cerca em `app.test.ts`).
2. Lista de escrita da voz = `MERCHANDISE_VOICE_WRITE_KINDS`; escritor = o genérico do núcleo pelo descritor; `defineVoiceFamily` só em
   `src/nfe/voice-family.ts` (cerca por AST); nenhum "S antes do POST" — quem produzir S dá a saída na mesma entrega (D-F105).
3. Domínio fechado = CHECK BINÁRIO conferido no boot pelo NOME (PADROES §11 regras 11/16); nunca `INSERT IGNORE`; nunca desligar o CHECK na
   sessão (D-F122).
4. A família está no catálogo `VOICE_READINGS` desde o núcleo 5.0.0 (D-NE158, janela da NE-6); o boot confere SÓ a própria view (lista de uma
   leitura — D-NE76), nunca o catálogo inteiro.
5. OpenAPI em todo endpoint; rota nova = tirar a marca `x-onda` na MESMA entrega; gates socrático ≥ 0,70 + adversarial sem HIGH antes de "pronto".
