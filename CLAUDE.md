# CLAUDE.md — nfe-api (serviço da família NF-e / NFC-e)

## ⚠️ Base de conhecimento central: D:\Gestao2027\Infra-IA

Antes de qualquer tarefa neste projeto, consulte `D:\Gestao2027\Infra-IA\INDICE_CENTRAL.md` e
**`Infra-IA/nfe-api/INDEX.md`** (START HERE). Decisões vigentes: D-F1…D-F220 em
`Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §7 (plano §12) — **D-F105: a NF-e PODE produzir a voz S, desde que dê a saída dela na
mesma entrega (consulta pela NOSSA chave; o P sai pela consulta do recibo — D-NE33); a cerca da D-F102 é só da NFS-e. D-F108: na NE-1a a
lista de escrita de cada família vai no DESCRITOR da família no núcleo (`VoiceFamily<K>`) e o escritor comum é genérico nela — nota de
implantação no `prompt_onda_nfe_sefaz.md` §12.8** — e D-E1…D-E25 em
`Infra-IA/prompts/prompt_onda_nfe_sefaz.md` — **Rodada 0 da nfe-api no §11 desse prompt (2026-10-10, Q-NE1…Q-NE26)**;
decisões da nfe-api D-NE1…D-NE90 (§11.7, §12.7, §12.9).

## Estado (2026-10-15) — NE-0 FECHADA (Rodadas 3 e 4 decididas — D-NE93…D-NE114); pasta ainda sem código de serviço

**2026-10-15 (noite)**: Rodada 4 decidida (`prompt_onda_nfe_sefaz.md` §13.10 = ponto de retomada). Próximo: frente do CNPJ alfanumérico
(D-NE99) → NE-1b/NE-2/NE-3 (a NE-2 nasce do DDL em rascunho + `openapi/nfe-api.v1.yaml`).


**2026-10-15 (tarde)**: NE-0 executada (`prompt_onda_nfe_sefaz.md` §13.9): acervo oficial arquivado e 65 conferências fechadas em
`Infra-IA/nfe-api/integracoes/nfe-sefaz/`; **`openapi/nfe-api.v1.yaml` criado aqui** (design-first — vira a fonte de verdade das rotas na
NE-2); DDL da família em rascunho em `Infra-IA/prompts/prompt_onda_nfe_sefaz-ddl-ne2-rascunho.sql`. Rodada 4 (Q-NE102…Q-NE114) pendente.


**2026-10-15**: NE-1a feita e publicada (2026-10-12 — o núcleo `fiscal-api` já é genérico por família); F2a/F2b executadas em
produção (2026-10-14/15). **NE-0 ABERTA** (`prompt_onda_nfe_sefaz.md` §13 — ponto de retomada): levantamento oficial em
`Infra-IA/nfe-api/integracoes/nfe-sefaz/` (README + CONFERENCIAS; arquivamento pendente da Q-NE94); a NE-0 entrega também o
OpenAPI design-first em `openapi/nfe-api.v1.yaml` (molde da nfse-api) — o único arquivo que nasce AQUI antes da NE-2.
Q-NE94…Q-NE101 aguardam o Valdo.

**2026-10-10**: Rodada 0 organizada e **Rodada 1 DECIDIDA** (`prompt_onda_nfe_sefaz.md` §11.7, D-NE1…D-NE26): a **D-F20 está
SUSPENSA EM PARTE (D-NE1)** — as ondas NE-0…NE-3 (levantamento, núcleo generalizado, esqueleto + DDL, adaptador SEFAZ em H sem
emitente com IE) podem criar código aqui, na ordem do §11.7; builder de autorização em produção continua esperando o 1º cliente
de mercadoria. A regra abaixo vale para tudo que estiver fora das NE-0…NE-3.

**Não crie `src/` nem `package.json` aqui.** A NF-e (modelo 55) e a NFC-e (65) só ganham código com o
**1º cliente de mercadoria** (D-E20 — vale para o QUANDO) e **depois do IBS/CBS** (D-F22). Antes do
código: levantamento oficial da SEFAZ em `Infra-IA/nfe-api/integracoes/nfe-sefaz/` (MOC 7.0, NTs,
schemas PL, autorizadores por UF, cStat).

## O que este projeto SERÁ (D-F12/D-F17)

Serviço da família NF-e/NFC-e — porta prevista **3003**, contrato `/v1`, instância Node própria (D-F9),
compondo o núcleo `D:\Gestao2027\fiscal-api` (mesmo banco `fiscal_api`, mesmo A1 — D-N31, mesma
habilitação por modelo — D-E1, mesma política da voz — D-E6). Acrescenta: adaptador SEFAZ (SOAP 1.2,
autorizadores por UF), builder NF-e 4.00 (+ IBS/CBS), chave 44, inutilização de faixa, DANFE, fonte de
fatos do ramo de mercadoria. **Série e número do 55/65 são do ERP** (cunhados no faturamento — D-F21).
Não escreve DADO no ERP (a lista da D-F31 só admite a trava da nota — D-F27); não aplica efeito; não calcula imposto
(D-F10/D-F11/D-F15).
