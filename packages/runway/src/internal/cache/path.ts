export const normalizedCacheTarget = (target: string): string => {
  const invalid = (): never => {
    throw new Error("invalid cache target");
  };
  const length = new TextEncoder().encode(target).byteLength;
  if (length < 1 || length > 512 || target.includes("\\")) invalid();
  for (let index = 0; index < target.length; index += 1) {
    const code = target.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) invalid();
  }
  const parts = (target.startsWith("/") ? target : `/workspace/${target}`).split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") invalid();
    normalized.push(part);
  }
  const result = `/${normalized.join("/")}`;
  if (
    !(
      (result.startsWith("/workspace/") && result !== "/workspace") ||
      (result.startsWith("/cache/") && result !== "/cache")
    ) ||
    normalized.some((part) => part === ".git" || part === ".runway")
  ) {
    invalid();
  }
  return result;
};
