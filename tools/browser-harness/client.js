import { WTerm } from '@wterm/dom';
import { GhosttyCore } from '@wterm/ghostty';
import '@wterm/dom/css';
import './style.css';

const status = document.querySelector('#status');
let socket;
let dimensions = { cols: 100, rows: 30 };
let replaying = false;
const send = (message) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};
const terminal = new WTerm(document.querySelector('#terminal'), {
  core: await GhosttyCore.load({ wasmPath: new URL('./ghostty-vt.wasm', location.href).href }),
  onData: (data) => {
    if (!replaying) send({ type: 'input', data });
  },
  onResize: (cols, rows) => {
    dimensions = { cols, rows };
    send({ type: 'resize', ...dimensions });
  },
});
await terminal.init();
document.querySelector('#focus').onclick = () => terminal.focus();
socket = new WebSocket(new URL('./pty', location.href).href.replace(/^http/, 'ws'));
socket.binaryType = 'arraybuffer';
socket.onopen = () => {
  status.textContent = 'Connected';
  send({ type: 'resize', ...dimensions });
  terminal.focus();
};
socket.onmessage = ({ data }) => {
  if (typeof data !== 'string') {
    terminal.write(new Uint8Array(data));
    return;
  }
  const event = JSON.parse(data);
  if (event.type === 'replay') replaying = event.active;
  if (event.type === 'exit') status.textContent = `Shell exited (${event.code})`;
};
socket.onclose = () => {
  status.textContent = 'Disconnected · Reload to reconnect';
};
socket.onerror = () => {
  status.textContent = 'Connection failed';
};
