# CLAUDE.md — nfe-api (serviço da família NF-e / NFC-e)

## ⚠️ Base de conhecimento central: D:\Gestao2027\Infra-IA

Antes de qualquer tarefa neste projeto, consulte `D:\Gestao2027\Infra-IA\INDICE_CENTRAL.md` e
**`Infra-IA/nfe-api/INDEX.md`** (START HERE). Decisões vigentes: D-F1…D-F59 em
`Infra-IA/prompts/prompt_apis_fiscais_isoladas.md` §7 (plano §12) e D-E1…D-E25 em
`Infra-IA/prompts/prompt_onda_nfe_sefaz.md` — **Rodada 0 da nfe-api no §11 desse prompt (2026-10-10, Q-NE1…Q-NE26)**.

## Estado (2026-10-03) — pasta SEM código, por decisão (D-F20)

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
