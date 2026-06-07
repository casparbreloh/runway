// Runtime stub for `@cloudflare/sandbox` under Node/vitest. The router tests never invoke a
// step body, so getSandbox throwing is fine; it documents that the sandbox isn't exercised here.
export class Sandbox {}
export const getSandbox = (): never => {
  throw new Error("getSandbox is stubbed in tests");
};
