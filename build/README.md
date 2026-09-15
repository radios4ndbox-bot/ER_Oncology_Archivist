# Risorse di build

| file | uso |
|---|---|
| `icon.ico` | icona dell'eseguibile, del collegamento e dell'installer (16–256 px) |
| `icon.png` | stessa icona a 1024 px, sorgente per eventuali rigenerazioni |
| `installerSidebar.bmp` | barra laterale delle pagine di benvenuto e fine (164×314) |
| `uninstallerSidebar.bmp` | la stessa per la disinstallazione |
| `installerHeader.bmp` | intestazione delle pagine interne dell'installer (150×57) |

L'icona è il logo ufficiale ER OA · Desio ritagliato sul bordo del disco,
con il fondo trasparente. Le immagini dell'installer usano i colori del
tool: lo stesso radiale scuro dello splash e il filo rosso-viola.

I file `.bmp` devono restare BMP a 24 bit: NSIS non accetta altri formati.
