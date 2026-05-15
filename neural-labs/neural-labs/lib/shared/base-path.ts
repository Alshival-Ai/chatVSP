export const NEURAL_LABS_BASE_PATH =
  process.env.NEXT_PUBLIC_NEURAL_LABS_BASE_PATH?.replace(/\/+$/, "") || "";

export function withBasePath(path: string): string {
  if (!NEURAL_LABS_BASE_PATH || !path.startsWith("/")) {
    return path;
  }

  if (path === "/") {
    return NEURAL_LABS_BASE_PATH;
  }

  return `${NEURAL_LABS_BASE_PATH}${path}`;
}
