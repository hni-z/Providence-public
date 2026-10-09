export function runtimeNotices(root: string): string;
export function runtimeNoticesPlugin(root: string, base?: string): {
  name: string;
  apply: "build";
  enforce: "post";
  generateBundle: { order: "post"; handler(
    this: { emitFile(asset: { type: "asset"; fileName: string; source: string }): unknown },
    options: unknown,
    bundle: Record<string, { type: string; fileName: string; source?: string | Uint8Array }>,
  ): void; };
};
