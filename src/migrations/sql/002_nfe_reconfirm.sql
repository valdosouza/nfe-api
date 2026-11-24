-- nfe-api 002 — o FATO "o fisco não registrou esta nota" (NFE.E6.P1 — D-NE111, D-NE235; ficha-nfe-e6-p1-transmitir-consultar-reconferir.md §6-4).
--
-- Por quê: a consulta de situação que devolve 217 ("não consta na base") NÃO prova sozinha que a nota nunca foi registrada (logo depois de um
-- timeout a SEFAZ pode ainda não ter replicado — RF-NFE-76, proposta). Só a rota própria `reconfirm` (D-NE235), com o 217 e a `chNFe` iguais, sem recibo
-- 103/105 em aberto, no autorizador gravado na tentativa e se a última voz ainda é a que a pergunta viu, grava este fato na TENTATIVA.
--
-- É FATO da tentativa, NUNCA voz (a lista de escrita da voz não ganha kind — D-NE107): write-once (NULL -> instante UMA vez, pelo escritor
-- `recordNfeNotRegistered`, `... WHERE nfe_not_registered_at IS NULL`), relógio NOSSO (instante UTC — PADROES_BANCO §10.1). O nome NÃO é `not_found`
-- (convida a gravar em qualquer 404; "não consta" é a voz N). `last_queried_at` segue só como cota do rodízio/656.
-- Fica INTERNA da nfe-api: não entra em view publicada (a coluna entra na view com o 1º leitor — regra da D-IB78). Quem LIBERA nova tentativa depois deste fato é o
-- `notRegisteredProven` do núcleo (PM-8, ainda sem passo): até lá a barreira de nova tentativa continua.
--
-- RE-EXECUTÁVEL: ADD COLUMN IF NOT EXISTS (MariaDB 10.4 e 10.11, como as 002 e 003 do núcleo).
ALTER TABLE `tb_invoice_merchandise_transmission`
  ADD COLUMN IF NOT EXISTS `nfe_not_registered_at` DATETIME DEFAULT NULL COMMENT 'Instante UTC em que a rota reconfirm provou o 217 (D-NE111/D-NE235), write-once, fato da tentativa, nunca voz';
