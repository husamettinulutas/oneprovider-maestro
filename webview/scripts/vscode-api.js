/**
 * Bridge between the webview and the extension host.
 */
const vscodeApi = (function () {
  // @ts-ignore — acquireVsCodeApi is injected by VS Code.
  const vscode = acquireVsCodeApi();

  function postMessage(message) {
    vscode.postMessage(message);
  }

  function onMessage(handler) {
    window.addEventListener('message', (event) => handler(event.data));
  }

  /** Persist state so the panel survives being hidden and re-shown. */
  function setState(state) {
    vscode.setState(state);
  }

  function getState() {
    return vscode.getState();
  }

  return { postMessage, onMessage, setState, getState };
})();
