-- nfe-api 001 — FAMÍLIA NF-e (ramo `merchandise`, modelos 55/65) no banco `fiscal_api` — NE-2 (2026-10-20; `Infra-IA/prompts/
-- prompt_onda_nfe_sefaz.md` §15.4 E2 / §15.9). Nasce do rascunho v1.1 da NE-0 (`Infra-IA/prompts/prompt_onda_nfe_sefaz-ddl-ne2-rascunho.sql`,
-- revisado pelo guardião e pelo revisar-ddl) com as decisões da Rodada 15 (§15.8):
--  * D-NE160: a leitura publicada tem como coluna PRÓPRIA só `dh_emission`; a view de VOZES (4.2 do rascunho) NÃO nasce (sem consumidor —
--    `voiceView` saiu do contrato publicado do núcleo); `protocol`/`authorizer`/`receipt`/`dh_recbto`/`digest_value` ficam INTERNOS;
--  * D-NE161: a view das faixas RETIRADAS da numeração nasce aqui (fato da NOSSA numeração — D-F21), SEM `authority_recorded` (o ERP pula
--    pendente e homologada igual — D-NE110); o leitor mora no núcleo (`numbering/`), escopado por institution × modelo × série × AMBIENTE;
--  * D-NE163: a faixa retirada tem identidade COMPOSTA com a SÉRIE — UNIQUE `(institution, model, serie, environment, number_from,
--    number_to)` entre as linhas RETIRADAS (colunas GERADAS do Id — uma fonte só), e a PROVA (ProcInutNFe do 102/563) é UMA por faixa
--    retirada por ambiente — UNIQUE `(environment, withdrawn_void_id)`. Corrige o DEFEITO do rascunho (UNIQUE sem o ambiente: a faixa de
--    H bloqueava a mesma faixa em P para sempre — o Id de 43 não leva tpAmb).
-- Namespace próprio em `_migrations (project = 'nfe-api', version)` — PADROES §11 regra 2; dono = a família (D-F35). ADITIVA: não toca
-- tabela de outra família nem do núcleo (D-NE168 — o núcleo só acrescenta; a nfse-api não reinicia).
-- Molde de FORMA: nfse-api 001..007 (tentativa × voz, life_event, projeção comum da 004 com COLLATE bin, domínios binários 005/006).
-- Fatos oficiais: Infra-IA/nfe-api/integracoes/nfe-sefaz/ (README, CONFERENCIAS, AUTORIZADORES; PL_010f_v1.04 tiposBasico_v4.00:
-- TChNFe [0-9]{6}[0-9A-Z]{12}[0-9]{26} · TProt [0-9]{15}|[0-9]{17} · TRec [0-9]{15} · TStat [0-9]{3,4}).
--
-- O QUE NÃO VIRA COLUNA (e onde vive):
--  * XML: `<chave>-nfe.xml` (candidato assinado, gravado IGUAL ao validado — D-NE43), `<chave>-procNFe.xml` (autorizada OU denegada —
--    D-NE35), `<chave>-evt110111-1.xml`, `<Id43>-inut.xml` (SÓ a prova — ProcInutNFe do 102/563; D-NE163), em `<cnpj>/<H|P>/<ano>/<mes>`
--    (D-NE50 — a pasta carrega o AMBIENTE e o Id carrega modelo, série e faixa: o nome é único por faixa retirada e ambiente, como a
--    UNIQUE da prova). O XML é o snapshot do que o documento DECLARA (emitente, IE, itens, totais, tpAmb): nada disso vira coluna.
--  * cNF, cDV e tpEmis: gravados POR CONSTRUÇÃO dentro da chave (posições 36-43, 44 e 35) — D-NE7/D-NE37.
--  * presença de IE do emitente: declarada no XML (emit/IE presente ou ausente); a CONSEQUÊNCIA dela — o autorizador — é a coluna (D-NE105).
--  * série e número da nota: do ERP (D-F21/D-NE11) — estão na chave; nenhuma coluna de série/número/contador na família.
--  * valores de imposto: conteúdo do ERP (D-NE15/D-NE27) — na NF-e QUEM CALCULA é o emitente.
--  * teto de 2 MB do corpo HTTP (D-NE93 → D-NE164: NE-3, no transporte comum).
-- Sem FK para o ERP (outro banco): tb_institution_id + tb_invoice_id + terminal = a nota em setes_<cliente> (D-F10/D-F15).
-- MariaDB 10.4 SEM modo estrito: domínio fechado = CHECK BINÁRIO conferido no boot pelo NOME (PADROES §11 regras 11 e 16 — a sonda
-- `assertMerchandiseVoiceDomainsEnforced`/`assertNumberVoidDomainsEnforced` em `src/nfe/`); escritor nunca INSERT IGNORE. CHECK com
-- expressão NULL PASSA — por isso cada CHECK sobre coluna anulável diz o caso NULL explicitamente.
-- RE-EXECUTÁVEL: CREATE TABLE IF NOT EXISTS com as constraints no CREATE; CREATE OR REPLACE VIEW (provado no descartável — §15.9).
-- ⚠️ MySQL 8 (F3 — D-NE165): a prova desta e de TODAS as migrations do `fiscal_api` no motor da SaveInCloud é PRÉ-CONDIÇÃO da F3
-- (REGEXP por ICU × PCRE; GRANT do FOR UPDATE; coluna gerada encadeada).

-- =============================================================================================================================
-- 1. TENTATIVA de autorização da NF-e (conceito B — uma declaração do ramo de mercadoria de UMA vida da nota, apresentada ao fisco
--    com a chave que NÓS cunhamos). N por vida; attempt contínuo por nota, atravessa as vidas (molde da nfse-api 001).
--    Diferenças de FATO com a NFS-e: a chave é NOSSA e existe desde a reserva (D-NE7); "registro" = protocolo (D-NE56); não há DPS por
--    vida (quem numera é o ERP — D-F21), logo NÃO há tabela de vida nem JOIN na view.
--    Write-once (NULL -> valor UMA vez, pelo escritor da família com `... WHERE col IS NULL`): receipt, protocol, dh_recbto.
--    Imutáveis desde o INSERT: access_key, life_event, environment, authorizer, dh_emission, digest_value.
-- =============================================================================================================================
CREATE TABLE IF NOT EXISTS `tb_invoice_merchandise_transmission` (
  `tb_institution_id` INT(11) NOT NULL COMMENT 'Estabelecimento = institution do produto (sem FK, outro banco; D-F10)',
  `tb_invoice_id`     INT(11) NOT NULL COMMENT 'Nota no schema do cliente (= pedido); referencia sem FK',
  `terminal`          INT(11) NOT NULL DEFAULT 0 COMMENT 'Terminal da nota (D-NE12; 0 = web, so na borda)',
  `attempt`           INT(11) NOT NULL COMMENT 'Sequencia 1..N por nota; nova tentativa so com a anterior RESOLVIDA (D-NE7, barreira blocksNewAttempt, D-NE56/D-NE61)',
  `life_event`        INT(11) NOT NULL COMMENT 'Evento E da nota que abriu a VIDA = identidade da declaracao (D-NE7, molde D-N27/D-F30)',
  `environment`       CHAR(1) NOT NULL COMMENT 'H/P CONGELADO da habilitacao 55/65 no envio (D-N6/D-F120)',
  `authorizer`        VARCHAR(6) NOT NULL COMMENT 'Autorizador CONGELADO = f(UF, modelo, ambiente, tpEmis, presenca de IE); consulta, recibo e evento vao a ELE (D-NE37/D-NE96); lista = authorizers.ts (D-NE3/D-NE162, NE-3)',
  `access_key`        VARCHAR(44) NOT NULL COMMENT 'Chave de acesso NOSSA, cunhada na reserva (cUF AAMM CNPJ mod serie nNF tpEmis cNF cDV); cNF/cDV/tpEmis gravados nela (D-NE7/D-NE37)',
  `dh_emission`       DATETIME NOT NULL COMMENT 'dhEmi assinado (instante UTC, PADROES par.10.3); a data FISCAL e derivada daqui pela view, nunca espelhada no cabecalho do ERP (D-NE21)',
  `digest_value`      VARCHAR(28) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'DigestValue (SHA-1, Base64) do infNFe do candidato assinado; prova do D-NE41 contra o digVal do protNFe; Base64 distingue caixa: colacao BINARIA na coluna',
  `receipt`           VARCHAR(15) DEFAULT NULL COMMENT 'nRec do 103/105 (TRec); write-once; saida do P pela consulta do recibo (D-NE33)',
  `protocol`          VARCHAR(17) DEFAULT NULL COMMENT 'nProt do protNFe da AUTORIZACAO ou da DENEGACAO (TProt 15 ou 17, NT 2025.002 par.5.1); write-once; presenca = REGISTRO pelo fisco (D-NE56/D-NE61); o evento 110111 o exige (rej. 222)',
  `dh_recbto`         DATETIME DEFAULT NULL COMMENT 'dhRecbto do protNFe (instante UTC); write-once; inicio do prazo de cancelamento por UF (teto do rodizio, D-NE26)',
  `last_queried_at`   DATETIME DEFAULT NULL COMMENT 'Ultima consulta a ESTA chave (rodizio/656: > 10 consultas da mesma chave/h bloqueiam, D-NE26/D-NE54); NULL = nunca',
  `tb_user_id`        INT(11) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`),
  -- a chave carrega o CNPJ: é única no PAÍS, não só no estabelecimento. A UNIQUE é a guarda POR CONSTRUÇÃO da D-NE7 (cNF repetido
  -- na mesma nota/mês daria a MESMA chave a duas tentativas — a reserva falha e o cNF é sorteado de novo).
  UNIQUE KEY `uk_invoice_merchandise_transmission_key` (`access_key`),
  KEY `idx_invoice_merchandise_transmission_life` (`tb_institution_id`, `tb_invoice_id`, `terminal`, `life_event`),
  KEY `idx_invoice_merchandise_transmission_query` (`tb_institution_id`, `last_queried_at`),
  CONSTRAINT `ck_invoice_merchandise_transmission_environment`
    CHECK (`environment` COLLATE utf8mb4_bin IN ('H', 'P')),
  -- TChNFe do PL_010f (CNPJ alfanumérico — produção 01/07/2026) + mod da FAMÍLIA (55/65 = modelsOf('merchandise'); teste compara) +
  -- tpEmis 1 normal · 6 SVC-AN · 7 SVC-RS (contingência fora da F4 — D-NE6 —, o tipo já comporta). EPEC 4 / FS-DA 5 / off-line 9 (65) =
  -- migration que ESTENDE a lista. Binário: o REGEXP em colação _ci aceitaria minúscula. DV módulo 11 = camada 1 da nfe-api (D-NE43).
  CONSTRAINT `ck_invoice_merchandise_transmission_key`
    CHECK (`access_key` COLLATE utf8mb4_bin REGEXP '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'
           AND SUBSTRING(`access_key`, 21, 2) COLLATE utf8mb4_bin IN ('55', '65')
           AND SUBSTRING(`access_key`, 35, 1) COLLATE utf8mb4_bin IN ('1', '6', '7')),
  -- Lista do authorizers.ts (D-NE3/D-NE162 — nasce na NE-3 com o teste contra ESTA lista; relação de 15/10/2026 — AUTORIZADORES.md):
  -- 10 SEFAZ próprias + SVAN + SVRS + SVC-AN + SVC-RS. 'AN' fica FORA (não autoriza NF-e; só eventos do AN — fora da F4).
  -- Comprimento + lista binária (PADROES §11 regra 16 — 'PR ' em colação PAD SPACE passaria no IN).
  CONSTRAINT `ck_invoice_merchandise_transmission_authorizer`
    CHECK ((CHAR_LENGTH(`authorizer`) = 2 AND `authorizer` COLLATE utf8mb4_bin IN ('AM', 'BA', 'GO', 'MG', 'MS', 'MT', 'PE', 'PR', 'RS', 'SP'))
        OR (CHAR_LENGTH(`authorizer`) = 4 AND `authorizer` COLLATE utf8mb4_bin IN ('SVAN', 'SVRS'))
        OR (CHAR_LENGTH(`authorizer`) = 6 AND `authorizer` COLLATE utf8mb4_bin IN ('SVC-AN', 'SVC-RS'))),
  CONSTRAINT `ck_invoice_merchandise_transmission_digest`
    CHECK (`digest_value` COLLATE utf8mb4_bin REGEXP '^[A-Za-z0-9+/]{27}=$'),
  CONSTRAINT `ck_invoice_merchandise_transmission_receipt`
    CHECK (`receipt` IS NULL OR `receipt` COLLATE utf8mb4_bin REGEXP '^[0-9]{15}$'),
  CONSTRAINT `ck_invoice_merchandise_transmission_protocol`
    CHECK (`protocol` IS NULL OR `protocol` COLLATE utf8mb4_bin REGEXP '^([0-9]{15}|[0-9]{17})$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================================================================
-- 2. VOZ da SEFAZ sobre a tentativa (conceito C — append-only; estado DERIVADO da última voz, nunca coluna). kind = NOSSA leitura,
--    da LISTA DE ESCRITA da família (descritor `defineVoiceFamily` — `MERCHANDISE_VOICE_WRITE_KINDS` em `src/nfe/voice-family.ts`, a
--    MESMA constante deste CHECK; teste compara — D-F105/D-F107/D-F108):
--      A autorizada (100/150; ou pousada pela consulta da chave depois de 204 — D-NE36) · R rejeitada (só com retorno legível e cStat de
--      rejeição — D-NE34) · D denegada (110/301/302/303 — FINAL e REGISTRADA: o escritor grava `protocol` na MESMA transação — D-NE61) ·
--      P em processamento (103/105 com recibo — D-NE33; saída: consulta do recibo e, sem recibo útil, consulta da CHAVE) ·
--      C cancelada · K pedido de cancelamento em voo (fato NOSSO, dh NULL — PADROES §11 regra 9) · F falha explícita (conclusiva) ·
--      N pedido de cancelamento não vigora (liberação do K — D-N17/D-NE83).
--    S fica FORA (D-NE107): "tentativa sem voz" já é o "em voo" da família; S teria de trazer a saída junto (D-F102/D-F105).
--    VOZ DO EVENTO (D-NE39/D-NE106): o 110111 é o único evento da F4 e MUDA o estado do documento — a voz dele é o C/K/N desta tabela, com
--    a IDENTIDADE na linha: tpEvento em `authority_code` da voz C (a mesma semântica da D-F68 na NFS-e), chave pela tentativa (FK), nSeq = 1
--    (fixo para o cancelamento — MOC; CONFERENCIAS 29). O leitor confere tpEvento/chNFe/nSeqEvento do retEvento contra a pergunta antes de
--    gravar (D-NE42); decide o cStat do retEvento (135/136/155), nunca o 128; 573 = já registrado (prova). Evento que NÃO muda estado
--    (CC-e 110110, eventos RTC) é outra peça, quando entrar — agrega, não reforma.
-- =============================================================================================================================
CREATE TABLE IF NOT EXISTS `tb_invoice_merchandise_transmission_event` (
  `tb_institution_id` INT(11) NOT NULL,
  `tb_invoice_id`     INT(11) NOT NULL,
  `terminal`          INT(11) NOT NULL DEFAULT 0,
  `attempt`           INT(11) NOT NULL,
  `event`             INT(11) NOT NULL COMMENT 'Sequencia 1..N por tentativa (MAX+1 sob a trava da nota; escritor unico do nucleo, D-F108/D-NE74)',
  `kind`              CHAR(1) NOT NULL COMMENT 'A . R . D . P . C . K . F . N (lista da familia, D-F107/D-F108)',
  `authority_code`    VARCHAR(10) DEFAULT NULL COMMENT 'A/R/D/P = cStat cru (3-4 digitos, NT 2025.002 par.5.1) . C = tpEvento do cancelamento (110111), escrito uma vez (D-NE39; semantica da D-F68) . F/N = codigo da falha/recusa',
  `message`           VARCHAR(255) DEFAULT NULL COMMENT 'xMotivo (TMotivo 1-255)',
  `dh`                DATETIME DEFAULT NULL COMMENT 'Instante UTC do fisco: dhRecbto (A/R/D/P) ou dhRegEvento (C); NULL nos fatos NOSSOS K/N',
  `source`            CHAR(1) NOT NULL COMMENT 'P resposta direta . Q consulta (recibo ou chave); a SEFAZ nao chama: sem W',
  `tb_user_id`        INT(11) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`, `event`),
  UNIQUE KEY `uk_invoice_merchandise_transmission_event_dh` (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`, `kind`, `dh`),
  CONSTRAINT `fk_invoice_merchandise_transmission_event_tx` FOREIGN KEY (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`)
    REFERENCES `tb_invoice_merchandise_transmission` (`tb_institution_id`, `tb_invoice_id`, `terminal`, `attempt`),
  CONSTRAINT `ck_invoice_merchandise_transmission_event_kind`
    CHECK (`kind` COLLATE utf8mb4_bin IN ('A', 'R', 'D', 'P', 'C', 'K', 'F', 'N')),
  CONSTRAINT `ck_invoice_merchandise_transmission_event_source`
    CHECK (`source` COLLATE utf8mb4_bin IN ('P', 'Q')),
  -- a voz que DECIDE carrega o cStat que decidiu, em 3-4 dígitos (TStat do PL_010f — coluna/parser presos em 3 quebram).
  CONSTRAINT `ck_invoice_merchandise_transmission_event_status_code`
    CHECK (`kind` COLLATE utf8mb4_bin NOT IN ('A', 'R', 'D', 'P')
           OR (`authority_code` IS NOT NULL AND `authority_code` COLLATE utf8mb4_bin REGEXP '^[0-9]{3,4}$')),
  -- C nasce SEMPRE com o tipo do evento (família nova, sem a forma anterior NULL da NFS-e); comprimento + lista binária (regra 16).
  -- 110112 (cancelamento por substituição da NFC-e) entra com a F5 — migration que estende a lista. O 101101 da NFS-e NÃO é desta família.
  CONSTRAINT `ck_invoice_merchandise_transmission_event_cancel_code`
    CHECK (`kind` COLLATE utf8mb4_bin <> 'C'
           OR (`authority_code` IS NOT NULL AND CHAR_LENGTH(`authority_code`) = 6 AND `authority_code` COLLATE utf8mb4_bin IN ('110111')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================================================================
-- 3. INUTILIZAÇÃO de faixa (conceito F — ato sobre a NUMERAÇÃO do emissor, nunca sobre uma nota; não existe na NFS-e: lá o número vem
--    do servidor nacional — D-NE161). Dono = a família (D-NE8); o setes-api LÊ a view ao cunhar número (D-NE8/D-F21/D-NE110). Uma linha =
--    um pedido apresentado com UMA resposta definitiva (102 · 563 · rejeição), write-once; a ambiguidade reenvia o MESMO Id na MESMA linha
--    e o 563 traz o nProt do pedido anterior (D-NE40 — não existe consulta de inutilização). Rejeitada fica como HISTÓRIA; nova tentativa =
--    nova linha. Inutilizada = authority_code 102 ou 563. 256 (faixa sobreposta) e 201 (acima do limite) são REJEIÇÕES.
--    Chave natural da faixa (cUF, ano, CNPJ, mod, série, nNFIni, nNFFin) = o próprio Id de 43 (D-NE40): guarda-se o Id; modelo, série e
--    faixa saem DELE em colunas GERADAS (uma fonte só — a coluna gerada não é 2ª fonte: o motor a deriva, ninguém a escreve).
--    D-NE163 — RETIRADA da numeração (pendente ou inutilizada = `withdrawn`): UNIQUE `uk_invoice_number_void_range` por
--    (institution, model, serie, environment, number_from, number_to, withdrawn) — a rejeitada tem `withdrawn` NULL e não bloqueia o
--    novo pedido da mesma faixa; H e P são bases separadas da SEFAZ (o ambiente separa); a série está na chave (emenda do Valdo).
--    A PROVA (ProcInutNFe arquivado — D-NE50) é UMA por faixa retirada por ambiente: UNIQUE `uk_invoice_number_void_withdrawn`
--    (environment, withdrawn_void_id) — o grão do ARQUIVO; dentro do mesmo CNPJ ela decorre da chave da faixa (o Id ainda leva o ano).
--    id = MAX+1 por estabelecimento sob a trava da habilitação do modelo (PADROES §9 regra 7) — a corrida com a cunhagem do ERP é a D-NE110
--    (a reserva toma a trava do CONTADOR da institution no ERP como 1º comando — 2º item da lista fechada da D-F31).
-- =============================================================================================================================
CREATE TABLE IF NOT EXISTS `tb_invoice_number_void` (
  `tb_institution_id` INT(11) NOT NULL,
  `id`                INT(11) NOT NULL COMMENT 'MAX+1 por estabelecimento (PADROES par.9 regra 7)',
  `void_id`           VARCHAR(43) NOT NULL COMMENT 'Id do infInut = chave natural da faixa: ID cUF ano(2) CNPJ mod serie(3) nNFIni(9) nNFFin(9) (D-NE40)',
  `environment`       CHAR(1) NOT NULL COMMENT 'H/P CONGELADO da habilitacao no pedido (D-N6); separa as bases da SEFAZ (D-NE163)',
  `authorizer`        VARCHAR(6) NOT NULL COMMENT 'Autorizador CONGELADO; o reenvio do mesmo Id vai a ELE (D-NE37/D-NE96); AC/BA/SP sem o servico a partir de 01/11/2026 = recusa local (a conferir no Ajuste SINIEF 40/26)',
  `reason`            VARCHAR(255) NOT NULL COMMENT 'xJust 15-255 (camada 1, D-NE43); o reenvio do mesmo Id remonta o pedido IGUAL',
  `authority_code`    VARCHAR(10) DEFAULT NULL COMMENT 'cStat da resposta (102 . 563 . rejeicao); write-once; NULL = pendente (enviado ou nao, sem resposta)',
  `message`           VARCHAR(255) DEFAULT NULL COMMENT 'xMotivo; write-once com a resposta',
  `protocol`          VARCHAR(17) DEFAULT NULL COMMENT 'nProt (102, ou o do pedido anterior no 563, D-NE40); write-once',
  `dh_recbto`         DATETIME DEFAULT NULL COMMENT 'dhRecbto da resposta (instante UTC); write-once',
  `model`             CHAR(2) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS (SUBSTRING(`void_id`, 21, 2)) STORED
                        COMMENT 'GERADA do Id: modelo (55/65) da faixa; binaria para a comparacao exata do leitor (D-NE163)',
  `serie`             SMALLINT UNSIGNED GENERATED ALWAYS AS (CAST(SUBSTRING(`void_id`, 23, 3) AS UNSIGNED)) STORED
                        COMMENT 'GERADA do Id: serie da faixa (numerica, sem depender do zero a esquerda); parte da identidade (D-NE163)',
  `number_from`       INT UNSIGNED GENERATED ALWAYS AS (CAST(SUBSTRING(`void_id`, 26, 9) AS UNSIGNED)) STORED
                        COMMENT 'GERADA do Id: nNFIni',
  `number_to`         INT UNSIGNED GENERATED ALWAYS AS (CAST(SUBSTRING(`void_id`, 35, 9) AS UNSIGNED)) STORED
                        COMMENT 'GERADA do Id: nNFFin',
  `withdrawn`         CHAR(1) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin GENERATED ALWAYS AS
                        (IF(`authority_code` IS NULL OR `authority_code` COLLATE utf8mb4_bin IN ('102', '563'), 'S', NULL)) STORED
                        COMMENT 'S enquanto a faixa esta RETIRADA da numeracao (pendente ou inutilizada); NULL = rejeitada (historia). UMA regra: withdrawn_void_id deriva daqui',
  `withdrawn_void_id` VARCHAR(43) GENERATED ALWAYS AS (IF(`withdrawn` = 'S', `void_id`, NULL)) STORED
                        COMMENT 'O Id enquanto retirada (D-NE109); NULL = rejeitada. Grao da PROVA arquivada (uma por faixa retirada e ambiente, D-NE163)',
  `tb_user_id`        INT(11) DEFAULT NULL,
  `created_at`        DATETIME DEFAULT NULL,
  `updated_at`        DATETIME DEFAULT NULL,
  `deleted`           CHAR(1) NOT NULL DEFAULT 'N',
  PRIMARY KEY (`tb_institution_id`, `id`),
  UNIQUE KEY `uk_invoice_number_void_range` (`tb_institution_id`, `model`, `serie`, `environment`, `number_from`, `number_to`, `withdrawn`),
  UNIQUE KEY `uk_invoice_number_void_withdrawn` (`environment`, `withdrawn_void_id`),
  CONSTRAINT `ck_invoice_number_void_environment`
    CHECK (`environment` COLLATE utf8mb4_bin IN ('H', 'P')),
  -- 2 + 4 (cUF, ano) + 12 + 2 (CNPJ alfanumérico — TCnpj do PL_010f; Id da inutilização ID[0-9]{4}[0-9A-Z]{12}[0-9]{25} — D-NE104) +
  -- mod da família + 21 (série 3, nNFIni 9, nNFFin 9) = 43; 1 <= nNFIni <= nNFFin (TNF começa em 1). O limite de 10.000 (rej. 201) e a
  -- série 0-889 do aplicativo com CNPJ (244/503) ficam na camada 1 (D-NE43).
  CONSTRAINT `ck_invoice_number_void_id`
    CHECK (`void_id` COLLATE utf8mb4_bin REGEXP '^ID[0-9]{4}[0-9A-Z]{12}[0-9]{2}(55|65)[0-9]{21}$'
           AND CAST(SUBSTRING(`void_id`, 26, 9) AS UNSIGNED) BETWEEN 1 AND CAST(SUBSTRING(`void_id`, 35, 9) AS UNSIGNED)),
  -- a SVC não oferece inutilização (CONFERENCIAS 23) — sem SVC-AN/SVC-RS aqui
  CONSTRAINT `ck_invoice_number_void_authorizer`
    CHECK ((CHAR_LENGTH(`authorizer`) = 2 AND `authorizer` COLLATE utf8mb4_bin IN ('AM', 'BA', 'GO', 'MG', 'MS', 'MT', 'PE', 'PR', 'RS', 'SP'))
        OR (CHAR_LENGTH(`authorizer`) = 4 AND `authorizer` COLLATE utf8mb4_bin IN ('SVAN', 'SVRS'))),
  -- a resposta é cStat de 3-4 dígitos (o formato também torna EXATO o IN da coluna gerada: '102 ' não chega a ser gravado)
  CONSTRAINT `ck_invoice_number_void_status_code`
    CHECK (`authority_code` IS NULL OR `authority_code` COLLATE utf8mb4_bin REGEXP '^[0-9]{3,4}$'),
  -- protocolo só com a inutilização homologada (102) ou a prova dela (563)
  CONSTRAINT `ck_invoice_number_void_protocol`
    CHECK (`protocol` IS NULL
           OR (`protocol` COLLATE utf8mb4_bin REGEXP '^([0-9]{15}|[0-9]{17})$'
               AND `authority_code` IS NOT NULL AND `authority_code` COLLATE utf8mb4_bin IN ('102', '563')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================================================================
-- 4. VIEWS publicadas (D-F15: o setes-api lê SÓ views; GRANT em nfe-api/ops/grants.sql — só na janela da NE-6, com o 1º leitor:
--    D-NE158/D-NE161). Fundíveis: nenhuma subconsulta na LISTA, sem GROUP BY/DISTINCT/LIMIT; "última voz" no ON (PADROES §11 regra 3).
--    Coluna derivada de LITERAL leva COLLATE utf8mb4_bin (regra 3 — erro 1267 no leitor de outra colação). EXPLAIN e
--    `SET NAMES utf8mb4 COLLATE <x>` em ≥ 2 colações provados no descartável (§15.9). A família NÃO entra em VOICE_READINGS aqui
--    (D-NE158 — a nfe-api confere a PRÓPRIA view no boot passando a leitura; catálogo + superfície + GRANT na janela da NE-6).
-- =============================================================================================================================

-- 4.1 Tentativas = PROJEÇÃO COMUM (COMMON_TRANSMISSION_COLUMNS — mesmos nomes, tipos e significado da 004 da nfse-api) + o que é da
--     família e TEM leitor: só `dh_emission` (D-NE160/D-NE21 — data fiscal derivada). authorizer/receipt/protocol/dh_recbto/
--     digest_value ficam INTERNOS da nfe-api (a coluna entra na view com o 1º leitor — regra da D-IB78).
--     authority_recorded = PROTOCOLO presente (D-NE56): na NF-e a chave existe desde a reserva e NUNCA é sinal de registro. Toda voz
--     D/A/N/C/K publicada sai REGISTRADA (D-NE61/D-F136/D-F154 — o mapa comum recusa o contrário; o escritor grava o protocolo na
--     mesma transação da voz).
CREATE OR REPLACE VIEW `vw_invoice_merchandise_transmission` AS
SELECT t.`tb_institution_id`, t.`tb_invoice_id`, t.`terminal`, t.`attempt`, t.`life_event`, t.`environment`,
       t.`access_key`,
       IF(t.`protocol` IS NULL, 'N', 'S') COLLATE utf8mb4_bin AS `authority_recorded`,
       t.`dh_emission`,
       t.`last_queried_at`, t.`created_at`,
       le.`event`          AS `last_event`,
       le.`kind`           AS `last_kind`,
       le.`authority_code` AS `last_code`,
       le.`message`        AS `last_message`,
       le.`source`         AS `last_source`,
       le.`dh`             AS `last_dh`,
       le.`created_at`     AS `last_event_at`
  FROM `tb_invoice_merchandise_transmission` t
  LEFT JOIN `tb_invoice_merchandise_transmission_event` le
    ON le.`tb_institution_id` = t.`tb_institution_id` AND le.`tb_invoice_id` = t.`tb_invoice_id`
   AND le.`terminal` = t.`terminal` AND le.`attempt` = t.`attempt` AND le.`deleted` = 'N'
   AND NOT EXISTS (SELECT 1 FROM `tb_invoice_merchandise_transmission_event` x
                    WHERE x.`tb_institution_id` = le.`tb_institution_id` AND x.`tb_invoice_id` = le.`tb_invoice_id`
                      AND x.`terminal` = le.`terminal` AND x.`attempt` = le.`attempt` AND x.`deleted` = 'N'
                      AND x.`event` > le.`event`)
 WHERE t.`deleted` = 'N';

-- 4.2 (do rascunho) view de VOZES — NÃO NASCE (D-NE160): sem consumidor em família nenhuma; a tela "No fisco" lê as próprias tabelas.

-- 4.3 Faixas RETIRADAS da numeração (pendentes ou inutilizadas) — o que o setes-api lê ao cunhar número (D-NE8/D-NE110): por modelo e
--     série da NOTA (a do ERP — D-F21) e AMBIENTE (D-NE161 — faixa inutilizada em H não retira número de P). Sem `authority_recorded`
--     (D-NE161: o ERP pula pendente e homologada igual; "registro" é palavra ocupada da voz). Colunas GERADAS da tabela: nada se
--     recalcula aqui. Leitor = `fiscal-api/src/numbering/withdrawn-ranges.ts` (MAX/laço no leitor, não na view).
CREATE OR REPLACE VIEW `vw_invoice_number_void` AS
SELECT v.`tb_institution_id`, v.`id`, v.`model`, v.`serie`, v.`number_from`, v.`number_to`, v.`environment`, v.`created_at`
  FROM `tb_invoice_number_void` v
 WHERE v.`deleted` = 'N' AND v.`withdrawn` = 'S';
