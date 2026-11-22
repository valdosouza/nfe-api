# nfe-api

Serviço de emissão de **NF-e (55)** (e NFC-e 65 na F5) pela SEFAZ do Gestão 2027 — porta **3003**, contrato `/v1`, sobre o núcleo comum
`D:\Gestao2027\fiscal-api`. Consumido diretamente pelo setes-app (e qualquer front-end do produto) com o JWT do setes-api; lê os fatos da nota
no banco do produto e controlará o ciclo com a SEFAZ (reserva, autorização, consulta, cancelamento, inutilização — ondas NE-3…NE-5).

**Estado (2026-10-20): NE-2 executada** — esqueleto no molde da nfse-api, migration 001 da família (provada em banco descartável), descritor
da voz + sondas do boot, leitura publicada no núcleo (no catálogo e em `fiscal-api/reading` desde o núcleo 5.0.0 — janela da NE-6). Servido: `GET /v1/health` e o emitente; o resto do
contrato está marcado `x-onda` (NE-3/NE-5). Plano: `D:\Gestao2027\Infra-IA\prompts\prompt_onda_nfe_sefaz.md` §15 (§15.9 = execução) ·
índice: `D:\Gestao2027\Infra-IA\nfe-api\INDEX.md`.
