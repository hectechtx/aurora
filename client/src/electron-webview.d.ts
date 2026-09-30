// @types/react doesn't know about Electron's <webview> tag (it's a custom
// element Electron registers itself, only present inside an Electron
// renderer with webviewTag enabled — see electron/main.ts). This just
// teaches JSX the handful of attributes/events the Browser page actually
// uses; the full Electron.WebviewTag API is accessed via ref at runtime.
declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      src?: string;
      allowpopups?: string;
      partition?: string;
    };
  }
}
