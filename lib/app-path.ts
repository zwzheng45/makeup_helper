// This public setting is embedded in the browser bundle at build time.
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

export function appPath(path: `/${string}`): string {
  return `${basePath}${path}`;
}
