export default {
  output: "standalone",
  basePath: (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, ""),
};
