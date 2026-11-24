import { isValidTimeZone, nowIsoIn, toZoneWall } from 'fiscal-api'
import { documentInvalid } from './errors'

/**
 * O `dhEmi` da NF-e (NFE.E6.P1 — D-NE278, D-NE284; ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-1): a DATA do `dt_emission` da nota + a HORA do
 * `created_at` (o instante em que o faturamento a criou, gravado em UTC — `PADROES_BANCO.md` §10.1), convertida para a hora de parede da ZONA do
 * estabelecimento, com o offset dessa zona. Nunca o relógio da transmissão. PURA.
 *
 * Limite aceito: linha gravada pelo setes-sync pode estar em hora local, não UTC (`PADROES_BANCO` §10.6, Q-TZ4) — a nota faturada pelo ERP web é UTC.
 */
export function dhEmiOf(dtEmission: string, createdAtUtc: string | null | undefined, zone: string | null | undefined): string {
  const fields: { field: string; message: string }[] = []
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dtEmission ?? '')) fields.push({ field: 'ide.dhEmi', message: 'Data de emissão da nota ausente ou fora do formato AAAA-MM-DD' })
  const created = /^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(createdAtUtc ?? '')
  if (!created) fields.push({ field: 'ide.dhEmi', message: 'Instante de criação da nota (created_at) ausente — a hora do dhEmi não pode ser composta' })
  if (!zone || !isValidTimeZone(zone)) fields.push({ field: 'ide.dhEmi', message: 'Zona do estabelecimento ausente ou inválida — a hora do dhEmi não pode ser composta' })
  if (fields.length) throw documentInvalid('O dhEmi da NF-e não pôde ser composto a partir dos dados da nota', fields)
  const instant = new Date(`${(created as RegExpExecArray)[1]}T${(created as RegExpExecArray)[2]}Z`)
  const wall = toZoneWall(instant, zone as string)
  if (!wall) throw documentInvalid('O dhEmi da NF-e não pôde ser composto a partir dos dados da nota', [{ field: 'ide.dhEmi', message: 'Instante de criação da nota inválido para a zona do estabelecimento' }])
  const offset = nowIsoIn(zone as string, instant).slice(19)
  return `${dtEmission}T${wall.slice(11, 19)}${offset}`
}
