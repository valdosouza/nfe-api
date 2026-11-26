import { isValidTimeZone, nowIsoIn, toZoneWall } from 'fiscal-api'
import { documentInvalid } from './errors'

/**
 * O `dhEmi` da NF-e (NFE.E6.P1 — D-NE278, D-NE284, D-NE296; ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-1 e §10): a DATA do `dt_emission` da nota +
 * a HORA do faturamento da VIDA ATUAL — o `created_at` do evento E da vida (`vw_invoice_life`), gravado em UTC (`PADROES_BANCO.md` §10.1), não o da linha da
 * nota, que fica com a hora do 1º faturamento quando ela revive (D-NE296) —, convertida para a hora de parede da ZONA do estabelecimento, com o offset dessa
 * zona. Nunca o relógio da transmissão. PURA. Sem o instante (nota sem evento E — carga ou sincronização) recusa com 422 (S-A da ficha §10); com o
 * evento de OUTRA data que não a da nota (`lifeDate` ≠ `dtEmission` — linha regravada) recusa com 422 pela causa própria (S-B da ficha §10).
 *
 * Limites aceitos: linha gravada pelo setes-sync pode estar em hora local, não UTC (`PADROES_BANCO` §10.6, Q-TZ4) — a nota faturada pelo ERP web é UTC; os E
 * retroativos das migrations 042/046 do setes-api têm a hora da migration (notas antigas, recusadas pela camada 1 acima de 30 dias — D-NE279).
 */
export function dhEmiOf(dtEmission: string, createdAtUtc: string | null | undefined, zone: string | null | undefined, lifeDate?: string | null): string {
  const fields: { field: string; message: string }[] = []
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dtEmission ?? '')) fields.push({ field: 'ide.dhEmi', message: 'Data de emissão da nota ausente ou fora do formato AAAA-MM-DD' })
  const created = /^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(createdAtUtc ?? '')
  if (!created) fields.push({ field: 'ide.dhEmi', message: 'Instante do evento de faturamento da vida da nota ausente (nota sem evento E — carga ou sincronização) — a hora do dhEmi não pode ser composta' })
  if (created && lifeDate != null && lifeDate !== dtEmission) {
    fields.push({ field: 'ide.dhEmi', message: `O evento de faturamento da vida tem a data ${lifeDate} e a nota tem a data ${dtEmission} (linha da nota regravada?) — a hora do dhEmi não pode ser composta` })
  }
  if (!zone || !isValidTimeZone(zone)) fields.push({ field: 'ide.dhEmi', message: 'Zona do estabelecimento ausente ou inválida — a hora do dhEmi não pode ser composta' })
  if (fields.length) throw documentInvalid('O dhEmi da NF-e não pôde ser composto a partir dos dados da nota', fields)
  const instant = new Date(`${(created as RegExpExecArray)[1]}T${(created as RegExpExecArray)[2]}Z`)
  const wall = toZoneWall(instant, zone as string)
  if (!wall) throw documentInvalid('O dhEmi da NF-e não pôde ser composto a partir dos dados da nota', [{ field: 'ide.dhEmi', message: 'Instante do evento de faturamento da vida da nota inválido para a zona do estabelecimento' }])
  const offset = nowIsoIn(zone as string, instant).slice(19)
  return `${dtEmission}T${wall.slice(11, 19)}${offset}`
}
