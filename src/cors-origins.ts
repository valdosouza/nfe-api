/**
 * D-F146: o app web chama a nfe-api DIRETO do navegador (D-F4) — a lista de origens é EXPLÍCITA por ambiente. A REGRA mora no NÚCLEO
 * (gate do delta da Rodada 4 da F2a, F2AR4-SOC-07/ADV-09: "a nfe-api herda"): lista vazia recusa; só origem CANÔNICA; `http://` só em
 * localhost; nada de `*`. Molde: `nfse-api/src/cors-origins.ts`.
 */
export { assertCorsOrigins, corsOriginProblem } from 'fiscal-api'
