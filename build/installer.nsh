; Colori dell'installer nei toni del tool.
; electron-builder include questo file prima di MUI2.nsh: le definizioni
; valgono per intestazione, pagina di benvenuto e pagina finale, che
; così si accostano alla barra laterale scura (installerSidebar.bmp).
!ifndef MUI_BGCOLOR
  !define MUI_BGCOLOR "180F1B"
!endif
!ifndef MUI_TEXTCOLOR
  !define MUI_TEXTCOLOR "FFFFFF"
!endif
