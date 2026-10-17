// Embedded browser views, such as VS Code's Simple Browser, show the file pickers but refuse to read what is
// picked. They can be told apart before anything is opened: the page is framed inside another page, or the
// user agent is VS Code's Electron.
const k_embedded_agent = /\bCode\/[\d.]+.*\bElectron\//;

export function embeddedView(): boolean {
  let framed: boolean;
  try {
    framed = window.self !== window.top;
  } catch {
    // reading window.top across origins throws, which also means framed
    framed = true;
  }
  return framed || k_embedded_agent.test(navigator.userAgent);
}
