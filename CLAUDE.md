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
**Núcleo em uso: 2.0.0** (DEPLOY.E1.P5, por acompanhamento da nfse-api — D-F237/D-F249): XML no layout D-F241 pelo `src/nfe/fiscal-file.ts`
(55 = `nfe`, 65 = `nfce`), raiz por `fiscalStorageRootFromEnv`, CORS com o ambiente (D-F236).
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
  `MERCHANDISE_VOICE_READING` **FORA do catálogo `VOICE_READINGS` e fora de `fiscal-api/reading`** (D-NE158 — entra na janela da NE-6, antes da 1ª
  tentativa possível; o boot daqui confere a PRÓPRIA view: `assertFamilyViewsReadable(pool, db, [MERCHANDISE_VOICE_READING])`);
  `humanEffectCancel = () => false` (D-NE159 — conhecimento negativo); leitor das faixas retiradas escopado por institution × modelo × série ×
  AMBIENTE (D-NE161/D-NE163), exposto em `fiscal-api/reading` só com o 1º leitor (NE-6).

**Gates da NE-2 (§15.9.6)**: socrático **0,76 ✅** · adversarial **0,78 ✅** (nenhum HIGH/CRITICAL); MEDIUM viraram Q-NE170 (eixo AMBIENTE da cunhagem no ERP),
Q-NE171 (`deleted` × `withdrawn` na faixa) e Q-NE172 (`sql_mode` não estrito — transversal); corrigidos na sessão: cerca rota × contrato lendo o app REAL,
cerca por AST sem `eval`/`Function`/nome montado/`erp` sombreado, sonda do boot das duas UNIQUE da faixa (`assertNumberVoidUniqueKeys`), mapa das faixas
estrito, eco do modelo cortado, leitor das faixas pelo índice. Q-NE169 (UNIQUE da prova sem institution) aberta — rec. manter.

**Scripts**: `npm run dev` (porta 3003; `.env` a partir do `.env.example` — o MESMO usuário `fiscal_api` e a MESMA `FISCAL_MASTER_KEYS` da
nfse-api) · `npm test` (68 — 2026-11-18) · `npm run typecheck` · `npm run db:migrate` (aplica núcleo 001–005 + nfe-api 001 — na publicação, no `fiscal_api`
do dev; D-NE168) · `npm run prove:001` (SÓ em `FISCAL_DB_NAME=fiscal_api_adv*` — recusa o real) · `npm run explain:leituras` · `npm run token:dev`.
⚠️ A nfe-api **não fica no ar** (D-NE168 — sobe só para o passeio); nenhuma rota de NF-e é servida antes da NE-3/NE-5.

**Fora da NE-2, registrado (§15.9)**: autorizadores (`src/authority/authorizers.ts`, constante DATADA — D-NE162, NE-3); teto de 2 MB do corpo do
fisco no `httpsRequest` comum (D-NE164, NE-3 — vale para as duas famílias); prova no MySQL 8 do `fiscal_api` inteiro (D-NE165, pré-condição da F3).

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
4. A família entra no catálogo `VOICE_READINGS` só na janela da NE-6 (D-NE158); até lá o boot confere a própria view e nenhuma reserva é montada.
5. OpenAPI em todo endpoint; rota nova = tirar a marca `x-onda` na MESMA entrega; gates socrático ≥ 0,70 + adversarial sem HIGH antes de "pronto".
