// `connect` ships no bundled types and we don't depend on @types/connect.
// We only use its factory; type the result as Vite's `Connect.Server` (the
// same connect server type the API mount is written against), so mountSammyApi
// accepts a real connect() app with no cast.
declare module 'connect' {
  import type { Connect } from 'vite';
  const createServer: () => Connect.Server;
  export default createServer;
}
