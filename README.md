# Encontro — gestão de voluntários e equipes

Aplicativo para organizar os voluntários dos encontros da igreja: cadastro das pessoas, equipes,
distribuição de cada encontro (o **Quadrante**), histórico de quem serviu, relatórios e backup.

- HTML, CSS e JavaScript puros (módulos ES), sem build e sem dependências externas em produção.
- Dados no **IndexedDB** do navegador: nada vai para servidor nenhum.
- Funciona **sem internet** depois do primeiro acesso (service worker) e pode ser **instalado** como aplicativo.
- Única biblioteca: `vendor/jszip.min.js` (JSZip 3.10.1), guardada no projeto.

## Como abrir

O aplicativo precisa ser aberto por um endereço `https://` (ou `http://localhost`). Abrir o
`index.html` com dois cliques **não funciona**: o navegador bloqueia módulos, criptografia e uso offline em `file://`.

**Publicar (recomendado, gratuito):** envie a pasta (sem `tests/` e `tools/`, que não são usados pelo app)
para o GitHub Pages ou Netlify. Abra o endereço no celular e no computador.

**No computador, para testar:** com o Node instalado, rode na pasta do projeto

```
npm start
```

e abra `http://localhost:5520`.

## Como instalar

- **Android (Chrome):** menu ⋮ → *Instalar aplicativo*.
- **iPhone (Safari):** Compartilhar → *Adicionar à Tela de Início*.
- **Computador (Chrome/Edge):** ícone de instalar na barra de endereço.

A tela *Ajustes → Instalar aplicativo* mostra o passo a passo do aparelho em uso.

## Como passar os dados do celular para o computador

Cada aparelho (e cada navegador) tem o próprio banco. Eles **não** se sincronizam sozinhos.

1. No celular: *Backup* → marque *Proteger com senha* → *Enviar para o Drive ou outro app* → Google Drive.
2. No computador: baixe o arquivo `.zip` do Drive.
3. Abra o aplicativo no computador → *Backup* → *Escolher arquivo de backup* → digite a senha.
4. Confira o resumo (pessoas, equipes, encontros, fotos, data) e escolha:
   - **Restaurar backup**: substitui tudo deste aparelho pelo arquivo (aparelho novo ou para voltar a uma cópia);
   - **Importar dados**: junta o arquivo com o que já existe, sem apagar nada; registros diferentes seguem a sua escolha.

O backup leva pessoas, fotos, habilidades, características, equipes, coordenação, encontros,
distribuições, histórico e configurações. O PIN e o bloqueio automático ficam só no aparelho.

## Regras que o sistema garante

- A pessoa é cadastrada uma vez e reaproveitada em todos os encontros.
- Equipes são permanentes; cada encontro tem a própria composição.
- O histórico é **calculado** das participações confirmadas, nunca digitado. Duas equipes no mesmo
  encontro = 2 participações e 1 encontro servido. Encontros em planejamento não contam.
- Mesma pessoa duas vezes na mesma equipe do mesmo encontro é recusado (também por índice único no banco).
- Reabrir um encontro concluído não mexe no histórico até as correções serem confirmadas; descartar
  volta exatamente ao registrado.
- Quem tem histórico não é excluído, só arquivado. Encontros concluídos não são apagados.
- Mudar nome/cor de uma equipe não altera encontros já concluídos.
- Restauração, conclusão e correções são gravadas numa transação só: ou tudo, ou nada.

## Estrutura

```
index.html  manifest.json  sw.js
css/        style (cores e tipografia) · layout · components · responsive (celular e impressão)
js/         app (início) · router · database (IndexedDB) · schema (lojas, versões, valores iniciais)
            validation · security (PIN e criptografia) · backup · notifications (avisos, instalação, atualização)
js/modules/ dashboard · people · skills · teams · events · allocations (Quadrante) · assistant · history · reports · settings
js/components/ ui · icons · modal · toast · forms · tables · filters · navigation
assets/     fontes (Alegreya, Atkinson Hyperlegible — licença OFL) e ícones do aplicativo
vendor/     jszip.min.js
tests/      e2e.mjs (teste completo) · browser.mjs (controle do navegador)
tools/      servidor.mjs (servidor local)
```

## Testes

```
npm test
```

Abre o Edge (ou Chrome) sem janela num perfil temporário e percorre 34 etapas: lista de arquivos do
service worker, cadastros pela tela,
fotos, habilidades ilimitadas, coordenadores, distribuição, duplicidades, conclusão, histórico,
reabertura e correção, relatórios/CSV, backup com e sem senha, arquivos inválidos, senha errada,
falha no meio da restauração, falta de espaço (simulada), mesclagem, restauração em banco vazio,
PIN, uso sem internet, atualização controlada, telas de celular/tablet/computador e persistência
depois de fechar o navegador. Defina `SHOTS=<pasta>` para salvar capturas de tela.

## Publicar uma atualização

1. Altere os arquivos.
2. Em `sw.js`, troque `VERSION` (ex.: `encontro-1.0.1`) e inclua em `ASSETS` qualquer arquivo novo.
3. Publique. Quem estiver usando vê o aviso *“Há uma nova versão”* e atualiza quando quiser; se houver
   formulário aberto ou backup em andamento, o aplicativo avisa antes.

## Limitações conhecidas

- **Sem sincronização automática** entre aparelhos: a transferência é pelo arquivo de backup.
- **O PIN não criptografa o banco local.** Ele impede o uso do aplicativo por outra pessoa no aparelho;
  quem tiver acesso técnico ao navegador desbloqueado consegue ler os dados. A criptografia forte
  (AES-256-GCM, chave derivada por PBKDF2 com 600 mil iterações) está nos backups com senha.
- **Esquecer a senha do backup** torna o arquivo impossível de abrir. Não há recuperação.
- Limpar os dados do navegador ou desinstalar o aplicativo apaga os dados daquele aparelho. No iPhone,
  o Safari pode apagar dados de sites não usados por semanas; **instalar o aplicativo** e manter
  backups em dia evita perda.
- A falta de espaço foi testada por simulação (o navegador recusando a gravação), não enchendo um disco real.
