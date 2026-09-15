'use strict';

/* ══════════════════════════════════════════════════════════════════
   Bridge renderer ↔ main.
   Superficie minima: nessun oggetto Node, nessun percorso arbitrario.
   I nomi file sono decisi dal processo principale (allowlist), qui si
   passano solo stringhe già normalizzate.
   ══════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');

const str = (v) => (typeof v === 'string' ? v : String(v == null ? '' : v));

contextBridge.exposeInMainWorld('psApi', {
  info:             ()             => ipcRenderer.invoke('app:info'),
  getDataFolder:    ()             => ipcRenderer.invoke('fs:getDataFolder'),
  selectDataFolder: ()             => ipcRenderer.invoke('fs:selectDataFolder'),
  readText:         (name)         => ipcRenderer.invoke('fs:readText', str(name)),
  writeText:        (name, text)   => ipcRenderer.invoke('fs:writeText', str(name), str(text)),
  deleteFile:       (name)         => ipcRenderer.invoke('fs:deleteFile', str(name)),
  exists:           (name)         => ipcRenderer.invoke('fs:exists', str(name)),
  saveExport:       (name, base64) => ipcRenderer.invoke('app:saveExport', str(name), str(base64)),
  savePdf:          (name)         => ipcRenderer.invoke('app:savePdf', str(name)),
  unitaRimovibili:  ()             => ipcRenderer.invoke('app:unitaRimovibili'),
  safetyNet:        (lettera)      => ipcRenderer.invoke('app:safetyNet', str(lettera)),
  confermaChiusura: (esito)        => ipcRenderer.invoke('app:conferma-chiusura', str(esito)),
  // Il callback non riceve l'evento IPC: nessun oggetto di Electron nella pagina.
  onRichiestaChiusura: (fn) => {
    if (typeof fn !== 'function') return;
    ipcRenderer.removeAllListeners('app:richiesta-chiusura');
    ipcRenderer.on('app:richiesta-chiusura', () => fn());
  }
});
