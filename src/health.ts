import type { RequestHandler } from 'express'
import type { AppContext } from './context'
import type { KeyProof } from './key-proof'

/**
 * /v1/health (sem autenticação): prova banco, chave-mestra e storage — critério §12.8-1. 200 só com os três; 503 diz qual falhou (nunca
 * conteúdo, nunca qual versão). `serverChain` (D-NE54 a — NFE.E4.P3.T3): as raízes ICP do servidor da SEFAZ estão carregadas e de que
 * fonte; sem elas o serviço nem sobe (D-NE187), então aqui é sempre `loaded: true`. O `authorities` (consStatServ por autorizador —
 * D-NE54 c; NFE.E6.P4) é o último que a passada do rodízio consultou, em memória do processo.
 *
 * Chave-mestra (D-NE189 → D-F243/D-F244/D-F245 — DEPLOY.E1.P6): o sinal é o último resultado da `KeyProof`, que abre UM segredo guardado (A1 ou senha SMTP) por
 * versão em uso na partida e a cada 5 minutos. Chamar o health NÃO abre certificado nenhum (o endereço é aberto e o monitor chama a cada
 * poucos segundos). Segredo ilegível com a chave certa (`degraded`) não aparece aqui: vai para o log.
 */
export function healthHandler(ctx: AppContext, keyProof: KeyProof): RequestHandler {
  return async (_req, res) => {
   try {
    let db = false
    try { await ctx.pool.query('SELECT 1 FROM tb_establishment_issuer LIMIT 1'); db = true } catch { db = false }
    const masterKey = keyProof.masterKey
    const storage = ctx.storage.probe()
    const ok = db && masterKey && storage
    ctx.checkServerCa?.()                                                // D-NE54 a: relê as raízes se o arquivo mudou (e dá o alarme dos 60 dias)
    const serverChain = { loaded: ctx.serverCa.certificates.length > 0, source: ctx.serverCa.source }
    // D-NE54 c: o ÚLTIMO consStatServ de cada autorizador consultado pela passada do rodízio — o health só LÊ o quadro (nunca fala com o fisco); autorizador fora não derruba o health
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db, masterKey, storage, serverChain, authorities: ctx.statusBoard?.list() ?? [] })
   } catch { res.status(503).json({ status: 'degraded', db: false, masterKey: false, storage: false, serverChain: { loaded: false, source: 'unknown' }, authorities: [] }) }   // NFE.E6.P5 (rodada 2): nada aqui derruba o processo
  }
}
