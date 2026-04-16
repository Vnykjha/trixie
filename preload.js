const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_CHANNELS = ['state-change', 'transcript', 'agent-response', 'toggle-window',
                          'do-capture', 'capture-result',
                          'audio-decode', 'audio-decode-stop', 'audio-amplitude',
                          'chat-message'];

contextBridge.exposeInMainWorld('trixie', {
  send(channel, data) {
    if (ALLOWED_CHANNELS.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  on(channel, callback) {
    if (ALLOWED_CHANNELS.includes(channel)) {
      const listener = (_event, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      // Return a cleanup function
      return () => ipcRenderer.removeListener(channel, listener);
    }
  },
});
