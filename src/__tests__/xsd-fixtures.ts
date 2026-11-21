// Mensagens de TESTE escritas à mão a partir do leiaute (nenhum XML real; CNPJ da própria Setes, homologação). NFE.E4.P3, mudanças 1 e 2.
export const NS = 'http://www.portalfiscal.inf.br/nfe'
export const CNPJ = '07742094000113'
/** Chave de teste (só a forma do XSD; o DV não é conferido pelo XSD). */
export const CHAVE = '41261107742094000113550010000000011123456789'

/** `ds:Signature` estruturalmente válida para o xmldsig-core-schema da NF-e (o XSD a exige, não a confere). */
export const signature = (ref: string) =>
  '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>'
  + '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>'
  + '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>'
  + `<Reference URI="#${ref}"><Transforms>`
  + '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>'
  + '<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/></Transforms>'
  + '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>'
  + '<DigestValue>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</DigestValue></Reference></SignedInfo>'
  + '<SignatureValue>AAAA</SignatureValue><KeyInfo><X509Data><X509Certificate>AAAA</X509Certificate></X509Data></KeyInfo></Signature>'

export const consStatServ = (tpAmb = '2') =>
  `<consStatServ xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><cUF>41</cUF><xServ>STATUS</xServ></consStatServ>`

export const consSitNFe = (chave = CHAVE) =>
  `<consSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><xServ>CONSULTAR</xServ><chNFe>${chave}</chNFe></consSitNFe>`

export const consReciNFe = (nRec = '411000000000001') =>
  `<consReciNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><nRec>${nRec}</nRec></consReciNFe>`

export const consCad = (cnpj = CNPJ) =>
  `<ConsCad xmlns="${NS}" versao="2.00"><infCons><xServ>CONS-CAD</xServ><UF>PR</UF><CNPJ>${cnpj}</CNPJ></infCons></ConsCad>`

export const inutNFe = (nNFIni = '1') => {
  const id = `ID4126${CNPJ}55001${'1'.padStart(9, '0')}${'10'.padStart(9, '0')}`
  return `<inutNFe xmlns="${NS}" versao="4.00"><infInut Id="${id}"><tpAmb>2</tpAmb><xServ>INUTILIZAR</xServ><cUF>41</cUF><ano>26</ano>`
    + `<CNPJ>${CNPJ}</CNPJ><mod>55</mod><serie>1</serie><nNFIni>${nNFIni}</nNFIni><nNFFin>10</nNFFin>`
    + `<xJust>Numeracao pulada no teste em homologacao</xJust></infInut>${signature(id)}</inutNFe>`
}

export const envEvento110111 = (nProt = '141260000000001', xJust = 'Cancelamento de teste em homologacao') => {
  const id = `ID110111${CHAVE}01`
  return `<envEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><evento versao="1.00"><infEvento Id="${id}">`
    + `<cOrgao>41</cOrgao><tpAmb>2</tpAmb><CNPJ>${CNPJ}</CNPJ><chNFe>${CHAVE}</chNFe><dhEvento>2026-11-21T10:00:00-03:00</dhEvento>`
    + '<tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>'
    + `<detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${nProt}</nProt><xJust>${xJust}</xJust></detEvento>`
    + `</infEvento>${signature(id)}</evento></envEvento>`
}
